import { Request, Response, NextFunction } from 'express';
import { ipBlockService } from '../services/ipBlockService';
import { clientIp } from '../utils/accessLog';

/**
 * Refuse anonymous catalogue reads from a blocked IP.
 *
 * Mount after optionalAuth. Signed-in requests pass: a block is aimed at a
 * scraper that never identifies itself, and the same address may be a shared
 * office or carrier-grade NAT with real customers behind it — they can sign in
 * and carry on, and anything they do is then attributable to an account.
 */
export async function blockFlaggedIps(req: Request, res: Response, next: NextFunction) {
  if ((req as any).user) return next();

  const ip = clientIp(req);
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
