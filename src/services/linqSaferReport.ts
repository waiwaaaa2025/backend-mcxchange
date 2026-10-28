/**
 * Builds the per-section LINQ report from LINQ's combined `/safer/:dot` call.
 *
 * `/safer` returns the carrier profile with `authority`, `safety`, `insurance`
 * (active policies only), `sms_scores` and `oos_orders` embedded, and its `raw`
 * census row carries everything `/fleet`, `/cargo` and `/documents` return. So
 * one call replaces seven section calls; only `/insurance` (history, gaps,
 * upcoming cancellations) and `/crashes` still need their own.
 *
 * Output matches the raw section endpoints' shapes (probed 2026-10-28), so
 * normalizeLinqReport handles it unchanged.
 */

const SECTION_KEYS = ['authority', 'safety', 'insurance', 'sms_scores', 'oos_orders'] as const;

const num = (v: unknown): number | null => {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
};

// census column suffix → /fleet key
const EQUIPMENT: Record<string, string> = {
  tract: 'tractors',
  trail: 'trailers',
  truck: 'trucks',
  van_1_8: 'van_1_8',
  van_9_15: 'van_9_15',
  bus_16: 'bus_16',
  coach: 'coach',
  school_1_8: 'school_1_8',
  school_9_15: 'school_9_15',
  school_16: 'school_16',
  limo_1_8: 'limo_1_8',
  limo_9_15: 'limo_9_15',
  limo_16: 'limo_16',
};

function equipment(raw: any, prefix: 'own' | 'trm' | 'trp') {
  const out: Record<string, number | null> = {};
  for (const [suffix, key] of Object.entries(EQUIPMENT)) out[key] = num(raw[`${prefix}${suffix}`]);
  return out;
}

function fleet(c: any, raw: any) {
  return {
    dot_number: c.dot_number,
    power_units: c.power_units ?? null,
    truck_units: c.truck_units ?? null,
    bus_units: c.bus_units ?? null,
    total_drivers: c.total_drivers ?? null,
    total_cdl: c.total_cdl ?? null,
    total_intrastate_drivers: c.total_intrastate_drivers ?? null,
    driver_inter_total: c.driver_inter_total ?? null,
    avg_drivers_leased_per_month: c.avg_drivers_leased_per_month ?? null,
    total_cars: c.total_cars ?? null,
    fleetsize: c.fleetsize ?? null,
    hazmat: !!c.hazmat,
    mcs150_mileage: c.mcs150_mileage ?? null,
    mcs150_mileage_year: c.mcs150_mileage_year ?? null,
    mcs151_mileage: c.mcs151_mileage ?? null,
    owned: equipment(raw, 'own'),
    term_leased: equipment(raw, 'trm'),
    trip_leased: equipment(raw, 'trp'),
  };
}

function cargo(c: any, raw: any) {
  const flags: Record<string, boolean> = {};
  for (const k of Object.keys(raw).sort()) {
    if (k.startsWith('crgo_') && k !== 'crgo_cargoothr_desc') flags[k] = String(raw[k] || '').toUpperCase() === 'X';
  }
  const carried: string[] = Array.isArray(c.cargo_carried) ? c.cargo_carried : [];
  return {
    dot_number: c.dot_number,
    total_types: carried.length,
    cargo_carried: carried,
    other_description: c.crgo_cargoothr_desc ?? raw.crgo_cargoothr_desc ?? null,
    flags,
    hazmat: !!c.hazmat,
    passenger: !!flags.crgo_passengers,
  };
}

function documents(c: any, auth: any) {
  const oa = c.operating_authority || {};
  const flags = auth?.raw_flags || {};
  return {
    dot_number: c.dot_number,
    dockets: [1, 2, 3]
      .filter((i) => oa[`docket${i}`])
      .map((i) => ({ number: oa[`docket${i}`], prefix: oa[`docket${i}prefix`] ?? null, status: oa[`docket${i}_status_code`] ?? null })),
    mcs150: {
      date: c.mcs150_date ?? null,
      mileage: c.mcs150_mileage ?? null,
      mileage_year: c.mcs150_mileage_year ?? null,
      update_code: c.mcs150_update_code_id ?? null,
    },
    mcs151_mileage: c.mcs151_mileage ?? null,
    registration_date: c.add_date ?? null,
    dun_bradstreet_no: c.dun_bradstreet_no ?? null,
    insurance_requirements: auth
      ? {
          bipd_file: auth.bipd_file ?? null,
          cargo_file: auth.cargo_file ?? null,
          bond_file: auth.bond_file ?? null,
          cargo_required: auth.cargo_required ?? null,
          bond_required: auth.bond_required ?? null,
          min_coverage_amount: flags.min_cov_amount ?? null,
        }
      : null,
  };
}

/**
 * Split a `/safer` body into report sections. `insurance` is the full
 * `/insurance` response when that call succeeded; otherwise the active policies
 * embedded in `/safer` stand in.
 */
export function reportFromSafer(safer: any, insurance: any, crashes: any) {
  const carrier: any = { ...safer };
  for (const k of SECTION_KEYS) delete carrier[k];
  const raw = safer.raw || {};
  const authority = safer.authority?.dot_number != null ? safer.authority : null;
  return {
    carrier,
    authority,
    safety: safer.safety?.dot_number != null ? safer.safety : null,
    // LINQ no longer serves inspection or violation records (empty for every
    // DOT since at least 2026-10-28); FMCSA's open data fills them in.
    inspections: null,
    violations: null,
    crashes,
    insurance:
      insurance ??
      (Array.isArray(safer.insurance?.active_policies)
        ? { dot_number: safer.dot_number, active_policies: safer.insurance.active_policies }
        : null),
    fleet: fleet(carrier, raw),
    cargo: cargo(carrier, raw),
    documents: documents(carrier, authority),
    related: null,
    percentiles: null,
    oosOrders: Array.isArray(safer.oos_orders) ? safer.oos_orders : [],
    smsScores: safer.sms_scores ?? null,
    monitoring: null,
    compliance: null,
  };
}
