/**
 * Pending-insurance lead search against FMCSA's own open data (Socrata).
 *
 * Why not LINQ: probed live 2026-09-15, LINQ's `insurance_cancels_*` search
 * returned 3 carriers for IL / 18 nationally in a 30-day window (and a 1,000-row
 * bulk sample had zero cancellation dates), while FMCSA's Motus feed had 112 IL /
 * 1,740 national for the same window. LINQ stays as the fallback upstream.
 *
 * Datasets (all refreshed daily; the older non-Motus insurance tables are frozen
 * as of 05/14/2026 and must not be used):
 * - 3uet-3z4i  Motus InsHist  — cancelled/replaced policies, with the future-dated
 *              `cancl_effective_date` that makes a carrier a lead.
 * - c5y8-a4uz  Motus Insur    — active/pending policies, used to drop carriers who
 *              already filed replacement coverage.
 * - az4n-8mr2  Company Census — state, fleet size, safety rating, phone.
 *
 * Socrata can't join datasets, so this pulls the cancellation window once, then
 * filters those DOT numbers against the census file in chunks. Dates are stored
 * as `YYYYMMDD` text, which compares and sorts correctly as a string.
 */
import {
  InsuranceLead,
  InsuranceLeadFilters,
  InsuranceLeadsResult,
} from '../types/carrierData';
import cacheService from './cacheService';
import { safetyLabel, safetyCode } from './morproLinqService';
import logger from '../utils/logger';

const SOCRATA_BASE = 'https://data.transportation.gov/resource';
const DATASET_CANCELLATIONS = '3uet-3z4i';
const DATASET_ACTIVE_POLICIES = 'c5y8-a4uz';
const DATASET_CENSUS = 'az4n-8mr2';

// Socrata allows anonymous use; an app token only raises the shared rate limit.
const APP_TOKEN = process.env.FMCSA_SOCRATA_APP_TOKEN || '';

// `dot_number in (...)` lists — 150 keeps the query string well under Socrata's limit.
const DOT_CHUNK = 150;
// Chunks run concurrently in small batches so a wide search doesn't burst the API.
const CHUNK_CONCURRENCY = 4;

interface CancellationRow {
  usdot_number?: string;
  docket_number?: string;
  cancl_effective_date?: string;
  insurance_company_name?: string;
  policy_no?: string;
}

interface CensusRow {
  dot_number?: string;
  legal_name?: string;
  dba_name?: string;
  phy_state?: string;
  power_units?: string;
  safety_rating?: string;
  status_code?: string;
  phone?: string;
}

interface ActivePolicyRow {
  usdot_number?: string;
  policy_no?: string;
}

