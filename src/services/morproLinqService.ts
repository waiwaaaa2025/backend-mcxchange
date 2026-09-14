import { config } from '../config';
import logger from '../utils/logger';
import cacheService from './cacheService';

// LINQ docs: https://www.morprolinq.com/docs
// Auth: X-Manifest-Key header
// LINQ is the indexed source of truth — Domilea does NOT mirror carrier data.
// Every read here is a live HTTP call to LINQ.

export interface LinqSearchFilters {
  // Round 1 (original) filters
  state?: string;
  status?: 'ACTIVE' | 'INACTIVE' | 'REVOKED' | string;
  min_fleet_size?: number;
  max_fleet_size?: number;
  cargo_type?: string;               // IGNORED by LINQ — matched locally (splitLocalFilters)
  safety_rating?: 'Satisfactory' | 'Conditional' | 'Unsatisfactory' | string; // IGNORED — matched locally
  page?: number;                     // IGNORED by LINQ (verified 2026-09-14) — page with `cursor`
  limit?: number;                    // max 50, else 400
  cursor?: string | number;          // previous response's next_cursor

  // Round 4 additions — see https://www.morprolinq.com/docs
  insurance_cancels_before?: string; // ISO date YYYY-MM-DD
  insurance_cancels_after?: string;  // ISO date YYYY-MM-DD
  has_active_insurance?: boolean;
  name_contains?: string;            // case-insensitive substring of legal_name
  added_before?: string;             // company age filter (ISO date)
  added_after?: string;
}

export interface LinqCarrierRow {
  dot_number: number | string;
  legal_name: string | null;
  dba_name?: string | null;
  state: string | null;
  status: string | null;          // "ACTIVE" | "INACTIVE" | …
  power_units: number | null;
  drivers?: number | null;
  safety_rating: string | null;   // FMCSA code: "S" | "C" | "U" | null
  city?: string | null;
  add_date?: string | null;       // YYYYMMDD
  insurance_summary?: {
    earliest_cancellation_date: string | null;
    total_active_coverage: number | null;
    active_policies_count: number | null;
  } | null;
}

export interface LinqSearchResult {
  page: number;
  limit: number;
  has_more: boolean;
  next_cursor?: string | number | null;
  carriers: LinqCarrierRow[];
}

// FMCSA safety rating codes as LINQ returns them on carrier rows.
const SAFETY_LABELS: Record<string, string> = { S: 'Satisfactory', C: 'Conditional', U: 'Unsatisfactory' };

export function safetyLabel(code: string | null | undefined): string | null {
  if (!code) return null;
  return SAFETY_LABELS[code.toUpperCase()] ?? code;
}

// "Satisfactory" / "SATISFACTORY" / "S" → "S"; empty → null (no filter).
export function safetyCode(value: string | null | undefined): string | null {
  const v = (value || '').trim();
  return v ? v.charAt(0).toUpperCase() : null;
}

// The 30 FMCSA cargo classifications, spelled exactly as LINQ returns them in
// `cargo_carried` (collected live 2026-09-14).
export const CARGO_TYPES = [
  'General Freight', 'Household Goods', 'Metal/Sheets/Coils', 'Motor Vehicles', 'Drive/Tow Away',
  'Logs/Poles/Lumber', 'Building Materials', 'Mobile Homes', 'Machinery/Large Objects',
  'Fresh/Frozen Foods', 'Liquids/Gases', 'Intermodal Containers', 'Passengers', 'Oilfield Equipment',
  'Livestock', 'Grain/Feed/Hay', 'Coal/Coke', 'Meat', 'Garbage/Refuse', 'US Mail', 'Chemicals',
  'Commodities/Dry Bulk', 'Beverages', 'Paper Products', 'Utilities', 'Farm Supplies', 'Construction',
  'Water Well', 'Produce', 'Other',
] as const;

// Common wording that doesn't appear in the FMCSA labels.
const CARGO_ALIASES: Record<string, string> = {
  refrigerated: 'fresh/frozen foods',
  'refrigerated food': 'fresh/frozen foods',
  reefer: 'fresh/frozen foods',
};

// Everything a carrier profile says it hauls: the FMCSA labels plus the
// free-text description behind "Other" (e.g. "DAIRY", "SAND, GRAVEL, DIRT").
export function carrierCargo(profile: any): string[] {
  const labels: string[] = Array.isArray(profile?.cargo_carried) ? profile.cargo_carried : [];
  const other = profile?.crgo_cargoothr_desc;
  return other ? [...labels, String(other)] : labels;
}

