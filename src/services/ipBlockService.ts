import { Op } from 'sequelize';
import { BlockedIp } from '../models';
import logger from '../utils/logger';

/**
 * IP blocks for anonymous catalogue access.
 *
 * Checked on every listing/FMCSA read, so the active set lives in memory and
 * is reloaded from the database once a minute — a block or unblock made from
 * the admin panel takes effect on the next reload at the latest (immediately
 * on this dyno, which applies its own writes straight to the cache).
 */

// Auto-blocks lapse on their own: addresses get reassigned, and a shared
// connection that tripped the heuristic once shouldn't be shut out for good.
export const AUTO_BLOCK_HOURS = 7 * 24;

// After an admin unblocks an IP, the auto-blocker leaves it alone this long.
const RESPECT_UNBLOCK_HOURS = 30 * 24;

const RELOAD_MS = 60 * 1000;
const HIT_FLUSH_MS = 60 * 1000;

class IpBlockService {
  private active = new Map<string, number | null>(); // ip → expiry ms (null = no expiry)
  private loadedAt = 0;
  private loading: Promise<void> | null = null;
  private pendingHits = new Map<string, number>();
  private flushTimer: NodeJS.Timeout | null = null;

  private async reload(): Promise<void> {
    try {
      const rows = await BlockedIp.findAll({
        where: {
          status: 'BLOCKED',
          [Op.or]: [{ expiresAt: null }, { expiresAt: { [Op.gt]: new Date() } }],
        },
        attributes: ['ipAddress', 'expiresAt'],
      });
      this.active = new Map(rows.map((r) => [r.ipAddress, r.expiresAt ? new Date(r.expiresAt).getTime() : null]));
      this.loadedAt = Date.now();
    } catch (error) {
      // Keep serving the last known set rather than failing open or closed.
      logger.error('IP block list reload failed', { error });
      this.loadedAt = Date.now();
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (Date.now() - this.loadedAt < RELOAD_MS) return;
    if (!this.loading) {
      this.loading = this.reload().finally(() => {
        this.loading = null;
      });
    }
    // Only the very first load is awaited; after that a stale set is served
    // while the refresh runs, so no request waits on the database.
    if (this.loadedAt === 0) await this.loading;
  }

  async isBlocked(ip: string | undefined): Promise<boolean> {
    if (!ip) return false;
    await this.ensureLoaded();
    if (!this.active.has(ip)) return false;
    const expiry = this.active.get(ip);
    if (expiry !== null && expiry !== undefined && expiry <= Date.now()) {
      this.active.delete(ip);
      return false;
    }
    return true;
  }

  /** Count a refused request. Batched: one UPDATE per IP per minute at most. */
  recordHit(ip: string): void {
    this.pendingHits.set(ip, (this.pendingHits.get(ip) || 0) + 1);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      const batch = this.pendingHits;
      this.pendingHits = new Map();
      for (const [ipAddress, n] of batch) {
        BlockedIp.increment('hits', { by: n, where: { ipAddress } })
          .then(() => BlockedIp.update({ lastHitAt: new Date() }, { where: { ipAddress } }))
          .catch((error) => logger.error('Failed to record blocked-IP hits', { ipAddress, error }));
      }
    }, HIT_FLUSH_MS);
  }

  async block(opts: {
    ipAddress: string;
    reason: string;
    source: 'AUTO' | 'MANUAL';
    hours?: number | null; // null/undefined for manual = until unblocked
    changedBy?: string | null;
  }): Promise<BlockedIp> {
    const expiresAt = opts.hours ? new Date(Date.now() + opts.hours * 60 * 60 * 1000) : null;
    const values = {
      status: 'BLOCKED',
      source: opts.source,
      reason: opts.reason.slice(0, 500),
      expiresAt,
      changedBy: opts.changedBy ?? null,
    };
    const existing = await BlockedIp.findOne({ where: { ipAddress: opts.ipAddress } });
    const row = existing ? await existing.update(values) : await BlockedIp.create({ ipAddress: opts.ipAddress, ...values });
    this.active.set(opts.ipAddress, expiresAt ? expiresAt.getTime() : null);
    return row;
  }

  async unblock(ipAddress: string, changedBy?: string | null): Promise<boolean> {
    const row = await BlockedIp.findOne({ where: { ipAddress } });
    this.active.delete(ipAddress);
    if (!row) return false;
    await row.update({ status: 'UNBLOCKED', changedBy: changedBy ?? null });
    return true;
  }

  /** Every row, active or not, newest change first — for the admin panel. */
  async list(): Promise<BlockedIp[]> {
    return BlockedIp.findAll({ order: [['updatedAt', 'DESC']], limit: 500 });
  }

  /**
   * Whether the auto-blocker must leave this IP alone: already blocked,
   * recently unblocked by an admin, or used by an admin account.
   */
  async autoBlockExempt(ipAddress: string, adminIps: Set<string>): Promise<string | null> {
    if (adminIps.has(ipAddress)) return 'admin account seen on this IP';
    const row = await BlockedIp.findOne({ where: { ipAddress } });
    if (!row) return null;
    if (row.status === 'BLOCKED' && (!row.expiresAt || new Date(row.expiresAt) > new Date())) return 'already blocked';
    if (
      row.status === 'UNBLOCKED' &&
      Date.now() - new Date(row.updatedAt).getTime() < RESPECT_UNBLOCK_HOURS * 60 * 60 * 1000
    ) {
      return 'unblocked by an admin';
    }
    return null;
  }
}

export const ipBlockService = new IpBlockService();
export default ipBlockService;