function yyyymmdd(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function isoFromYyyymmdd(value: string): string | null {
  if (!/^\d{8}$/.test(value)) return null;
  return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
}

function daysUntil(isoDate: string): number {
  const startOfToday = new Date(new Date().toISOString().slice(0, 10)).getTime();
  return Math.round((new Date(isoDate).getTime() - startOfToday) / 86_400_000);
}

async function socrata<T>(dataset: string, params: Record<string, string>, timeoutMs = 20_000): Promise<T[] | null> {
  const query = new URLSearchParams(params).toString();
  const url = `${SOCRATA_BASE}/${dataset}.json?${query}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: APP_TOKEN ? { 'X-App-Token': APP_TOKEN } : {},
    });
    if (!res.ok) {
      logger.warn(`FMCSA Socrata ${dataset} returned ${res.status}`);
      return null;
    }
    return (await res.json()) as T[];
  } catch (error) {
    logger.warn(`FMCSA Socrata ${dataset} request failed: ${(error as Error).message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Runs `fn` over DOT chunks, a few at a time. Returns null if any chunk fails, so
// a partial result is never cached or shown as if it were the whole picture.
async function overDotChunks<T>(
  dots: string[],
  fn: (chunk: string[]) => Promise<T[] | null>
): Promise<T[] | null> {
  const chunks: string[][] = [];
  for (let i = 0; i < dots.length; i += DOT_CHUNK) chunks.push(dots.slice(i, i + DOT_CHUNK));

  const out: T[] = [];
  for (let i = 0; i < chunks.length; i += CHUNK_CONCURRENCY) {
    const batch = await Promise.all(chunks.slice(i, i + CHUNK_CONCURRENCY).map(fn));
    if (batch.some((r) => r === null)) return null;
    for (const rows of batch) out.push(...(rows as T[]));
  }
  return out;
}

function quoteList(values: string[]): string {
  return values.map((v) => `'${v.replace(/'/g, "''")}'`).join(',');
}

class FmcsaLeadsService {
  /**
   * Carriers whose BIPD insurance has a cancellation filed inside the window.
   * `cursor` is an offset into the assembled, sorted list (the whole list is
   * cached for an hour, so paging costs nothing after the first page).
   */
  async searchInsuranceLeads(
    filters: InsuranceLeadFilters,
    cursor: string | null = null,
    limit = 25
  ): Promise<InsuranceLeadsResult | null> {
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const windowDays = Math.min(Math.max(filters.expiringWithinDays ?? 30, 1), 90);
    const offset = Math.max(parseInt(cursor || '0', 10) || 0, 0);

    const state = filters.state ? filters.state.toUpperCase() : null;
    const safety = safetyCode(filters.minSafety);
    const cacheKey = `insurance_leads:fmcsa:v1:${JSON.stringify({
      windowDays,
      state,
      minUnits: filters.minUnits ?? null,
      maxUnits: filters.maxUnits ?? null,
      safety,
    })}`;

    try {
      let leads = await cacheService.get<InsuranceLead[]>(cacheKey);
      if (leads) {
        logger.info(`Insurance leads cache HIT (${cacheKey})`);
      } else {
        leads = await this.buildLeads({ windowDays, state, safety, filters });
        if (!leads) return null;
        await cacheService.set(cacheKey, leads, 3600);
      }

      const page = leads.slice(offset, offset + safeLimit);
      const nextOffset = offset + page.length;
      return {
        total: leads.length,
        limit: safeLimit,
        hasMore: nextOffset < leads.length,
        nextCursor: nextOffset < leads.length ? String(nextOffset) : null,
        results: page,
      };
    } catch (error) {
      logger.error('FMCSA insurance lead search error', error as Error, { cacheKey });
      return null;
    }
  }

  private async buildLeads({
    windowDays,
    state,
    safety,
    filters,
  }: {
    windowDays: number;
    state: string | null;
    safety: string | null;
    filters: InsuranceLeadFilters;
  }): Promise<InsuranceLead[] | null> {
    const today = new Date();
    const windowEnd = new Date(today.getTime() + windowDays * 86_400_000);

    // 1. Every BIPD cancellation filed for the window, soonest first.
    const cancellations = await socrata<CancellationRow>(DATASET_CANCELLATIONS, {
      $select: 'usdot_number, docket_number, cancl_effective_date, insurance_company_name, policy_no',
      $where: `ins_type_desc='BIPD' AND cancl_effective_date >= '${yyyymmdd(today)}' AND cancl_effective_date <= '${yyyymmdd(windowEnd)}'`,
      $order: 'cancl_effective_date ASC',
      $limit: '50000',
    });
    if (!cancellations) return null;

    // Keep the soonest cancellation per carrier (rows are already date-ordered).
    const soonest = new Map<string, CancellationRow>();
    for (const row of cancellations) {
      const dot = (row.usdot_number || '').trim();
      if (!dot || soonest.has(dot)) continue;
      soonest.set(dot, row);
    }
    if (soonest.size === 0) return [];

    // 2. Census lookup carries the state / fleet / safety filters, so filtering
    //    happens in the query rather than through a profile call per row.
    const censusWhere = [`status_code='A'`];
    if (state) censusWhere.push(`phy_state='${state.replace(/'/g, "''")}'`);
    if (filters.minUnits != null) censusWhere.push(`(power_units::number) >= ${Number(filters.minUnits)}`);
    if (filters.maxUnits != null) censusWhere.push(`(power_units::number) <= ${Number(filters.maxUnits)}`);
    if (safety) censusWhere.push(`safety_rating='${safety}'`);

    const census = await overDotChunks<CensusRow>(Array.from(soonest.keys()), (chunk) =>
      socrata<CensusRow>(DATASET_CENSUS, {
        $select: 'dot_number, legal_name, dba_name, phy_state, power_units, safety_rating, phone',
        $where: [...censusWhere, `dot_number in (${quoteList(chunk)})`].join(' AND '),
        $limit: String(DOT_CHUNK * 4),
      })
    );
    if (!census) return null;

    const carriers = new Map<string, CensusRow>();
    for (const row of census) {
      const dot = (row.dot_number || '').trim();
      if (dot) carriers.set(dot, row);
    }
    if (carriers.size === 0) return [];

    // 3. A carrier that already filed replacement coverage isn't a lead — most
    //    upcoming cancellations are insurer switches (TERM/REPL), not lapses.
    const activePolicies = await overDotChunks<ActivePolicyRow>(Array.from(carriers.keys()), (chunk) =>
      socrata<ActivePolicyRow>(DATASET_ACTIVE_POLICIES, {
        $select: 'usdot_number, policy_no',
        $where: `ins_type_code='1' AND usdot_number in (${quoteList(chunk)})`,
        $limit: String(DOT_CHUNK * 20),
      })
    );
    if (!activePolicies) return null;

    const otherActivePolicies = new Map<string, Set<string>>();
    for (const row of activePolicies) {
      const dot = (row.usdot_number || '').trim();
      if (!dot) continue;
      if (!otherActivePolicies.has(dot)) otherActivePolicies.set(dot, new Set());
      otherActivePolicies.get(dot)!.add((row.policy_no || '').trim());
    }

    const leads: InsuranceLead[] = [];
    for (const [dot, carrier] of carriers) {
      const cancellation = soonest.get(dot);
      if (!cancellation) continue;

      const cancelling = (cancellation.policy_no || '').trim();
      const replacements = otherActivePolicies.get(dot);
      const hasReplacement = !!replacements && Array.from(replacements).some((p) => p && p !== cancelling);
      if (hasReplacement) continue;

      const expiry = isoFromYyyymmdd(cancellation.cancl_effective_date || '');
      const docket = (cancellation.docket_number || '').trim();
      leads.push({
        dotNumber: dot,
        mcNumber: docket || null,
        legalName: carrier.legal_name || carrier.dba_name || `DOT ${dot}`,
        state: carrier.phy_state || null,
        powerUnits: carrier.power_units != null ? Number(carrier.power_units) : null,
        safetyRating: safetyLabel(carrier.safety_rating),
        insuranceStatus: 'pending',
        insuranceExpiryDate: expiry,
        daysUntilExpiry: expiry ? daysUntil(expiry) : null,
        pendingReason: 'CANCELLATION_SCHEDULED',
      });
    }

    leads.sort(
      (a, b) =>
        (a.daysUntilExpiry ?? Infinity) - (b.daysUntilExpiry ?? Infinity) ||
        a.dotNumber.localeCompare(b.dotNumber)
    );
    return leads;
  }
}

export const fmcsaLeadsService = new FmcsaLeadsService();
export default fmcsaLeadsService;
