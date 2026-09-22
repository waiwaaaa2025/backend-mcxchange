import { QueryTypes } from 'sequelize';
import sequelize from '../config/database';
import { PlatformSetting } from '../models';
import { adminNotificationService } from './adminNotificationService';
import logger from '../utils/logger';

/**
 * Daily watch over the catalogue access log.
 *
 * The admin panel answers "is anyone scraping?" when someone thinks to look.
 * This asks the question every day and speaks up only when the answer is yes,
 * so a slow scrape that nobody happens to check for still surfaces.
 */

export interface ScrapeClient {
  ipAddress: string | null;
  requests: number;
  detailViews: number;
  searches: number;
  listingsTouched: number;
  users: number;
  anonymousRequests: number;
  userAgents: string | null;
  firstSeen: Date;
  lastSeen: Date;
}

// Kept deliberately in step with the frontend panel (AdminScrapeActivityPage).
// If one moves, move the other, or the daily mail and the screen disagree.
const TOOL_UA = /curl|wget|python|scrapy|requests|httpx|go-http|java|okhttp|headless|puppeteer|playwright|bot|spider|crawler/i;
const LIMITER_PER_MIN = 120;

// Where the last completed check is recorded, and how long before another is
// due. Twenty hours rather than twenty-four so a check that runs slightly late
// one day doesn't push the next one past its window and skip a day entirely.
const LAST_RUN_KEY = 'scrape_watch_last_run_at';
const MIN_HOURS_BETWEEN_CHECKS = 20;

/** Signals that separate a bot from a customer. Three or more reads as a bot. */
export function assessClient(c: ScrapeClient): { isLikelyBot: boolean; reasons: string[] } {
  const reasons: string[] = [];

  const spanMinutes = Math.max(
    1,
    (new Date(c.lastSeen).getTime() - new Date(c.firstSeen).getTime()) / 60000
  );
  const perMinute = c.requests / spanMinutes;

  if (!c.userAgents || TOOL_UA.test(c.userAgents)) reasons.push('Tooling user agent');
  if (c.users === 0 && c.requests >= 20) reasons.push('Never signed in');
  if (c.listingsTouched >= 10) reasons.push(`Opened ${c.listingsTouched} listings`);
  if (perMinute >= LIMITER_PER_MIN * 0.5) reasons.push(`~${Math.round(perMinute)} req/min`);
  if (c.searches >= 20) reasons.push(`${c.searches} searches`);

  return { isLikelyBot: reasons.length >= 3, reasons };
}

class ScrapeWatchService {
  /** Catalogue readers over the last `hours`, busiest first. */
  async getClients(hours = 24): Promise<ScrapeClient[]> {
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const rows = await sequelize.query<ScrapeClient>(
      `SELECT
         ipAddress,
         COUNT(*)                                            AS requests,
         SUM(event = 'DETAIL')                               AS detailViews,
         SUM(event = 'SEARCH')                               AS searches,
         COUNT(DISTINCT listingId)                           AS listingsTouched,
         COUNT(DISTINCT userId)                              AS users,
         SUM(userId IS NULL)                                 AS anonymousRequests,
         SUBSTRING(GROUP_CONCAT(DISTINCT userAgent SEPARATOR ' | '), 1, 500) AS userAgents,
         MIN(createdAt)                                      AS firstSeen,
         MAX(createdAt)                                      AS lastSeen
       FROM listing_access_logs
       WHERE createdAt >= :since
       GROUP BY ipAddress
       ORDER BY requests DESC
       LIMIT 200`,
      { replacements: { since }, type: QueryTypes.SELECT }
    );

    // MySQL returns COUNT/SUM as strings; the callers do arithmetic on these.
    return rows.map((r) => ({
      ...r,
      requests: Number(r.requests),
      detailViews: Number(r.detailViews),
      searches: Number(r.searches),
      listingsTouched: Number(r.listingsTouched),
      users: Number(r.users),
      anonymousRequests: Number(r.anonymousRequests),
    }));
  }

  /**
   * Whether a day has passed since the last completed check.
   *
   * The caller fires every few hours rather than every 24, because Heroku
   * cycles dynos roughly daily and a deploy restarts them — a 24h setInterval
   * would seldom survive long enough to fire even once. The last-run mark
   * lives in the database so it outlives the process that set it, and so a
   * second dyno cannot send the same mail twice.
   */
  private async dueForCheck(): Promise<boolean> {
    try {
      const setting = await PlatformSetting.findOne({ where: { key: LAST_RUN_KEY } });
      if (!setting?.value) return true;

      const last = new Date(setting.value).getTime();
      if (Number.isNaN(last)) return true;

      return Date.now() - last >= MIN_HOURS_BETWEEN_CHECKS * 60 * 60 * 1000;
    } catch (error) {
      // A read failure shouldn't silence the watch entirely.
      logger.error('Scrape watch: could not read last-run mark', { error });
      return true;
    }
  }

  private async markChecked(): Promise<void> {
    try {
      await PlatformSetting.upsert({
        key: LAST_RUN_KEY,
        value: new Date().toISOString(),
        type: 'string',
      });
    } catch (error) {
      logger.error('Scrape watch: could not write last-run mark', { error });
    }
  }

  /**
   * Run the daily check if one is due. Mails admins only when something scores
   * as a bot — a quiet day sends nothing, so the mail keeps meaning something.
   */
  async runDailyCheck(): Promise<{ scanned: number; flagged: number; skipped?: boolean }> {
    if (!(await this.dueForCheck())) {
      return { scanned: 0, flagged: 0, skipped: true };
    }
    await this.markChecked();

    const clients = await this.getClients(24);

    const flagged = clients
      .map((client) => ({ client, ...assessClient(client) }))
      .filter((c) => c.isLikelyBot);

    if (flagged.length === 0) {
      logger.info('Daily scrape watch: nothing flagged', { clientsScanned: clients.length });
      return { scanned: clients.length, flagged: 0 };
    }

    logger.warn('Daily scrape watch flagged clients', {
      flagged: flagged.length,
      ips: flagged.map((f) => f.client.ipAddress),
    });

    await adminNotificationService.notifyScrapeActivity({
      windowHours: 24,
      totalClients: clients.length,
      clients: flagged.map(({ client, reasons }) => ({
        ipAddress: client.ipAddress || 'unknown',
        requests: client.requests,
        listingsTouched: client.listingsTouched,
        searches: client.searches,
        userAgent: client.userAgents || 'no user agent',
        reasons,
      })),
    });

    return { scanned: clients.length, flagged: flagged.length };
  }
}

export const scrapeWatchService = new ScrapeWatchService();
export default scrapeWatchService;
