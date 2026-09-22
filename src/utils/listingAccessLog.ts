import { Request } from 'express';
import { Op } from 'sequelize';
import { ListingAccessLog } from '../models';
import { clientIp } from './accessLog';
import logger from './logger';

/**
 * Records reads of the marketplace catalogue so scraping is visible after the
 * fact. Until now only LOGIN and UNLOCK were recorded, which meant a bot
 * walking every listing left no trace at all unless it tripped a rate limit.
 *
 * Deliberately fire-and-forget: this observes the request, it must never fail
 * or slow it. Writes go to listing_access_logs, not user_access_logs — see the
 * model for why mixing them would damage chargeback evidence.
 */
export type ListingAccessEvent = 'BROWSE' | 'SEARCH' | 'DETAIL';

// `detail` is a VARCHAR(255); user-supplied search terms must not overrun it.
const MAX_DETAIL = 255;

// How long catalogue reads are kept. Long enough to investigate a scrape after
// someone notices it, short enough that a busy month doesn't fill JawsDB —
// these rows arrive once per page view, far faster than anything else we store.
const RETENTION_DAYS = 90;

/** Drop catalogue reads past the retention window. Returns rows removed. */
export async function purgeOldListingAccessLogs(): Promise<number> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  return ListingAccessLog.destroy({ where: { createdAt: { [Op.lt]: cutoff } } });
}

export function recordListingAccess(
  req: Request,
  event: ListingAccessEvent,
  opts: { userId?: string | null; listingId?: string | null; detail?: string } = {}
): void {
  ListingAccessLog.create({
    userId: opts.userId ?? null,
    event,
    listingId: opts.listingId ?? null,
    ipAddress: clientIp(req),
    userAgent: req.headers['user-agent'],
    detail: opts.detail ? opts.detail.slice(0, MAX_DETAIL) : null,
  }).catch((err) => {
    logger.error('Failed to record listing access log', { event, error: err });
  });
}
