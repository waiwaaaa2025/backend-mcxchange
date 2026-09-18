/**
 * Brand-new carriers straight from the FMCSA Company Census (Socrata `az4n-8mr2`),
 * for the Admin Leads "New Carriers" tab.
 *
 * The census is the only FMCSA feed that carries both the registration date
 * (`add_date`, text `YYYYMMDD`) and the email the carrier filed with its MCS-150,
 * so one query answers "who registered lately, and how do I reach them" — no
 * per-carrier lookups. It refreshes roughly weekly, so the newest few days are
 * always missing; `dataThrough` tells the admin where the file currently ends.
 * Measured 2026-09-18: ~12,200 new DOTs in 30 days, ~all with an email.
 */
import cacheService from './cacheService';
import { socrata, formatPhone } from './fmcsaLeadsService';
import logger from '../utils/logger';

const DATASET_CENSUS = 'az4n-8mr2';
// The census changes weekly at most, so an hour of caching costs nothing.
const CACHE_TTL = 3600;
// Socrata's single-request ceiling; a 90-day window is ~40k rows.
const EXPORT_MAX = 50_000;

const SELECT =
  'dot_number, legal_name, dba_name, add_date, phy_city, phy_state, power_units, total_drivers, ' +
  'classdef, company_officer_1, phone, email_address, docket1prefix, docket1';

export interface NewCarrierFilters {
  days?: number;
  state?: string | null;
  name?: string | null;
  forHireOnly?: boolean;   // "AUTHORIZED FOR HIRE" on the census classification
  withMcOnly?: boolean;    // already holds an MC/FF/MX docket
  emailOnly?: boolean;
}

export interface NewCarrier {
  dotNumber: string;
  mcNumber: string | null;
  legalName: string;
  dbaName: string | null;
  city: string | null;
  state: string | null;
  registeredDate: string | null;   // ISO
  powerUnits: number | null;
  drivers: number | null;
  forHire: boolean;
  officer: string | null;
  phone: string | null;
  email: string | null;
}

interface CensusRow {
  dot_number?: string;
  legal_name?: string;
  dba_name?: string;
  add_date?: string;
  phy_city?: string;
  phy_state?: string;
  power_units?: string;
  total_drivers?: string;
  classdef?: string;
  company_officer_1?: string;
  phone?: string;
  email_address?: string;
  docket1prefix?: string;
  docket1?: string;
}

function stamp(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}

function iso(value: string | undefined): string | null {
  const v = (value || '').trim();
  return /^\d{8}$/.test(v) ? `${v.slice(0, 4)}-${v.slice(4, 6)}-${v.slice(6, 8)}` : null;
}

function num(value: string | undefined): number | null {
  const n = Number(value);
  return value != null && value !== '' && Number.isFinite(n) ? n : null;
}

function normalize(filters: NewCarrierFilters) {
  return {
    days: Math.min(Math.max(Math.round(filters.days ?? 30), 1), 90),
    state: filters.state ? filters.state.trim().toUpperCase().slice(0, 2) : null,
    name: filters.name ? filters.name.trim().toUpperCase() : null,
    forHireOnly: !!filters.forHireOnly,
    withMcOnly: !!filters.withMcOnly,
    emailOnly: filters.emailOnly !== false,
  };
}

