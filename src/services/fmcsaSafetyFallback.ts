/**
 * Fills a carrier report's inspection and BASIC violation data from FMCSA's
 * open data when the upstream report has none.
 *
 * LINQ (and the legacy box) lag on new authorities: DOT 4321984 had 15
 * inspections and 5 BASIC violations on FMCSA while LINQ reported zero of
 * everything, so the BASICs tab rendered empty. Per the carrier-data rule —
 * provider first, FMCSA when the provider has nothing — this only runs when the
 * report carries no inspections and no violations at all.
 *
 * BASIC *percentiles* are not filled: FMCSA does not publish them for property
 * carriers, so "Not Scored" stays the truthful answer there.
 */
import { socrata } from './fmcsaLeadsService';
import logger from '../utils/logger';

const VEHICLE_INSPECTIONS = 'fx4q-ay7w'; // Vehicle Inspection File — dot_number is NUMBER
const SMS_VIOLATIONS = '8mt8-2mdr'; // SMS Input - Violation — dot_number is TEXT

export const FALLBACK_MARKER = '_fmcsaSafetyFallback';

type BreakdownKey =
  | 'unsafeDriving' | 'hosCompliance' | 'driverFitness'
  | 'controlledSubstances' | 'vehicleMaintenance' | 'hazmatCompliance';

function basicKey(desc: unknown): BreakdownKey | null {
  const d = String(desc || '').toLowerCase();
  if (d.includes('unsafe')) return 'unsafeDriving';
  if (d.includes('hours')) return 'hosCompliance';
  if (d.includes('fitness')) return 'driverFitness';
  if (d.includes('controlled') || d.includes('alcohol')) return 'controlledSubstances';
  if (d.includes('vehicle')) return 'vehicleMaintenance';
  if (d.includes('hazardous') || d.includes('hm ')) return 'hazmatCompliance';
  return null;
}

// '20260817' → '2026-08-17'
function vifDate(v: unknown): string {
  const s = String(v || '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : s;
}

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};
// '17-AUG-26' → '2026-08-17'
function smsDate(v: unknown): string {
  const m = /^(\d{1,2})-([A-Z]{3})-(\d{2})$/.exec(String(v || '').toUpperCase());
  return m && MONTHS[m[2]] ? `20${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, '0')}` : '';
}

const n = (v: unknown) => parseInt(String(v ?? ''), 10) || 0;

function isEmpty(report: any): boolean {
  const records = report?.inspections?.records;
  if (Array.isArray(records) && records.length > 0) return false;
  const totals = report?.safety?.inspectionTotals || {};
  if (n(totals.total) > 0 || n(totals.driver) > 0 || n(totals.vehicle) > 0) return false;
  const breakdown = report?.safety?.violationBreakdown || {};
  return !Object.values(breakdown).some((v) => n(v) > 0);
}

/**
 * Mutates `report` in place. Returns true when FMCSA data was added. Marks the
 * report either way so a cached copy isn't re-queried on every read.
 */
export async function applyFmcsaSafetyFallback(report: any, dotNumber: string): Promise<boolean> {
  if (!report || report[FALLBACK_MARKER] !== undefined || !isEmpty(report)) return false;
  const dot = String(dotNumber).replace(/\D/g, '');
  if (!dot) return false;

  const [inspections, violations] = await Promise.all([
    socrata<any>(VEHICLE_INSPECTIONS, { $where: `dot_number=${dot}`, $order: 'insp_date DESC', $limit: '500' }, 8000),
    socrata<any>(SMS_VIOLATIONS, { $where: `dot_number='${dot}'`, $limit: '2000' }, 8000),
  ]);

  // A failed lookup leaves the report unmarked so the next read tries again.
  if (inspections === null && violations === null) return false;
  report[FALLBACK_MARKER] = false;
  if (!inspections?.length && !violations?.length) return false;

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - 24);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  // Violations by BASIC, and grouped by date so they can be hung on the
  // inspection they came from (SMS ids don't join to the inspection file).
  const breakdown: Record<BreakdownKey, number> = {
    unsafeDriving: 0, hosCompliance: 0, driverFitness: 0,
    controlledSubstances: 0, vehicleMaintenance: 0, hazmatCompliance: 0,
  };
  const byDate = new Map<string, any[]>();
  for (const v of violations || []) {
    const date = smsDate(v.insp_date);
    if (date && date < cutoffIso) continue;
    const key = basicKey(v.basic_desc);
    if (key) breakdown[key]++;
    const list = byDate.get(date) || [];
    list.push({
      basic_desc: String(v.basic_desc || '').replace(/&#8203;/g, ''),
      group_desc: v.group_desc || '',
      description: v.section_desc || v.viol_code || '',
      severity_weight: n(v.severity_weight),
      oos: v.oos_indicator === true || v.oos_indicator === 'true',
    });
    byDate.set(date, list);
  }

  const recent = (inspections || []).filter((r) => vifDate(r.insp_date) >= cutoffIso);
  const perDate = new Map<string, number>();
  for (const r of recent) perDate.set(vifDate(r.insp_date), (perDate.get(vifDate(r.insp_date)) || 0) + 1);

  const records = recent.map((r) => {
    const date = vifDate(r.insp_date);
    return {
      unique_id: String(r.inspection_id),
      inspection_date: date,
      report_state: r.report_state || '',
      report_number: r.report_number || '',
      level: String(r.insp_level_id || ''),
      viol_total: n(r.viol_total),
      oos_total: n(r.oos_total),
      driver_oos_total: n(r.driver_oos_total),
      vehicle_oos_total: n(r.vehicle_oos_total),
      hazmat_oos_total: n(r.hazmat_oos_total),
      // Only attach when the date picks out a single inspection.
      violations_list: perDate.get(date) === 1 ? byDate.get(date) || [] : [],
    };
  });

  // Same level rules the frontend uses (countInspectionsByType).
  const totals = { total: records.length, driver: 0, driverOOS: 0, vehicle: 0, vehicleOOS: 0, hazmat: 0, hazmatOOS: 0 };
  for (const r of records) {
    if (['1', '2', '4', '5', '6'].includes(r.level)) {
      totals.vehicle++;
      if (r.vehicle_oos_total > 0) totals.vehicleOOS++;
    }
    if (['1', '2', '3', '6'].includes(r.level)) {
      totals.driver++;
      if (r.driver_oos_total > 0) totals.driverOOS++;
    }
    if (r.hazmat_oos_total > 0) { totals.hazmat++; totals.hazmatOOS++; }
  }

  report.safety = {
    ...(report.safety || {}),
    violationBreakdown: breakdown,
    inspectionTotals: { ...totals, last24Months: totals.total, source: 'fmcsa_open_data' },
  };
  report.inspections = {
    ...(report.inspections || {}),
    summary: { ...(report.inspections?.summary || {}), total_inspections: String(records.length) },
    records,
  };
  report[FALLBACK_MARKER] = true;

  logger.info(
    `FMCSA safety fallback for DOT ${dot}: ${records.length} inspections, ` +
    `${Object.values(breakdown).reduce((a, b) => a + b, 0)} BASIC violations`
  );
  return true;
}
