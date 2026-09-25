import { Request, Response, NextFunction } from 'express';
import { ipBlockService } from '../services/ipBlockService';
import { clientIp } from '../utils/accessLog';
import logger from '../utils/logger';

/**
 * Refuse anonymous catalogue reads from a blocked IP.
 *
 * Mount after optionalAuth. Signed-in requests pass: a block is aimed at a
 * scraper that never identifies itself, and the same address may be a shared
 * office or carrier-grade NAT with real customers behind it — they can sign in
 * and carry on, and anything they do is then attributable to an account.
 */
// Self-identified scrapers refused whatever address they come from — an IP
// block alone is dodged by moving the bot. "Highway-Domilea-Monitor/1.0" pulled
// the full catalogue hourly from 2026-09-22.
const BLOCKED_USER_AGENTS = [/highway/i];

export async function blockFlaggedIps(req: Request, res: Response, next: NextFunction) {
  if ((req as any).user) return next();

  const ip = clientIp(req);
  const userAgent = String(req.headers['user-agent'] || '');
  if (BLOCKED_USER_AGENTS.some((re) => re.test(userAgent))) {
    logger.warn('Blocked scraper user agent', { ip, userAgent: userAgent.slice(0, 200), path: req.originalUrl });
    if (ip) ipBlockService.recordHit(ip);
    return res.status(403).json({
      success: false,
      error: 'Access from your network has been restricted. Please sign in to continue.',
      code: 'IP_BLOCKED',
    });
  }

  try {
    if (ip && (await ipBlockService.isBlocked(ip))) {
      ipBlockService.recordHit(ip);
      return res.status(403).json({
        success: false,
        error: 'Access from your network has been restricted. Please sign in to continue.',
        code: 'IP_BLOCKED',
      });
    }
  } catch {
    // A block-list failure must not take the catalogue down with it.
  }
  return next();
}
