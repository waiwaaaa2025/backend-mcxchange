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
 * - az4n-8mr2  Company Census — state, fleet size, safety rating, docket, contact.
 *
 * Socrata can't join datasets, so this pulls the cancellation window once, then
 * filters those DOT numbers against the census file in chunks. Dates are stored
 * as `YYYYMMDD` text, which compares and sorts correctly as a string.
 *
 * What the feed can and can't tell us (measured 2026-09-17, 640 leads audited):
 * FMCSA does not publish cancellations ahead of time. Forward-dated rows are
 * ~99% TERM/REPL — an insurer swap where coverage never stops — while genuine
 * `CANCEL` notices barely appear before their effective date (~2/week ahead
 * against ~500/week behind).
 *
 * The list is deliberately only those few: a carrier whose BIPD policy is still
 * active on file with a CANCEL notice dated inside the window, and nothing else
 * to replace it — e.g. MC792423 (DOT 2318629), active SiriusPoint policy, cancels
 * 2026-09-20. Carriers already bare (no policy on file) are not shown; buyers
 * asked for the ones that can still be sold before their coverage stops.
 */
import {
  CarrierContact,
  InsuranceLead,
  InsuranceLeadFilters,
  InsuranceLeadsResult,
  InsuranceSnapshot,
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
// Renewal searches touch ~5,500 carriers for 30 days, so this also has to keep a
// cold search inside Heroku's 30-second request limit.
const CHUNK_CONCURRENCY = 8;

// Liability coverage files under 'BIPD', and under 'BIPD CANCELLATION' on a small
// number of rows; matching only the exact string silently drops those carriers.
const BIPD_TYPES = `starts_with(ins_type_desc, 'BIPD')`;

// Active BIPD filings that are actual coverage. The Insur table also carries
// BMC-35 rows — the insurer's notice of cancellation, ~6,000 of them — which read
// as a second live policy unless excluded (MC839316 was hidden that way).
const ACTIVE_BIPD = `ins_type_code='1' AND (ins_form_code IS NULL OR ins_form_code != 'BMC-35')`;

const CANCELLATION_SELECT =
  'usdot_number, docket_number, cancl_effective_date, effective_date, insurance_company_name, policy_no, filing_status_reason';

const CENSUS_SELECT =
  'dot_number, legal_name, dba_name, phy_state, power_units, safety_rating, phone, email_address, add_date, ' +
  'docket1prefix, docket1, docket1_status_code, docket2prefix, docket2, docket2_status_code, ' +
  'docket3prefix, docket3, docket3_status_code';

interface CancellationRow {
  usdot_number?: string;
  docket_number?: string;
  cancl_effective_date?: string;
  effective_date?: string;
  insurance_company_name?: string;
  policy_no?: string;
  filing_status_reason?: string;
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
  email_address?: string;
  docket1prefix?: string;
  docket1?: string;
  docket1_status_code?: string;
  docket2prefix?: string;
  docket2?: string;
  docket2_status_code?: string;
  docket3prefix?: string;
  docket3?: string;
  docket3_status_code?: string;
}

interface ActivePolicyRow {
  usdot_number?: string;
  docket_number?: string;
  policy_no?: string;
  effective_date?: string;
  trans_date?: string;
  insurance_company_name?: string;
}

const ACTIVE_SELECT = 'usdot_number, docket_number, policy_no, effective_date, trans_date, insurance_company_name';

// The two datasets punctuate the same policy differently ("02TRM069061-01" in one,
// "02TRM06906101" in the other), so compare on alphanumerics only.
function normalizePolicy(value: string | undefined): string {
  return (value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * One filing = policy number + effective date. An insurer can re-file the same
 * policy number: MC38813 (DOT 3029893) had its 2026-07-03 Crum & Forster filing
 * cancelled for 09-21 while a fresh 07-20 filing of that same policy stays active
 * with no cancellation — so matching on the policy number alone read a covered
 * carrier as about to lapse.
 */
function filingKey(policyNo: string | undefined, effectiveDate: string | undefined): string {
  return `${normalizePolicy(policyNo)}|${(effectiveDate || '').trim()}`;
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * The next anniversary (YYYYMMDD, today or later) of a filing's effective date —
 * our estimate of the policy's renewal date. FMCSA publishes no expiration date:
 * BMC-91X filings run until cancelled, and liability policies are almost always
 * annual terms that start on the filing's effective date.
 */
function nextAnniversary(effectiveStamp: string, todayStamp: string): string | null {
  if (!/^\d{8}$/.test(effectiveStamp)) return null;
  const md = effectiveStamp.slice(4);
  let year = Number(todayStamp.slice(0, 4));
  const at = (y: number) => `${y}${md === '0229' && !isLeapYear(y) ? '0228' : md}`;
  if (at(year) < todayStamp) year += 1;
  return at(year);
}

/** The carrier's current filing: the most recently effective active BIPD filing. */
function currentFiling(activeRows: ActivePolicyRow[], todayStamp: string): ActivePolicyRow | null {
  let best: ActivePolicyRow | null = null;
  for (const row of activeRows) {
    const eff = (row.effective_date || '').trim();
    if (!normalizePolicy(row.policy_no) || !/^\d{8}$/.test(eff) || eff > todayStamp) continue;
    if (!best || eff > (best.effective_date || '').trim()) best = row;
  }
  return best;
}

/**
 * Renewal date for a covered carrier, or null. Only filings at least a year old
 * count — a filing that started this year hasn't reached its first renewal.
 */
function renewalStampFor(activeRows: ActivePolicyRow[], todayStamp: string): { stamp: string; filing: ActivePolicyRow } | null {
  const filing = currentFiling(activeRows, todayStamp);
  if (!filing) return null;
  const eff = (filing.effective_date || '').trim();
  const stamp = nextAnniversary(eff, todayStamp);
  if (!stamp || stamp.slice(0, 4) <= eff.slice(0, 4)) return null;
  return { stamp, filing };
}

/** Every MMDD from today through the window end — matched against effective dates. */
function monthDaysInWindow(today: Date, windowDays: number): string[] {
  const out = new Set<string>();
  for (let i = 0; i <= windowDays; i++) {
    const md = yyyymmdd(new Date(today.getTime() + i * 86_400_000)).slice(4);
    out.add(md);
    // Feb 29 filings renew on Feb 28 in common years.
    if (md === '0228') out.add('0229');
  }
  return Array.from(out);
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

/** The dockets (MC/FF/MX) the census has for a carrier, in census order. */
function censusDockets(carrier: CensusRow): Array<{ docket: string; active: boolean }> {
  const pairs: Array<[string | undefined, string | undefined, string | undefined]> = [
    [carrier.docket1prefix, carrier.docket1, carrier.docket1_status_code],
    [carrier.docket2prefix, carrier.docket2, carrier.docket2_status_code],
    [carrier.docket3prefix, carrier.docket3, carrier.docket3_status_code],
  ];
  const out: Array<{ docket: string; active: boolean }> = [];
  const seen = new Set<string>();
  for (const [prefix, number, status] of pairs) {
    const docket = `${(prefix || '').trim()}${(number || '').trim()}`;
    if (!docket || seen.has(docket)) continue;
    seen.add(docket);
    out.push({ docket, active: (status || '').trim().toUpperCase() === 'A' });
  }
  return out;
}

/**
 * The docket to show. The insurance filing carries its own docket number, which is
 * sometimes one the carrier no longer holds — DOT 4529207 files under MC1795679
 * while FMCSA lists it as FF70797 — so the filing's docket is only used when the
 * census confirms it; otherwise the carrier's own (preferably active) docket wins.
 */
function displayDocket(carrier: CensusRow, filingDocket: string): string | null {
  const dockets = censusDockets(carrier);
  const filing = filingDocket.trim().toUpperCase();
  if (filing && dockets.some((d) => d.docket.toUpperCase() === filing)) return filing;
  const preferred = dockets.find((d) => d.active) || dockets[0];
  return preferred ? preferred.docket : filing || null;
}

export function formatPhone(value: string | undefined): string | null {
  const digits = (value || '').replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith('1')) return formatPhone(digits.slice(1));
  return digits ? digits : null;
}

/** Accepts YYYY-MM-DD or YYYYMMDD; returns the YYYYMMDD Socrata stores. */
function toStamp(value: string | undefined): string | null {
  const digits = (value || '').replace(/-/g, '').trim();
  return /^\d{8}$/.test(digits) ? digits : null;
}

/**
 * The cancellation a carrier should be judged on: the soonest one still ahead of
 * them, or failing that the most recent one already in effect. A carrier can carry
 * both — an old cancellation they replaced and a fresh one pending — and judging
 * them on the stale row would test live coverage as though it had already lapsed.
 */
function governingCancellation(rows: CancellationRow[], todayStamp: string): CancellationRow | null {
  let best: CancellationRow | null = null;
  for (const row of rows) {
    const stamp = (row.cancl_effective_date || '').trim();
    if (!stamp) continue;
    if (!best) {
      best = row;
      continue;
    }
    const bestStamp = (best.cancl_effective_date || '').trim();
    const rowUpcoming = stamp >= todayStamp;
    const bestUpcoming = bestStamp >= todayStamp;
    if (rowUpcoming !== bestUpcoming) {
      if (rowUpcoming) best = row;
    } else if (rowUpcoming ? stamp < bestStamp : stamp > bestStamp) {
      best = row;
    }
  }
  return best;
}

/**
 * Whether this cancellation actually leaves the carrier bare. The same test backs
 * the Insurance Leads list and the insurance column in Leads / Lead Generator, so
 * one carrier can never read as lapsed in one tool and covered in another.
 */
function verdict(
  cancellation: CancellationRow,
  activeRows: ActivePolicyRow[],
  todayStamp: string
): InsuranceSnapshot['status'] {
  const cancelStamp = (cancellation.cancl_effective_date || '').trim();
  if (!cancelStamp) return 'COVERED';

  const cancellingFiling = filingKey(cancellation.policy_no, cancellation.effective_date);
  const hasAnyPolicy = activeRows.some((policy) => normalizePolicy(policy.policy_no));
  // Any other live filing covers them — a different policy, or a newer filing of
  // the same policy number.
  const hasOtherPolicy = activeRows.some(
    (policy) =>
      !!normalizePolicy(policy.policy_no) &&
      filingKey(policy.policy_no, policy.effective_date) !== cancellingFiling
  );
  const reason = (cancellation.filing_status_reason || '').trim().toUpperCase();

  if (cancelStamp < todayStamp) {
    // Cancellation already took effect: bare only while nothing replaced it.
    return hasAnyPolicy ? 'COVERED' : 'COVERAGE_LAPSED';
  }
  if (reason === 'CANCEL') {
    // A live notice of cancellation. The cancelled filing stays on file until the
    // date passes, so only a *different* active filing means they're covered.
    return hasOtherPolicy ? 'COVERED' : 'CANCELLATION_SCHEDULED';
  }
  // TERM/REPL and friends mean the filing was replaced, not that coverage stops.
  return hasAnyPolicy ? 'COVERED' : 'CANCELLATION_SCHEDULED';
}

export async function socrata<T>(dataset: string, params: Record<string, string>, timeoutMs = 20_000): Promise<T[] | null> {
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
    // Bump the version whenever the lead rules change so cached lists from the
    // previous rules aren't served for up to an hour after a deploy.
    const leadType = filters.leadType === 'cancellation' || filters.leadType === 'renewal' ? filters.leadType : 'all';
    const cacheKey = `insurance_leads:fmcsa:v11:${JSON.stringify({
      leadType,
      windowDays,
      state,
      minUnits: filters.minUnits ?? null,
      maxUnits: filters.maxUnits ?? null,
      safety,
      name: filters.nameContains ?? null,
      addedAfter: toStamp(filters.addedAfter),
      addedBefore: toStamp(filters.addedBefore),
    })}`;

    try {
      let leads = await cacheService.get<InsuranceLead[]>(cacheKey);
      if (leads) {
        logger.info(`Insurance leads cache HIT (${cacheKey})`);
      } else {
        leads = await this.buildLeads({ leadType, windowDays, state, safety, filters });
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
    leadType,
    windowDays,
    state,
    safety,
    filters,
  }: {
    leadType: 'all' | 'cancellation' | 'renewal';
    windowDays: number;
    state: string | null;
    safety: string | null;
    filters: InsuranceLeadFilters;
  }): Promise<InsuranceLead[] | null> {
    const today = new Date();
    const todayStamp = yyyymmdd(today);
    const windowEndStamp = yyyymmdd(new Date(today.getTime() + windowDays * 86_400_000));

    const wantCancellations = leadType !== 'renewal';
    const wantRenewals = leadType !== 'cancellation';

    // 1a. Every BIPD cancellation notice dated from today to the end of the window.
    //     This only nominates candidates; which cancellation governs is settled in
    //     step 3, against the carrier's whole history rather than this slice.
    // 1b. Every active BIPD filing whose anniversary falls inside the window — the
    //     carriers coming up for renewal. Also only nominees; step 5 checks that the
    //     filing is still the carrier's current one.
    const [cancelRows, renewalRows] = await Promise.all([
      wantCancellations
        ? socrata<CancellationRow>(DATASET_CANCELLATIONS, {
            $select: 'usdot_number',
            $where: `${BIPD_TYPES} AND filing_status_reason='CANCEL' AND cancl_effective_date >= '${todayStamp}' AND cancl_effective_date <= '${windowEndStamp}'`,
            $limit: '50000',
          })
        : Promise.resolve([] as CancellationRow[]),
      wantRenewals
        ? socrata<ActivePolicyRow>(DATASET_ACTIVE_POLICIES, {
            $select: 'usdot_number',
            $where: `${ACTIVE_BIPD} AND effective_date < '${todayStamp}' AND (${monthDaysInWindow(today, windowDays)
              .map((md) => `effective_date like '____${md}'`)
              .join(' OR ')})`,
            $limit: '200000',
          }, 60_000)
        : Promise.resolve([] as ActivePolicyRow[]),
    ]);
    if (!cancelRows || !renewalRows) return null;

    const cancelDots = new Set(cancelRows.map((row) => (row.usdot_number || '').trim()).filter(Boolean));
    const candidateDots = Array.from(
      new Set([...cancelDots, ...renewalRows.map((row) => (row.usdot_number || '').trim()).filter(Boolean)])
    );
    if (candidateDots.length === 0) return [];

    // 2. Census lookup carries the state / fleet / safety filters, so filtering
    //    happens in the query rather than through a profile call per row.
    const censusWhere = [`status_code='A'`];
    if (state) censusWhere.push(`phy_state='${state.replace(/'/g, "''")}'`);
    if (filters.minUnits != null) censusWhere.push(`(power_units::number) >= ${Number(filters.minUnits)}`);
    if (filters.maxUnits != null) censusWhere.push(`(power_units::number) <= ${Number(filters.maxUnits)}`);
    if (safety) censusWhere.push(`safety_rating='${safety}'`);
    // The census carries the same prospecting fields the Leads tools filter on, so
    // an insurance search there keeps every other filter the user set.
    if (filters.nameContains) {
      const needle = filters.nameContains.toUpperCase().replace(/'/g, "''");
      censusWhere.push(`(upper(legal_name) like '%${needle}%' OR upper(dba_name) like '%${needle}%')`);
    }
    const addedAfter = toStamp(filters.addedAfter);
    const addedBefore = toStamp(filters.addedBefore);
    if (addedAfter) censusWhere.push(`add_date >= '${addedAfter}'`);
    if (addedBefore) censusWhere.push(`add_date <= '${addedBefore}'`);

    const census = await overDotChunks<CensusRow>(candidateDots, (chunk) =>
      socrata<CensusRow>(DATASET_CENSUS, {
        $select: CENSUS_SELECT,
        $where: [...censusWhere, `dot_number in (${quoteList(chunk)})`].join(' AND '),
        $limit: String(DOT_CHUNK * 4),
      })
    );
    if (!census) return null;

    const carriers = new Map<string, CensusRow>();
    for (const row of census) {
      const dot = (row.dot_number || '').trim();
      if (!dot) continue;
      // A carrier whose every operating authority is inactive can't be sold a policy
      // to keep running — they have nothing left to insure.
      const dockets = censusDockets(row);
      if (dockets.length > 0 && !dockets.some((d) => d.active)) continue;
      carriers.set(dot, row);
    }
    if (carriers.size === 0) return [];

    // 3. The carrier's full cancellation history, not just the window: a carrier with
    //    a cancellation past the window edge would otherwise be judged on an older,
    //    already-replaced one and reported as lapsed while still insured.
    //    Only the carriers nominated by a cancellation need it.
    const history = await overDotChunks<CancellationRow>(Array.from(carriers.keys()).filter((d) => cancelDots.has(d)), (chunk) =>
      socrata<CancellationRow>(DATASET_CANCELLATIONS, {
        $select: CANCELLATION_SELECT,
        $where: `${BIPD_TYPES} AND usdot_number in (${quoteList(chunk)})`,
        $limit: '50000',
      })
    );
    if (!history) return null;

    const historyByDot = new Map<string, CancellationRow[]>();
    for (const row of history) {
      const dot = (row.usdot_number || '').trim();
      if (!dot) continue;
      if (!historyByDot.has(dot)) historyByDot.set(dot, []);
      historyByDot.get(dot)!.push(row);
    }

    // 4. What the carrier has on file right now.
    const activePolicies = await overDotChunks<ActivePolicyRow>(Array.from(carriers.keys()), (chunk) =>
      socrata<ActivePolicyRow>(DATASET_ACTIVE_POLICIES, {
        $select: ACTIVE_SELECT,
        $where: `${ACTIVE_BIPD} AND usdot_number in (${quoteList(chunk)})`,
        $limit: String(DOT_CHUNK * 20),
      })
    );
    if (!activePolicies) return null;

    const activeByDot = new Map<string, ActivePolicyRow[]>();
    for (const row of activePolicies) {
      const dot = (row.usdot_number || '').trim();
      if (!dot) continue;
      if (!activeByDot.has(dot)) activeByDot.set(dot, []);
      activeByDot.get(dot)!.push(row);
    }

    const leads: InsuranceLead[] = [];
    for (const [dot, carrier] of carriers) {
      const cancellation = governingCancellation(historyByDot.get(dot) || [], todayStamp);
      if (!cancellation) continue;

      const cancelStamp = (cancellation.cancl_effective_date || '').trim();
      // Their live cancellation may sit outside the window the buyer asked about.
      if (cancelStamp < todayStamp || cancelStamp > windowEndStamp) continue;
      if ((cancellation.filing_status_reason || '').trim().toUpperCase() !== 'CANCEL') continue;

      // The filing being cancelled must still be the one active on file: a carrier
      // with no insurance on file is already bare, not pending.
      const active = activeByDot.get(dot) || [];
      const cancellingFiling = filingKey(cancellation.policy_no, cancellation.effective_date);
      if (
        !normalizePolicy(cancellation.policy_no) ||
        !active.some((p) => filingKey(p.policy_no, p.effective_date) === cancellingFiling)
      ) continue;

      const status = verdict(cancellation, active, todayStamp);
      if (status !== 'CANCELLATION_SCHEDULED') continue;

      const expiry = isoFromYyyymmdd(cancelStamp);
      leads.push({
        dotNumber: dot,
        mcNumber: displayDocket(carrier, (cancellation.docket_number || '').trim()),
        legalName: carrier.legal_name || carrier.dba_name || `DOT ${dot}`,
        state: carrier.phy_state || null,
        powerUnits: carrier.power_units != null ? Number(carrier.power_units) : null,
        safetyRating: safetyLabel(carrier.safety_rating),
        phone: formatPhone(carrier.phone),
        email: (carrier.email_address || '').trim() || null,
        insuranceStatus: 'pending',
        insuranceExpiryDate: expiry,
        daysUntilExpiry: expiry ? daysUntil(expiry) : null,
        pendingReason: status,
        insuranceCompany: (cancellation.insurance_company_name || '').trim() || null,
        policyEffectiveDate: isoFromYyyymmdd((cancellation.effective_date || '').trim()),
      });
    }

    // 5. Renewals: covered carriers whose current filing turns a year older inside
    //    the window. A carrier already listed for a cancellation isn't repeated.
    if (wantRenewals) {
      const listed = new Set(leads.map((l) => l.dotNumber));
      for (const [dot, carrier] of carriers) {
        if (listed.has(dot)) continue;
        const renewal = renewalStampFor(activeByDot.get(dot) || [], todayStamp);
        if (!renewal || renewal.stamp > windowEndStamp) continue;

        const expiry = isoFromYyyymmdd(renewal.stamp);
        leads.push({
          dotNumber: dot,
          mcNumber: displayDocket(carrier, (renewal.filing.docket_number || '').trim()),
          legalName: carrier.legal_name || carrier.dba_name || `DOT ${dot}`,
          state: carrier.phy_state || null,
          powerUnits: carrier.power_units != null ? Number(carrier.power_units) : null,
          safetyRating: safetyLabel(carrier.safety_rating),
          phone: formatPhone(carrier.phone),
          email: (carrier.email_address || '').trim() || null,
          insuranceStatus: 'expiring',
          insuranceExpiryDate: expiry,
          daysUntilExpiry: expiry ? daysUntil(expiry) : null,
          pendingReason: 'RENEWAL_DUE',
          insuranceCompany: (renewal.filing.insurance_company_name || '').trim() || null,
          policyEffectiveDate: isoFromYyyymmdd((renewal.filing.effective_date || '').trim()),
        });
      }
    }

    // Pending cancellations first — coverage actually stops — then renewals; each
    // soonest first.
    leads.sort(
      (a, b) =>
        Number(a.pendingReason === 'RENEWAL_DUE') - Number(b.pendingReason === 'RENEWAL_DUE') ||
        (a.daysUntilExpiry ?? Infinity) - (b.daysUntilExpiry ?? Infinity) ||
        a.dotNumber.localeCompare(b.dotNumber)
    );
    return leads;
  }

  /**
   * The live insurance verdict for an arbitrary set of carriers, for tools that
   * search on something other than insurance (Leads, Lead Generator) but still
   * show an insurance column. Two Socrata calls per chunk of 150 DOTs — never one
   * per row — and the answer matches the Insurance Leads list exactly.
   * Returns null if FMCSA can't be reached, so callers can show nothing rather
   * than an invented "covered".
   */
  async insuranceStatusFor(dots: string[]): Promise<Map<string, InsuranceSnapshot> | null> {
    const wanted = Array.from(new Set(dots.map((d) => String(d).trim()).filter(Boolean)));
    if (wanted.length === 0) return new Map();

    const cacheKey = `insurance_snapshot:v5:${wanted.slice().sort().join(',')}`;
    try {
      const cached = await cacheService.get<Array<[string, InsuranceSnapshot]>>(cacheKey);
      if (cached) return new Map(cached);
    } catch {
      // cache is best-effort
    }

    const todayStamp = yyyymmdd(new Date());

    const history = await overDotChunks<CancellationRow>(wanted, (chunk) =>
      socrata<CancellationRow>(DATASET_CANCELLATIONS, {
        $select: CANCELLATION_SELECT,
        $where: `${BIPD_TYPES} AND usdot_number in (${quoteList(chunk)})`,
        $limit: '50000',
      })
    );
    if (!history) return null;

    const activePolicies = await overDotChunks<ActivePolicyRow>(wanted, (chunk) =>
      socrata<ActivePolicyRow>(DATASET_ACTIVE_POLICIES, {
        $select: ACTIVE_SELECT,
        $where: `${ACTIVE_BIPD} AND usdot_number in (${quoteList(chunk)})`,
        $limit: String(DOT_CHUNK * 20),
      })
    );
    if (!activePolicies) return null;

    const historyByDot = new Map<string, CancellationRow[]>();
    for (const row of history) {
      const dot = (row.usdot_number || '').trim();
      if (!dot) continue;
      if (!historyByDot.has(dot)) historyByDot.set(dot, []);
      historyByDot.get(dot)!.push(row);
    }
    const activeByDot = new Map<string, ActivePolicyRow[]>();
    for (const row of activePolicies) {
      const dot = (row.usdot_number || '').trim();
      if (!dot) continue;
      if (!activeByDot.has(dot)) activeByDot.set(dot, []);
      activeByDot.get(dot)!.push(row);
    }

    // Covered carriers also get their estimated renewal date, so a renewal lead
    // reads the same in the Leads / Lead Generator insurance column.
    const renewalFor = (dot: string) => {
      const renewal = renewalStampFor(activeByDot.get(dot) || [], todayStamp);
      return {
        renewalDate: renewal ? isoFromYyyymmdd(renewal.stamp) : null,
        renewalCompany: renewal ? (renewal.filing.insurance_company_name || '').trim() || null : null,
      };
    };

    const out = new Map<string, InsuranceSnapshot>();
    for (const dot of wanted) {
      const cancellation = governingCancellation(historyByDot.get(dot) || [], todayStamp);
      if (!cancellation) {
        out.set(dot, { status: 'COVERED', cancellationDate: null, daysUntilCancellation: null, insuranceCompany: null, ...renewalFor(dot) });
        continue;
      }
      const status = verdict(cancellation, activeByDot.get(dot) || [], todayStamp);
      const iso = isoFromYyyymmdd((cancellation.cancl_effective_date || '').trim());
      out.set(dot, {
        status,
        // A date only means something when the cancellation actually bites; an
        // insurer swap on a covered carrier would read as a warning it isn't.
        cancellationDate: status === 'COVERED' ? null : iso,
        daysUntilCancellation: status === 'COVERED' || !iso ? null : daysUntil(iso),
        insuranceCompany: status === 'COVERED' ? null : (cancellation.insurance_company_name || '').trim() || null,
        ...(status === 'COVERED' ? renewalFor(dot) : { renewalDate: null, renewalCompany: null }),
      });
    }

    try {
      await cacheService.set(cacheKey, Array.from(out.entries()), 3600);
    } catch {
      // cache is best-effort
    }
    return out;
  }

  /**
   * Public FMCSA census phone/email for a set of carriers — one query per chunk of
   * 150. Used to fill in contact details the carrier-data provider doesn't have.
   */
  async contactsFor(dots: string[]): Promise<Map<string, CarrierContact>> {
    const wanted = Array.from(new Set(dots.map((d) => String(d).trim()).filter(Boolean)));
    const out = new Map<string, CarrierContact>();
    if (wanted.length === 0) return out;

    const rows = await overDotChunks<CensusRow>(wanted, (chunk) =>
      socrata<CensusRow>(DATASET_CENSUS, {
        $select: 'dot_number, phone, email_address',
        $where: `dot_number in (${quoteList(chunk)})`,
        $limit: String(DOT_CHUNK * 4),
      })
    );
    if (!rows) return out;

    for (const row of rows) {
      const dot = (row.dot_number || '').trim();
      if (!dot) continue;
      out.set(dot, {
        phone: formatPhone(row.phone),
        email: (row.email_address || '').trim() || null,
      });
    }
    return out;
  }
}

export const fmcsaLeadsService = new FmcsaLeadsService();
export default fmcsaLeadsService;
