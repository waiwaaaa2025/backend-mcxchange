import { MorProCarrierReport } from '../types/carrierData';

/**
 * LINQ serves its raw snake_case records (`legal_name`, `physical_address`,
 * `broker_authority`, `active_policies`...), while every consumer of a carrier
 * report — Carrier Pulse, listing intel, the snapshot service — reads the
 * legacy box's camelCase shape (`legalName`, `location`, `statuses.broker`,
 * `activePolicies`...). Reports LINQ serves (anything the legacy box doesn't
 * hold, e.g. most pure freight brokers) were passed through untouched, so the
 * page rendered with no name, DOT, location or authority.
 *
 * This maps a LINQ report onto the legacy shape. Raw LINQ fields are kept
 * alongside the mapped ones so nothing that already read them breaks.
 */

// "20231007 1558" / "20220106" / "2024-01-24" → ISO date string, else null.
function linqDate(v: unknown): string | null {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const compact = /^(\d{4})(\d{2})(\d{2})/.exec(s);
  const iso = compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : s.slice(0, 10);
  const t = Date.parse(iso);
  return isNaN(t) ? null : new Date(t).toISOString();
}

// LINQ authority flags are 'ACTIVE' / 'A' / 'INACTIVE' / 'N' — 'N' means none.
function authStatus(v: unknown): string | null {
  if (v == null) return null;
  const s = String(v).trim().toUpperCase();
  if (!s || s === 'N' || s === 'NONE') return null;
  if (s === 'A') return 'ACTIVE';
  if (s === 'I') return 'INACTIVE';
  return s;
}

const yn = (b: unknown) => (b ? 'Y' : 'N');

// LINQ coverage is in dollars; the legacy report (and the page) use $1,000s.
function coverageThousands(v: unknown): number | null {
  const n = Number(v);
  if (v == null || isNaN(n)) return null;
  return n >= 1000 ? Math.round(n / 1000) : n;
}

function mapPolicy(p: any) {
  const cancelled = !!p.cancellation_date;
  return {
    insurer: p.company ?? null,
    policyNumber: p.policy_number ?? null,
    type: p.form_code ?? null,
    typeLabel: p.form_description ?? null,
    coverage: coverageThousands(p.coverage_amount),
    required: coverageThousands(p.min_coverage_amount),
    status: p.is_active === false || p.expired ? 'cancelled' : 'active',
    effectiveDate: linqDate(p.effective_date),
    expirationDate: null,
    cancelDate: cancelled ? linqDate(p.cancellation_date) : null,
    cancelMethod: p.cancellation_method_description ?? p.cancellation_method ?? null,
    docket: p.docket_number ?? null,
  };
}

function normalizeCarrier(c: any, auth: any, fleet: any): any {
  const addr = c.physical_address || {};
  const oa = c.operating_authority || {};
  const mcDocket =
    [1, 2, 3]
      .map((i) => ({ prefix: oa[`docket${i}prefix`], num: oa[`docket${i}`] }))
      .find((d) => d.prefix === 'MC' && d.num)?.num ??
    (/^MC(\d+)$/.exec(String(auth?.docket_number || ''))?.[1] || null);

  const anyActiveAuthority = [auth?.common_authority, auth?.contract_authority, auth?.broker_authority].some(
    (s) => authStatus(s) === 'ACTIVE'
  );
  const isActive = String(c.status_code || '').toUpperCase() === 'A';

  const registered = linqDate(c.add_date);
  const ageDays = registered ? Math.floor((Date.now() - Date.parse(registered)) / 86_400_000) : null;

  return {
    ...c,
    dotNumber: c.dot_number != null ? String(c.dot_number) : null,
    mcNumber: mcDocket ? String(mcDocket) : null,
    legalName: c.legal_name ?? null,
    dbaName: c.dba_name ?? null,
    entityType: c.entity_type ?? null,
    operatingStatus: c.status_code ?? null,
    allowedToOperate: isActive && anyActiveAuthority ? 'Y' : 'N',
    location: {
      street: addr.street ?? null,
      city: addr.city ?? null,
      state: addr.state ?? null,
      zip: addr.zip ?? null,
      country: addr.country ?? null,
    },
    phone: c.phone ?? null,
    email: c.email ?? null,
    fax: c.fax ?? null,
    powerUnits: c.power_units ?? fleet?.power_units ?? null,
    totalDriversCDL: c.total_cdl ?? null,
    drivers: c.total_drivers ?? null,
    totalDrivers: c.total_drivers ?? null,
    mcs150Date: linqDate(c.mcs150_date),
    mcs150Mileage: c.mcs150_mileage != null ? String(c.mcs150_mileage) : null,
    registrantDate: registered,
    safetyRating: c.safety_rating ?? null,
    authorityAgeDays: ageDays,
    yearsActive: ageDays != null ? (ageDays / 365.25).toFixed(1) : null,
    authorizedForHire: /AUTHORIZED FOR HIRE/i.test(String(c.classdef || '')),
    exemptForHire: /EXEMPT FOR HIRE/i.test(String(c.classdef || '')),
    privateProperty: /PRIVATE PROPERTY/i.test(String(c.classdef || '')),
    carrierOperation: c.carrier_operation ?? null,
    phmsaFlag: !!(c.hazmat || c.hm_ind === 'Y'),
  };
}

