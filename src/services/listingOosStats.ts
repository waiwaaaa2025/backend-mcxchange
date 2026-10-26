import { cacheService, CacheKeys, CacheTTL } from './cacheService';
import { socrata } from './fmcsaLeadsService';
import logger from '../utils/logger';

// Inspection and out-of-service counts the marketplace cards show. The stored
// fmcsaData snapshots mostly lack these, so every card rendered "0 (0.0%)".
// FMCSA's SMS results dataset (4y6x-dmck, all TEXT columns) has the 24-month
// totals per DOT; one query per page, each DOT cached for a day.
interface OosStats {
  totalInspections: number;
  driverInsp: number;
  driverOosInsp: number;
  driverOosRate: number;
  vehicleInsp: number;
  vehicleOosInsp: number;
  vehicleOosRate: number;
}

interface SmsRow {
  dot_number: string;
  insp_total: string;
  driver_insp_total: string;
  driver_oos_insp_total: string;
  vehicle_insp_total: string;
  vehicle_oos_insp_total: string;
}

const toInt = (v: string | undefined) => {
  const n = parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : 0;
};
const rate = (oos: number, insp: number) => (insp > 0 ? Math.round((oos / insp) * 1000) / 10 : 0);

function toStats(row: SmsRow): OosStats {
  const driverInsp = toInt(row.driver_insp_total);
  const driverOosInsp = toInt(row.driver_oos_insp_total);
  const vehicleInsp = toInt(row.vehicle_insp_total);
  const vehicleOosInsp = toInt(row.vehicle_oos_insp_total);
  return {
    totalInspections: toInt(row.insp_total),
    driverInsp,
    driverOosInsp,
    driverOosRate: rate(driverOosInsp, driverInsp),
    vehicleInsp,
    vehicleOosInsp,
    vehicleOosRate: rate(vehicleOosInsp, vehicleInsp),
  };
}

const cleanDot = (d: unknown) => String(d ?? '').replace(/\D/g, '');

async function getOosStatsByDot(dotNumbers: unknown[]): Promise<Map<string, OosStats>> {
  const dots = [...new Set(dotNumbers.map(cleanDot).filter(Boolean))];
  const stats = new Map<string, OosStats>();
  const missing: string[] = [];

  for (const dot of dots) {
    const cached = await cacheService.get<OosStats>(`${CacheKeys.FMCSA}oos_stats:${dot}`);
    if (cached) stats.set(dot, cached);
    else missing.push(dot);
  }

  for (let i = 0; i < missing.length; i += 100) {
    const chunk = missing.slice(i, i + 100);
    const rows = await socrata<SmsRow>('4y6x-dmck', {
      $select: 'dot_number, insp_total, driver_insp_total, driver_oos_insp_total, vehicle_insp_total, vehicle_oos_insp_total',
      $where: `dot_number in (${chunk.map((d) => `'${d}'`).join(',')})`,
      $limit: String(chunk.length * 2),
    }, 10_000);
    if (!rows) {
      logger.warn('Marketplace listings: FMCSA OOS stats unavailable');
      continue;
    }
    for (const row of rows) {
      const s = toStats(row);
      stats.set(row.dot_number, s);
      await cacheService.set(`${CacheKeys.FMCSA}oos_stats:${row.dot_number}`, s, CacheTTL.FMCSA);
    }
  }

  return stats;
}

/**
 * Merge live FMCSA inspection/OOS totals into each listing's fmcsaData so the
 * cards read real numbers. Runs before sanitizing (needs the real DOT); the
 * merged keys are all on the sanitizer's safety allowlist. Listings FMCSA
 * doesn't list keep their snapshot untouched. Returns plain objects.
 */
export async function attachOosStats(listings: any[]): Promise<any[]> {
  const plain = listings.map((l) => (l?.toJSON ? l.toJSON() : { ...l }));
  let stats: Map<string, OosStats>;
  try {
    stats = await getOosStatsByDot(plain.map((l) => l.dotNumber));
  } catch (error) {
    logger.warn(`Marketplace listings: OOS enrichment failed: ${(error as Error).message}`);
    return plain;
  }

  return plain.map((listing) => {
    const s = stats.get(cleanDot(listing.dotNumber));
    if (!s) return listing;
    let snapshot: any = {};
    if (listing.fmcsaData) {
      try {
        const raw = typeof listing.fmcsaData === 'string' ? JSON.parse(listing.fmcsaData) : listing.fmcsaData;
        snapshot = raw?.carrier ?? raw ?? {};
      } catch {
        snapshot = {};
      }
    }
    return { ...listing, fmcsaData: JSON.stringify({ ...snapshot, ...s }) };
  });
}
