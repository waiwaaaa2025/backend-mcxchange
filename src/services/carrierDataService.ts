import { config } from '../config';
import {
  MorProCarrierReport,
  InsuranceLead,
  InsuranceLeadFilters,
  InsuranceLeadsResult,
} from '../types/carrierData';
import cacheService from './cacheService';
import morproLinqService, { safetyLabel, type LinqSearchFilters } from './morproLinqService';
import fmcsaLeadsService from './fmcsaLeadsService';
import { normalizeLinqReport } from './linqReportNormalizer';
import logger from '../utils/logger';
import { AppError, TooManyRequestsError } from '../middleware/errorHandler';

// A carrier-data provider. Both upstreams expose the same /carriers/:dot/*
// endpoint family (including a bundled /report that returns every section in
// one call); they differ only in base URL, path prefix, and auth header.
interface CarrierUpstream {
  name: string;
  baseUrl: string;
  prefix: string;
  headers(): Record<string, string>;
}

// Legacy MorPro box — holds the marketplace carrier dataset, no /api/v1 prefix,
// authenticated with X-API-Key. No per-month quota.
const legacyUpstream: CarrierUpstream = {
  name: 'legacy',
  baseUrl: config.morproCarrier.baseUrl,
  // The legacy box serves carriers under /api/carriers/:dot (no version segment);
  // MORPRO_CARRIER_API_URL is just the host, so the prefix supplies /api.
  prefix: '/api',
  headers(): Record<string, string> {
    const key = config.morproCarrier.apiKey;
    return key ? { 'X-API-Key': key } : {};
  },
};