// Case-insensitive substring match, so "frozen" finds Fresh/Frozen Foods and
// "gravel" finds an "Other: SAND, GRAVEL, DIRT" carrier.
export function cargoMatches(cargo: string[], query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const needle = CARGO_ALIASES[q] ?? q;
  return cargo.some((c) => c.toLowerCase().includes(needle));
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const cur = i++;
      results[cur] = await fn(items[cur]);
    }
  });
  await Promise.all(workers);
  return results;
}

// Filters LINQ can't be trusted with, applied to the rows we get back instead
// (all verified live 2026-09-14):
// - `safety_rating` is ignored by LINQ; rows carry the FMCSA code (S/C/U), and
//   unrated carriers never match.
// - `status` combined with `state` makes every cursor page after the first fail
//   with a 500 after ~30s, so when both are set status is matched on the row
//   (ACTIVE/INACTIVE). REVOKED has no row value and 500s in LINQ regardless.
// - `cargo_type` is ignored by LINQ and search rows carry no cargo, so it needs a
//   per-carrier lookup: `cargo` is returned for the caller to apply with
//   filterByCargo (or cargoMatches on a profile it already fetched).
export function splitLocalFilters(filters: LinqSearchFilters): {
  linq: LinqSearchFilters;
  matches: (row: LinqCarrierRow) => boolean;
  cargo: string | null;
  hasLocal: boolean;
} {
  const { safety_rating, cargo_type, ...linq } = filters;
  const code = safetyCode(safety_rating);
  const cargo = cargo_type?.trim() || null;
  const status = (filters.status || '').toUpperCase();
  const localStatus = filters.state && (status === 'ACTIVE' || status === 'INACTIVE') ? status : null;
  if (localStatus) delete linq.status;
  const matches = (row: LinqCarrierRow) =>
    (!code || (row.safety_rating || '').toUpperCase() === code) &&
    (!localStatus || (row.status || '').toUpperCase() === localStatus);
  return { linq, matches, cargo, hasLocal: !!(code || localStatus || cargo) };
}

export interface LinqFilteredSearchResult {
  carriers: LinqCarrierRow[];
  hasMore: boolean;
  nextCursor: string | number | null;
  partial: boolean; // a later LINQ page failed mid-walk; don't cache
}

export interface LinqInsurancePolicy {
  company?: string;
  policy_number?: string;
  docket_number?: string;
  form_code?: string;
  form_category?: string;
  effective_date?: string;
  cancellation_date?: string | null;
  coverage_amount?: number;
  is_active?: boolean;
  days_to_cancellation?: number | null;
}

export interface LinqInsuranceSummary {
  total_active_coverage?: number;
  active_policies?: number;
  earliest_cancellation_date?: string | null;
}

export interface LinqInsuranceResponse {
  summary?: LinqInsuranceSummary;
  active_policies?: LinqInsurancePolicy[];
  cancellations_upcoming?: LinqInsurancePolicy[];
}

function headers(): Record<string, string> {
  const key = config.morproLinq.apiKey;
  return {
    'Content-Type': 'application/json',
    ...(key ? { 'X-Manifest-Key': key } : {}),
  };
}

function url(path: string): string {
  return `${config.morproLinq.baseUrl.replace(/\/$/, '')}${path}`;
}

