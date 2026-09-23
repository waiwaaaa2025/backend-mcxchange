import { Request } from 'express';
import { UserAccessLog } from '../models';
import logger from './logger';

// The real client IP. Not the first X-Forwarded-For entry: the client writes
// that one, so "X-Forwarded-For: 9.9.9.9" logged as 9.9.9.9 — enough to dodge
// an IP block or get someone else's address blocked. Heroku's router appends
// the address it actually saw, and with `trust proxy` set to 1 (src/index.ts)
// Express resolves req.ip to exactly that entry — the same value the rate
// limiters key on.
export function clientIp(req: Request): string | undefined {
  return req.ip;
}

// Record an authenticated access event with IP + user-agent. Never throws — access
// logging must not break the request it is observing.
export function recordAccess(userId: string, event: string, req: Request, detail?: string): void {
  if (!userId) return;
  UserAccessLog.create({
    userId,
    event,
    ipAddress: clientIp(req),
    userAgent: req.headers['user-agent'],
    detail,
  }).catch((err) => {
    logger.error('Failed to record access log', { userId, event, error: err });
  });
}