function normalizeAuthority(a: any): any {
  const status = (s: unknown) => ({ status: authStatus(s), grantedDate: null, effectiveDate: null });
  const history: any[] = Array.isArray(a.authority_history) ? a.authority_history : [];
  return {
    ...a,
    statuses: {
      common: status(a.common_authority),
      contract: status(a.contract_authority),
      broker: status(a.broker_authority),
    },
    pendingFlags: {
      commonPending: yn(a.common_app_pending),
      contractPending: yn(a.contract_app_pending),
      brokerPending: yn(a.broker_app_pending),
      commonRevocationPending: yn(a.common_revocation_pending),
      contractRevocationPending: yn(a.contract_revocation_pending),
      brokerRevocationPending: yn(a.broker_revocation_pending),
    },
    revocations: history.filter((h) => /REVOC/i.test(String(h?.event || h?.action || h?.type || ''))),
    timeline: history,
  };
}

// LINQ repeats one filing per form row; collapse exact duplicates.
function dedupePolicies<T extends { policyNumber: unknown; type: unknown; effectiveDate: unknown; cancelDate: unknown }>(
  rows: T[]
): T[] {
  const seen = new Set<string>();
  return rows.filter((p) => {
    const key = `${p.policyNumber}|${p.type}|${p.effectiveDate}|${p.cancelDate}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeInsurance(i: any): any {
  const activePolicies = dedupePolicies((i.active_policies || []).map(mapPolicy));
  const history = dedupePolicies(
    (i.history || []).map((p: any) => {
      const m = mapPolicy(p);
      return { ...m, date: m.effectiveDate, event: m.cancelDate ? 'CANCELLED' : 'FILED' };
    })
  );
  const gaps = (i.coverage_gaps || []).map((g: any) => ({
    gapStart: linqDate(g.from),
    gapEnd: linqDate(g.to),
    days: g.days ?? null,
  }));
  return { ...i, activePolicies, renewalTimeline: [], history, gaps };
}

function normalizeSafety(s: any): any {
  const basicScores = (s.basics || []).map((b: any) => ({
    name: b.category,
    score: b.percentile ?? null,
    threshold: /Unsafe|Hours|Crash/i.test(String(b.category)) ? 65 : 80,
    alert: !!b.alert,
    description: '',
  }));
  return { ...s, basicScores, safetyRating: { rating: s.safety_rating ?? null, date: s.safety_rating_date ?? null } };
}

function normalizeDocuments(d: any, carrier: any): any {
  return {
    ...d,
    dockets: d.dockets || [],
    insuranceOnFile: [],
    mcs150: {
      date: linqDate(d.mcs150?.date),
      mileage: d.mcs150?.mileage != null ? String(d.mcs150.mileage) : null,
      year: d.mcs150?.mileage_year ?? null,
    },
    safetyRating: { rating: carrier?.safety_rating ?? null, date: carrier?.safety_rating_date ?? null },
    verificationChecks: [],
  };
}

/** Map a report fetched from LINQ onto the legacy report shape. */
export function normalizeLinqReport(r: MorProCarrierReport): MorProCarrierReport {
  const authority = r.authority || {};
  return {
    ...r,
    carrier: r.carrier ? normalizeCarrier(r.carrier, authority, r.fleet) : r.carrier,
    authority: r.authority ? normalizeAuthority(r.authority) : r.authority,
    safety: r.safety ? normalizeSafety(r.safety) : r.safety,
    inspections: r.inspections
      ? {
          ...r.inspections,
          summary: { total_inspections: String(r.inspections.total ?? 0) },
          topViolations: [],
          records: r.inspections.inspections || [],
        }
      : r.inspections,
    violations: r.violations ? { ...r.violations, violations: r.violations.violations || [] } : r.violations,
    crashes: r.crashes
      ? { ...r.crashes, summary: { total: String(r.crashes.total ?? 0) }, records: r.crashes.crashes || [] }
      : r.crashes,
    insurance: r.insurance ? normalizeInsurance(r.insurance) : r.insurance,
    fleet: r.fleet ? { ...r.fleet, trucks: [], trailers: [] } : r.fleet,
    cargo: r.cargo
      ? {
          ...r.cargo,
          ...(r.cargo.flags || {}),
          authorizedForHire: /AUTHORIZED FOR HIRE/i.test(String(r.carrier?.classdef || '')),
          hazmat: !!r.cargo.hazmat,
          passengerCarrier: !!r.cargo.passenger,
          generalFreight: r.cargo.flags?.crgo_genfreight ?? null,
          householdGoods: r.cargo.flags?.crgo_household ?? null,
        }
      : r.cargo,
    documents: r.documents ? normalizeDocuments(r.documents, r.carrier) : r.documents,
    related: r.related?.relatedCarriers ? r.related : { relatedCarriers: [] },
    percentiles: r.percentiles?.percentiles ? r.percentiles : { percentiles: [] },
  };
}
