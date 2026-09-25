import { Request, Response, NextFunction } from 'express';
import { ipBlockService } from '../services/ipBlockService';
import { clientIp } from '../utils/accessLog';
import { UserRole } from '../models';
import logger from '../utils/logger';

// Self-identified scrapers refused whatever address they come from — an IP
// block alone is dodged by moving the bot. "Highway-Domilea-Monitor/1.0" pulled
// the full catalogue hourly from 2026-09-22.
const BLOCKED_USER_AGENTS = [/highway/i];

const REFUSED = {
  success: false,
  error: 'Access from your network has been restricted.',
  code: 'IP_BLOCKED',
};

/**
 * Refuse catalogue reads from a blocked IP or a known scraper user agent.
 *
 * Mount after optionalAuth. Signed-in users are refused too — a block means
 * nobody browses from that address. Admins are the one exception so a block
 * can never lock the team out of the site.
 */
export async function blockFlaggedIps(req: Request, res: Response, next: NextFunction) {
  if ((req as any).user?.role === UserRole.ADMIN) return next();

  const ip = clientIp(req);
  const userAgent = String(req.headers['user-agent'] || '');
  if (BLOCKED_USER_AGENTS.some((re) => re.test(userAgent))) {
    logger.warn('Blocked scraper user agent', { ip, userAgent: userAgent.slice(0, 200), path: req.originalUrl });
    if (ip) ipBlockService.recordHit(ip);
    return res.status(403).json(REFUSED);
  }

  try {
    if (ip && (await ipBlockService.isBlocked(ip))) {
      ipBlockService.recordHit(ip);
      return res.status(403).json(REFUSED);
    }
  } catch {
    // A block-list failure must not take the catalogue down with it.
  }
  return next();
}