function isoDateOffset(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

// Whole days from today (UTC) to a YYYY-MM-DD date; negative once it has passed.
function daysUntil(isoDate: string): number {
  const today = Date.parse(isoDateOffset(0));
  return Math.round((Date.parse(isoDate.slice(0, 10)) - today) / 86_400_000);
}

// MorPro LINQ (Manifest) — same endpoints under an /api/v1 prefix, authenticated
// with X-Manifest-Key. Subject to a monthly call quota.
const linqUpstream: CarrierUpstream = {
  name: 'linq',
  baseUrl: config.morproLinq.baseUrl,
  prefix: '/api/v1',
  headers(): Record<string, string> {
    const key = config.morproLinq.apiKey;
    return key ? { 'X-Manifest-Key': key } : {};
  },
};

function fetchWithTimeout(
  url: string,
  headers: Record<string, string> = {},
  timeoutMs = 15000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { headers, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Best-effort extraction of the upstream's error code/message for logging.
async function readUpstreamCode(res: Response): Promise<string | undefined> {
  try {
    const body: any = await res.clone().json();
    return body?.code || body?.message;
  } catch {
    return undefined;
  }
}

// LINQ answers an unknown DOT with HTTP 200 + `{"error":"Carrier not found"}`
// rather than a 404, so a successful status alone doesn't mean carrier data.
function isErrorBody(body: any): boolean {
  return (
    !!body &&
    typeof body === 'object' &&
    !Array.isArray(body) &&
    typeof body.error === 'string' &&
    body.dot_number == null &&
    body.legal_name == null
  );
}

type ReportFetch =
  | { kind: 'ok'; report: MorProCarrierReport }
  | { kind: 'notFound' }
  | { kind: 'error'; status: number };

// Report sections fetched alongside the base carrier profile. Each is an
// independent /carriers/:dot/<section> endpoint.
const REPORT_SECTIONS = [
  'authority',
  'safety',
  'inspections',
  'violations',
  'crashes',
  'insurance',
  'fleet',
  'cargo',
  'documents',
  'related',
  'percentiles',
] as const;

// Section endpoints are non-critical enrichment and are capped with a short
// timeout: on LINQ, `related` (~10s) and `percentiles` (~17s) are far slower
// than the rest (~1s), so without a cap they would stall the whole report.
// Anything exceeding this degrades to null rather than blocking the response.
const SECTION_TIMEOUT_MS = 3000;

class CarrierDataService {
  /**
   * Fetch a full report from one upstream by calling the base carrier endpoint
   * plus every section endpoint in PARALLEL. This is deliberately a fan-out,
   * not the bundled /report endpoint: on LINQ, /report takes 16-23s (it times
   * out), while the individual endpoints each return in ~0.5s, so the parallel
   * fan-out is both faster and more reliable.
   *
   * The base carrier response drives the outcome — a 404 there means the
   * carrier genuinely does not exist; a 429/401/5xx/timeout is an upstream
   * failure the caller can fail over on. Section endpoints degrade to null on
   * failure (non-critical enrichment).
   */
  private async fetchReport(
    up: CarrierUpstream,
    dotNumber: string,
    timeoutMs: number
  ): Promise<ReportFetch> {
    const headers = up.headers();
    const baseUrl = `${up.baseUrl}${up.prefix}/carriers/${dotNumber}`;

    let baseRes: Response;
    try {
      baseRes = await fetchWithTimeout(baseUrl, headers, timeoutMs);
    } catch {
      logger.warn(`Carrier upstream '${up.name}' unreachable for DOT ${dotNumber}`);
      return { kind: 'error', status: 503 };
    }

    if (baseRes.status === 404) return { kind: 'notFound' };
    if (!baseRes.ok) {
      const code = await readUpstreamCode(baseRes);
      logger.warn(
        `Carrier upstream '${up.name}' ${baseRes.status} for DOT ${dotNumber}${code ? ` (${code})` : ''}`
      );
      return { kind: 'error', status: baseRes.status };
    }

    const carrier: any = await baseRes.json().catch(() => null);
    if (!carrier || isErrorBody(carrier)) return { kind: 'notFound' };

    // Base carrier exists — fetch the rest in parallel, each capped by a short
    // timeout and failing to null so slow enrichment endpoints can't stall it.
    const sections = await Promise.all(
      REPORT_SECTIONS.map((ep) =>
        this.fetchSection(baseUrl, headers, ep, Math.min(timeoutMs, SECTION_TIMEOUT_MS))
      )
    );
    const [
      authority,
      safety,
      inspections,
      violations,
      crashes,
      insurance,
      fleet,
      cargo,
      documents,
      related,
      percentiles,
    ] = sections;

    return {
      kind: 'ok',
      report: {
        carrier,
        authority,
        safety,
        inspections,
        violations,
        crashes,
        insurance,
        fleet,
        cargo,
        documents,
        related,
        percentiles,
        monitoring: null,
        compliance: null,
      },
    };
  }

  // Fetch a single section endpoint; return null on any failure (graceful).
  private async fetchSection(
    baseUrl: string,
    headers: Record<string, string>,
    endpoint: string,
    timeoutMs: number
  ): Promise<any> {
    try {
      const res = await fetchWithTimeout(`${baseUrl}/${endpoint}`, headers, timeoutMs);
      if (!res.ok) return null;
      const body = await res.json();
      return isErrorBody(body) ? null : body;
    } catch {
      return null;
    }
  }

  /**
   * Fetch a full report from one upstream via its bundled /report endpoint —
   * ONE call that returns every section. Used for the legacy box, whose /report
   * returns the complete report in ~1s. Same outcome semantics as fetchReport
   * (404 → notFound; 429/401/5xx/timeout → error the caller fails over on).
   */
  private async fetchBundledReport(
    up: CarrierUpstream,
    dotNumber: string,
    timeoutMs: number
  ): Promise<ReportFetch> {
    const url = `${up.baseUrl}${up.prefix}/carriers/${dotNumber}/report`;

    let res: Response;
    try {
      res = await fetchWithTimeout(url, up.headers(), timeoutMs);
    } catch {
      logger.warn(`Carrier upstream '${up.name}' unreachable for DOT ${dotNumber}`);
      return { kind: 'error', status: 503 };
    }

    if (res.status === 404) return { kind: 'notFound' };
    if (!res.ok) {
      const code = await readUpstreamCode(res);
      logger.warn(
        `Carrier upstream '${up.name}' ${res.status} for DOT ${dotNumber}${code ? ` (${code})` : ''}`
      );
      return { kind: 'error', status: res.status };
    }

    const raw: any = await res.json().catch(() => null);
    if (!raw || !raw.carrier || isErrorBody(raw) || isErrorBody(raw.carrier)) return { kind: 'notFound' };

    return {
      kind: 'ok',
      report: {
        carrier: raw.carrier ?? null,
        authority: raw.authority ?? null,
        safety: raw.safety ?? null,
        inspections: raw.inspections ?? null,
        violations: raw.violations ?? null,
        crashes: raw.crashes ?? null,
        insurance: raw.insurance ?? null,
        fleet: raw.fleet ?? null,
        cargo: raw.cargo ?? null,
        documents: raw.documents ?? null,
        related: raw.related ?? null,
        percentiles: raw.percentiles ?? null,
        monitoring: raw.monitoring ?? null,
        compliance: raw.compliance ?? null,
      },
    };
  }

  /**
   * Get full carrier report — checks Redis first, then fetches from the legacy
   * box via its fast bundled /report (~1s, one call, all sections), falling back
   * to LINQ (per-section fan-out) if legacy is down/slow. Returns null only when
   * both upstreams report the carrier does not exist; throws with an accurate
   * status when both fail otherwise, so a rate-limit or outage is never masked
   * as a 404.
   */
  async getFullReport(dotNumber: string): Promise<MorProCarrierReport | null> {
    // 1. Check Redis cache
    const cached = await cacheService.getCachedCarrierReport<MorProCarrierReport>(dotNumber);
    if (cached && isErrorBody(cached.carrier)) {
      // Poisoned entry written before not-found bodies were rejected — drop it.
      logger.warn(`Discarding cached not-found report for DOT ${dotNumber}`);
      await cacheService.invalidateCarrierReport(dotNumber);
    } else if (cached) {
      logger.info(`Carrier report cache HIT for DOT ${dotNumber} — serving instantly`);
      // LINQ-sourced entries (they keep raw snake_case fields) are re-normalized
      // on read, so ones cached before a normalizer fix pick it up too.
      if (cached.carrier?.legal_name !== undefined) {
        return normalizeLinqReport(cached);
      }
      return cached;
    }

    const startTime = Date.now();
    let sawRateLimit = false;
    let sawOtherError = false;
    let otherStatus = 0;
    let notFoundCount = 0;

    // Legacy box primary — reachable from the production dyno again and fastest
    // by far: its bundled /report returns the full report in ~1s (one call).
    // LINQ is the fallback (per-section fan-out) for when legacy is down/slow.
    const attempts: Array<{
      up: CarrierUpstream;
      timeoutMs: number;
      mode: 'bundled' | 'sections';
    }> = [
      { up: legacyUpstream, timeoutMs: 6000, mode: 'bundled' },
      { up: linqUpstream, timeoutMs: 8000, mode: 'sections' },
    ];

    for (const { up, timeoutMs, mode } of attempts) {
      const result =
        mode === 'bundled'
          ? await this.fetchBundledReport(up, dotNumber, timeoutMs)
          : await this.fetchReport(up, dotNumber, timeoutMs);

      if (result.kind === 'ok') {
        if (up.name === 'linq') result.report = normalizeLinqReport(result.report);
        await cacheService.cacheCarrierReport(dotNumber, result.report);
        logger.info(
          `Carrier report for DOT ${dotNumber} served by '${up.name}' in ${Date.now() - startTime}ms`
        );
        return result.report;
      }

      if (result.kind === 'notFound') notFoundCount++;
      else if (result.status === 429) sawRateLimit = true;
      else {
        sawOtherError = true;
        otherStatus = result.status;
      }
    }

    // Neither upstream returned data — surface the real reason.
    if (notFoundCount === attempts.length && !sawRateLimit && !sawOtherError) {
      logger.warn(`Carrier not found for DOT ${dotNumber} on any upstream`);
      return null;
    }
    if (sawRateLimit) {
      throw new TooManyRequestsError('Carrier data provider quota exceeded — please try again shortly.');
    }
    if (otherStatus === 401 || otherStatus === 403) {
      throw new AppError('Carrier data provider authentication failed', 502, 'UPSTREAM_AUTH');
    }
    throw new AppError('Carrier data provider is temporarily unavailable', 502, 'UPSTREAM_UNAVAILABLE');
  }

  /**
   * Cross-carrier insurance lead search.
   * LINQ `POST /v1/carriers/search` finds active carriers whose insurance has a
   * scheduled cancellation inside the window. Verified live 2026-09-14:
   * - paging is cursor-based (`page` is ignored; pass the prior `next_cursor`)
   * - `safety_rating` is ignored and rows carry FMCSA codes (S/C/U), so the
   *   safety filter is applied here, walking whole LINQ pages until `limit` fills
   * - rows already carry `insurance_summary.earliest_cancellation_date`; the
   *   per-row `/insurance` call is only for the MC docket
   * Cached in Redis for 1h keyed by filters + cursor (dates roll daily).
   */
  async searchInsuranceLeads(
    filters: InsuranceLeadFilters,
    cursor: string | null = null,
    limit = 25
  ): Promise<InsuranceLeadsResult | null> {
    // FMCSA's own feed first: LINQ barely has this data (probed 2026-09-15 — a
    // 30-day window gave 3 carriers in IL / 18 nationally, against 112 / 1,740
    // from FMCSA), so LINQ is only the fallback for this search.
    const fmcsa = await fmcsaLeadsService.searchInsuranceLeads(filters, cursor, limit);
    if (fmcsa) return fmcsa;

    logger.warn('FMCSA insurance lead search unavailable — falling back to LINQ');
    return this.searchInsuranceLeadsViaLinq(filters, cursor, limit);
  }

  /** Fallback for {@link searchInsuranceLeads} — LINQ's sparse cross-carrier search. */
  private async searchInsuranceLeadsViaLinq(
    filters: InsuranceLeadFilters,
    cursor: string | null = null,
    limit = 25
  ): Promise<InsuranceLeadsResult | null> {
    const safeLimit = Math.min(Math.max(limit, 1), 50);
    const windowDays = Math.min(Math.max(filters.expiringWithinDays ?? 30, 1), 90);

    // FMCSA insurance has no expiry date — a lapse is always a filed cancellation
    // with a future effective date, so "pending" and "expiring" are the same query.
    const base: LinqSearchFilters = {
      status: 'active',
      has_active_insurance: true,
      insurance_cancels_after: isoDateOffset(0),
      insurance_cancels_before: isoDateOffset(windowDays),
      limit: 50,
    };
    if (filters.state) base.state = filters.state.toUpperCase();
    if (filters.minUnits != null) base.min_fleet_size = filters.minUnits;
    if (filters.maxUnits != null) base.max_fleet_size = filters.maxUnits;
    if (filters.minSafety) base.safety_rating = filters.minSafety;

    const cacheKey = `insurance_leads:v4:${JSON.stringify({ ...base, cursor, safeLimit })}`;

    try {
      const cached = await cacheService.get<InsuranceLeadsResult>(cacheKey);
      if (cached) {
        logger.info(`Insurance leads cache HIT (${cacheKey})`);
        return cached;
      }

      // Whole LINQ pages only, so the returned cursor never skips rows. Safety,
      // and status alongside state, are matched on our side (splitLocalFilters).
      const search = await morproLinqService.searchCarriersFiltered(
        { ...base, ...(cursor != null ? { cursor } : {}) },
        { minRows: safeLimit }
      );
      if (!search) {
        logger.warn(`LINQ insurance lead search failed (${cacheKey})`);
        return null;
      }
      const rows = search.carriers;

      const results = await Promise.all(
        rows.map(async (row): Promise<InsuranceLead> => {
          const dot = String(row.dot_number);
          const insurance = await morproLinqService.getInsurance(dot);
          const cancelDate =
            row.insurance_summary?.earliest_cancellation_date ||
            insurance?.summary?.earliest_cancellation_date ||
            null;
          const policies = insurance?.active_policies || [];
          const cancelling = policies.find((p) => p.cancellation_date === cancelDate) || policies[0];
          return {
            dotNumber: dot,
            mcNumber: cancelling?.docket_number || null,
            legalName: row.legal_name || row.dba_name || `DOT ${dot}`,
            state: row.state,
            powerUnits: row.power_units,
            safetyRating: safetyLabel(row.safety_rating),
            // LINQ's search rows carry no contact details; the FMCSA path fills these.
            phone: null,
            email: null,
            insuranceStatus: 'pending',
            insuranceExpiryDate: cancelDate,
            daysUntilExpiry: cancelDate ? daysUntil(cancelDate) : null,
            pendingReason: cancelDate ? 'CANCELLATION_SCHEDULED' : null,
            insuranceCompany: cancelling?.company || null,
          };
        })
      );

      // Soonest cancellation first (within the batch — LINQ has no sort param)
      results.sort((a, b) => (a.daysUntilExpiry ?? Infinity) - (b.daysUntilExpiry ?? Infinity));

      const data: InsuranceLeadsResult = {
        total: results.length,
        limit: safeLimit,
        hasMore: search.hasMore,
        nextCursor: search.nextCursor != null ? String(search.nextCursor) : null,
        results,
      };
      // 1h TTL — insurance filings change daily at most. Don't cache a batch
      // cut short by a mid-walk LINQ failure.
      if (!search.partial) await cacheService.set(cacheKey, data, 3600);
      return data;
    } catch (error) {
      logger.error('Insurance lead search error', error as Error, { cacheKey });
      return null;
    }
  }
}

export const carrierDataService = new CarrierDataService();
export default carrierDataService;
