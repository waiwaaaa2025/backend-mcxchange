import { config } from '../config';
import logger from '../utils/logger';

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
  cargo_type?: string;
  safety_rating?: 'Satisfactory' | 'Conditional' | 'Unsatisfactory' | string;
  page?: number;
  limit?: number;

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
  safety_rating: string | null;
}

export interface LinqSearchResult {
  page: number;
  limit: number;
  has_more: boolean;
  carriers: LinqCarrierRow[];
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
