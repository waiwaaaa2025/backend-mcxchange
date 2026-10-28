import fmcsaLeadsService from './fmcsaLeadsService';
import morproLinqService, { LinqCarrierRow, LinqFilteredSearchResult, LinqSearchFilters, splitLocalFilters } from './morproLinqService';
import logger from '../utils/logger';

/**
 * Carrier search. LINQ serves it whenever it can answer the filters itself (one
 * call per page). Filters it ignores or fails on (safety rating, added dates,
 * state + status — see splitLocalFilters) used to mean scanning up to five LINQ
 * pages per page shown; those go to FMCSA's census instead, which filters
 * server-side in one query. If the census is unavailable (Socrata throttles
 * anonymous callers) the LINQ page scan still runs.
 *
 * Census rows already carry phone/email (`source: 'census'`), so callers can
 * skip their own contact lookups for them.
 */
export interface CarrierSearchResult extends LinqFilteredSearchResult {
  carriers: Array<LinqCarrierRow & { phone?: string | null; email?: string | null }>;
  source: 'linq' | 'census';
}

// The census has no insurance data, so insurance filters stay on LINQ.
const hasInsuranceFilters = (f: LinqSearchFilters) =>
  f.has_active_insurance != null || !!f.insurance_cancels_after || !!f.insurance_cancels_before;

// Census pages are cursored "c<last DOT>" so a listing keeps paging through the
// census once it started there; LINQ's own cursor stays on LINQ.
const CENSUS_CURSOR = /^c(\d+)$/;

export async function searchCarriers(
  filters: LinqSearchFilters,
  opts: { minRows?: number; maxPages?: number } = {}
): Promise<CarrierSearchResult | null> {
  const censusCursor = CENSUS_CURSOR.exec(String(filters.cursor ?? ''));
  const { hasLocal } = splitLocalFilters(filters);
  const useCensus = censusCursor || (filters.cursor == null && hasLocal && !hasInsuranceFilters(filters));
  if (useCensus) {
    const census = await fmcsaLeadsService.searchCensusCarriers(
      filters,
      censusCursor ? censusCursor[1] : null,
      Math.min(50, Math.max(1, filters.limit ?? 25))
    );
    if (census) {
      return {
        ...census,
        nextCursor: census.nextCursor != null ? `c${census.nextCursor}` : null,
        partial: false,
        source: 'census',
      };
    }
    logger.warn('Census carrier search unavailable — scanning LINQ pages instead');
  }
  // A census listing that loses the census mid-way carries on from the same DOT
  // on LINQ (its cursor is also a DOT) rather than failing the page.
  const linqFilters = censusCursor ? { ...filters, cursor: Number(censusCursor[1]) } : filters;
  const linq = await morproLinqService.searchCarriersFiltered(linqFilters, opts);
  return linq ? { ...linq, source: 'linq' } : null;
}

export default { searchCarriers };