async function fetchJson(path: string, init?: RequestInit, timeoutMs = 15000): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url(path), {
      ...init,
      headers: { ...headers(), ...(init?.headers || {}) },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      logger.warn(`LINQ ${init?.method || 'GET'} ${path} → ${res.status}: ${body.slice(0, 200)}`);
      return null;
    }
    const body: any = await res.json();
    // LINQ answers an unknown DOT with 200 + {"error":"Carrier not found"}.
    if (body && typeof body === 'object' && typeof body.error === 'string' && body.dot_number == null) {
      logger.warn(`LINQ ${init?.method || 'GET'} ${path} → 200 with error: ${body.error}`);
      return null;
    }
    return body;
  } catch (err) {
    logger.warn(`LINQ ${init?.method || 'GET'} ${path} failed`, { error: (err as Error).message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

class MorProLinqService {
  isConfigured(): boolean {
    return !!config.morproLinq.apiKey;
  }

  async searchCarriers(filters: LinqSearchFilters): Promise<LinqSearchResult | null> {
    return (await fetchJson('/v1/carriers/search', {
      method: 'POST',
      body: JSON.stringify(filters),
    })) as LinqSearchResult | null;
  }

  /**
   * Search with the filters LINQ can't handle (see splitLocalFilters) applied on
   * our side. Walks whole LINQ pages — never splitting one, so the returned
   * cursor never skips rows — until `minRows` carriers match or `maxPages` pages
   * are read. With nothing to filter locally this is exactly one LINQ call.
   * Returns null only if the first call fails; a match-poor walk can come back
   * with few rows and hasMore=true.
   */
  async searchCarriersFiltered(
    filters: LinqSearchFilters,
    opts: { minRows?: number; maxPages?: number } = {}
  ): Promise<LinqFilteredSearchResult | null> {
    const { linq, matches, cargo, hasLocal } = splitLocalFilters(filters);
    const { cursor: startCursor, ...base } = linq;
    const minRows = opts.minRows ?? filters.limit ?? 25;
    // A cargo filter costs one profile lookup per row, so it scans fewer pages.
    const maxPages = hasLocal ? opts.maxPages ?? (cargo ? 3 : 5) : 1;
    // Scan full 50-row pages when filtering locally so matches turn up in fewer calls.
    const pageLimit = hasLocal ? 50 : filters.limit;

    const carriers: LinqCarrierRow[] = [];
    let cursor: string | number | null = startCursor ?? null;
    let hasMore = true;
    let partial = false;
    for (let i = 0; i < maxPages && hasMore && carriers.length < minRows; i++) {
      const page = await this.searchCarriers({
        ...base,
        ...(pageLimit != null ? { limit: pageLimit } : {}),
        ...(cursor != null ? { cursor } : {}),
      });
      if (!page) {
        if (i === 0) return null;
        partial = true;
        break;
      }
      const rows = (page.carriers || []).filter(matches);
      carriers.push(...(cargo ? await this.filterByCargo(rows, cargo) : rows));
      cursor = page.next_cursor ?? null;
      hasMore = !!page.has_more && cursor != null;
    }
    return { carriers, hasMore, nextCursor: hasMore ? cursor : null, partial };
  }

  /**
   * What a carrier hauls (see carrierCargo), cached 7 days — cargo
   * classifications only change when the carrier refiles its MCS-150. Returns
   * null when the lookup fails, which is not cached.
   */
  async getCargo(dot: string): Promise<string[] | null> {
    const key = `linq_cargo:v1:${dot}`;
    const cached = await cacheService.get<string[]>(key);
    if (cached) return cached;
    const profile = await this.getCarrier(dot);
    if (!profile) return null;
    const cargo = carrierCargo(profile);
    await cacheService.set(key, cargo, 7 * 24 * 3600);
    return cargo;
  }

  // Keep rows whose carrier hauls `query`; rows whose lookup fails are dropped.
  async filterByCargo<T extends { dot_number: number | string }>(rows: T[], query: string): Promise<T[]> {
    const cargo = await mapLimit(rows, 12, (r) => this.getCargo(String(r.dot_number)));
    return rows.filter((_, i) => cargo[i] != null && cargoMatches(cargo[i] as string[], query));
  }

  async getCarrier(dot: string): Promise<Record<string, unknown> | null> {
    return (await fetchJson(`/v1/carriers/${dot}`)) as Record<string, unknown> | null;
  }

  async getInsurance(dot: string): Promise<LinqInsuranceResponse | null> {
    return (await fetchJson(`/v1/carriers/${dot}/insurance`)) as LinqInsuranceResponse | null;
  }

  async getFullReport(dot: string, timeoutMs = 60_000): Promise<Record<string, unknown> | null> {
    // /report aggregates 14 sub-queries server-side — can take 5-20s today.
    // LINQ team's Phase 1 perf PR targets <500ms; until then we accept the latency
    // because compliance snapshots are written once-per-refresh, not per page-load.
    return (await fetchJson(`/v1/carriers/${dot}/report?format=json`, undefined, timeoutMs)) as Record<string, unknown> | null;
  }
}

export const morproLinqService = new MorProLinqService();
export default morproLinqService;
