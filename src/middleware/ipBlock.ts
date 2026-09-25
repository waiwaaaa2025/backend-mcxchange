import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { ipBlockService } from '../services/ipBlockService';
import { clientIp } from '../utils/accessLog';
import { User, UserRole } from '../models';
import { JWTPayload } from '../types';
import logger from '../utils/logger';

// Self-identified scrapers refused whatever address they come from — an IP
// block alone is dodged by moving the bot. "Highway-Domilea-Monitor/1.0" pulled
// the full catalogue hourly from 2026-09-22.
const BLOCKED_USER_AGENTS = [/highway/i];

// Reachable from a blocked IP so an admin there can still sign in; any other
// account that signs in gets nothing else.
const ALWAYS_ALLOWED = ['/api/health', '/api/auth/login', '/api/auth/refresh-token'];

const REFUSED = {
  success: false,
  error: 'Access from your network has been restricted.',
  code: 'IP_BLOCKED',
};

// Only called for a request that is about to be refused, so the DB lookup
// never touches normal traffic.
async function isAdminRequest(req: Request): Promise<boolean> {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return false;
  try {
    const decoded = jwt.verify(auth.slice(7), config.jwt.secret) as JWTPayload;
    const user = await User.findByPk(decoded.id, { attributes: ['role', 'status'] });
    return user?.role === UserRole.ADMIN && user.status === 'ACTIVE';
  } catch {
    return false;
  }
}

/**
 * Site-wide: refuse every request from a blocked IP or a known scraper user
 * agent, signed in or not. Admins are the one exception so a block can never
 * lock the team out. Mount before the API routes (Stripe webhooks are mounted
 * earlier and are never affected).
 */
export async function blockFlaggedIps(req: Request, res: Response, next: NextFunction) {
  if (ALWAYS_ALLOWED.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();

  const ip = clientIp(req);
  const userAgent = String(req.headers['user-agent'] || '');
  const badAgent = BLOCKED_USER_AGENTS.some((re) => re.test(userAgent));

  let blockedIp = false;
  if (!badAgent && ip) {
    try {
      blockedIp = await ipBlockService.isBlocked(ip);
    } catch {
      // A block-list failure must not take the site down with it.
    }
  }
  if (!badAgent && !blockedIp) return next();
  if (await isAdminRequest(req)) return next();

  if (badAgent) {
    logger.warn('Blocked scraper user agent', { ip, userAgent: userAgent.slice(0, 200), path: req.originalUrl });
  }
  if (ip) ipBlockService.recordHit(ip);
  return res.status(403).json(REFUSED);
}