function whereFor(f: ReturnType<typeof normalize>): string {
  const since = stamp(new Date(Date.now() - f.days * 86_400_000));
  const where = [`add_date >= '${since}'`, `status_code='A'`];
  if (f.state && /^[A-Z]{2}$/.test(f.state)) where.push(`phy_state='${f.state}'`);
  if (f.name) {
    const needle = f.name.replace(/'/g, "''");
    where.push(`(upper(legal_name) like '%${needle}%' OR upper(dba_name) like '%${needle}%')`);
  }
  if (f.forHireOnly) where.push(`classdef like '%AUTHORIZED FOR HIRE%'`);
  if (f.withMcOnly) where.push(`docket1 IS NOT NULL`);
  if (f.emailOnly) where.push(`email_address IS NOT NULL`);
  return where.join(' AND ');
}

function toCarrier(row: CensusRow): NewCarrier {
  const dot = (row.dot_number || '').trim();
  const docket = `${(row.docket1prefix || '').trim()}${(row.docket1 || '').trim()}`;
  return {
    dotNumber: dot,
    mcNumber: docket || null,
    legalName: (row.legal_name || '').trim() || `DOT ${dot}`,
    dbaName: (row.dba_name || '').trim() || null,
    city: (row.phy_city || '').trim() || null,
    state: (row.phy_state || '').trim() || null,
    registeredDate: iso(row.add_date),
    powerUnits: num(row.power_units),
    drivers: num(row.total_drivers),
    forHire: (row.classdef || '').toUpperCase().includes('AUTHORIZED FOR HIRE'),
    officer: (row.company_officer_1 || '').trim() || null,
    phone: formatPhone(row.phone),
    email: (row.email_address || '').trim().toLowerCase() || null,
  };
}

class FmcsaNewCarriersService {
  /** One page of new carriers, newest registration first. Null if FMCSA is unreachable. */
  async search(filters: NewCarrierFilters, offset = 0, limit = 50) {
    const f = normalize(filters);
    const safeLimit = Math.min(Math.max(limit, 1), 100);
    const safeOffset = Math.max(offset, 0);
    const cacheKey = `new_carriers:v1:${JSON.stringify({ ...f, safeOffset, safeLimit })}`;

    try {
      const cached = await cacheService.get<any>(cacheKey);
      if (cached) return cached;
    } catch {
      // cache is best-effort
    }

    const where = whereFor(f);
    const [countRows, rows, dataThrough] = await Promise.all([
      socrata<{ count?: string }>(DATASET_CENSUS, { $select: 'count(*) AS count', $where: where }),
      socrata<CensusRow>(DATASET_CENSUS, {
        $select: SELECT,
        $where: where,
        $order: 'add_date DESC, dot_number',
        $offset: String(safeOffset),
        $limit: String(safeLimit),
      }),
      this.dataThrough(),
    ]);
    if (!countRows || !rows) return null;

    const total = Number(countRows[0]?.count || 0);
    const result = {
      total,
      offset: safeOffset,
      limit: safeLimit,
      hasMore: safeOffset + rows.length < total,
      dataThrough,
      days: f.days,
      results: rows.map(toCarrier),
    };
    try {
      await cacheService.set(cacheKey, result, CACHE_TTL);
    } catch {
      // cache is best-effort
    }
    return result;
  }

  /** Every matching carrier (capped at 50k) for CSV / email export. */
  async exportAll(filters: NewCarrierFilters): Promise<NewCarrier[] | null> {
    const rows = await socrata<CensusRow>(
      DATASET_CENSUS,
      {
        $select: SELECT,
        $where: whereFor(normalize(filters)),
        $order: 'add_date DESC, dot_number',
        $limit: String(EXPORT_MAX),
      },
      90_000
    );
    if (!rows) return null;
    if (rows.length >= EXPORT_MAX) logger.warn(`New carrier export hit the ${EXPORT_MAX}-row cap`);
    return rows.map(toCarrier);
  }

  /** The newest registration date in the census file — where the data currently ends. */
  private async dataThrough(): Promise<string | null> {
    const cacheKey = 'new_carriers:data_through';
    try {
      const cached = await cacheService.get<string>(cacheKey);
      if (cached) return cached;
    } catch {
      // cache is best-effort
    }
    const since = stamp(new Date(Date.now() - 60 * 86_400_000));
    const rows = await socrata<{ max_add_date?: string }>(DATASET_CENSUS, {
      $select: 'max(add_date) AS max_add_date',
      $where: `add_date >= '${since}'`,
    });
    const value = iso(rows?.[0]?.max_add_date);
    if (value) {
      try {
        await cacheService.set(cacheKey, value, CACHE_TTL);
      } catch {
        // cache is best-effort
      }
    }
    return value;
  }
}

export const fmcsaNewCarriersService = new FmcsaNewCarriersService();
export default fmcsaNewCarriersService;
