/**
 * Estimated BASIC percentiles for property carriers.
 *
 * FMCSA stopped publishing property-carrier percentiles (FAST Act, 2015), but
 * it still publishes every carrier's BASIC *measure* (SMS AB PassProperty,
 * monthly) and the raw inspections/violations behind it. A percentile is just a
 * carrier's measure ranked against its safety event group, so we rank the same
 * way FMCSA does, using its data-sufficiency rules and group boundaries.
 *
 * Measure (HOS, Driver Fitness, Vehicle Maintenance):
 *   Σ_inspections min(30, Σ severity incl. OOS weight) × time weight
 *   ÷ Σ time weights of relevant inspections
 * Time weight: 3 (≤6 months), 2 (≤12), 1 (≤24). Reproduces FMCSA's published
 * measure exactly (DOT 4321984 Vehicle Maintenance = 8).
 *
 * When the carrier has inspections newer than FMCSA's snapshot (common for new
 * authorities), the measure is recomputed on current data — but only if none of
 * those newer inspections carry violations we can't weight. Unsafe Driving and
 * Controlled Substances use FMCSA's published measure as-is (their denominators
 * aren't public). Crash Indicator and Hazmat have no public measure.
 *
 * Results are estimates and labelled so.
 */
import { socrata } from './fmcsaLeadsService';
import logger from '../utils/logger';

const SMS_RESULTS = '4y6x-dmck'; // SMS AB PassProperty — all columns TEXT (cast with ::number)
const SMS_INSPECTIONS = 'rbkj-cgst'; // SMS Input - Inspection — dot_number TEXT
const SMS_VIOLATIONS = '8mt8-2mdr'; // SMS Input - Violation — dot_number TEXT
const VEHICLE_INSPECTIONS = 'fx4q-ay7w'; // Vehicle Inspection File — dot_number NUMBER

export const PERCENTILE_MARKER = '_basicPercentiles';

type Basic = 'UD' | 'HOS' | 'DF' | 'CS' | 'VM';

interface BasicDef {
  match: RegExp; // report basicScores[].name
  violation: RegExp; // SMS basic_desc
  prefix: string; // SMS results column prefix
  relevant: 'driver' | 'vehicle' | 'withViolation';
  minRelevant: number;
  groups: Array<[number, number]>;
  recompute: boolean;
  relevantLabel: string;
}

const INF = Number.MAX_SAFE_INTEGER;
const STANDARD_GROUPS: Array<[number, number]> = [[5, 10], [11, 20], [21, 100], [101, 500], [501, INF]];

const BASICS: Record<Basic, BasicDef> = {
  UD: {
    match: /unsafe/i, violation: /unsafe/i, prefix: 'unsafe_driv', relevant: 'withViolation',
    minRelevant: 3, groups: [[3, 8], [9, 21], [22, 57], [58, 149], [150, INF]], recompute: false,
    relevantLabel: 'inspections with Unsafe Driving violations',
  },
  HOS: {
    match: /hours/i, violation: /hours/i, prefix: 'hos_driv', relevant: 'driver',
    minRelevant: 3, groups: [[3, 10], [11, 20], [21, 100], [101, 500], [501, INF]], recompute: true,
    relevantLabel: 'driver inspections',
  },
  DF: {
    match: /fitness/i, violation: /fitness/i, prefix: 'driv_fit', relevant: 'driver',
    minRelevant: 5, groups: STANDARD_GROUPS, recompute: true, relevantLabel: 'driver inspections',
  },
  CS: {
    match: /controlled|substance/i, violation: /controlled|alcohol/i, prefix: 'contr_subst', relevant: 'withViolation',
    minRelevant: 1, groups: [[1, 1], [2, 2], [3, 3], [4, INF]], recompute: false,
    relevantLabel: 'inspections with Controlled Substances violations',
  },
  VM: {
    match: /vehicle/i, violation: /vehicle/i, prefix: 'veh_maint', relevant: 'vehicle',
    minRelevant: 5, groups: STANDARD_GROUPS, recompute: true, relevantLabel: 'vehicle inspections',
  },
};

const VEHICLE_LEVELS = new Set(['1', '2', '4', '5', '6']);
const DRIVER_LEVELS = new Set(['1', '2', '3', '6']);

const num = (v: unknown) => {
  const x = parseFloat(String(v ?? ''));
  return isFinite(x) ? x : 0;
};

const MONTHS: Record<string, string> = {
  JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06',
  JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12',
};
function smsDate(v: unknown): string {
  const m = /^(\d{1,2})-([A-Z]{3})-(\d{2})$/.exec(String(v || '').toUpperCase());
  return m && MONTHS[m[2]] ? `20${m[3]}-${MONTHS[m[2]]}-${m[1].padStart(2, '0')}` : '';
}
function vifDate(v: unknown): string {
  const s = String(v || '');
  return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}` : '';
}
function timeWeight(isoDate: string, now = new Date()): number {
  const months = (now.getTime() - new Date(`${isoDate}T00:00:00Z`).getTime()) / (30.44 * 86400000);
  if (months <= 6) return 3;
  if (months <= 12) return 2;
  if (months <= 24) return 1;
  return 0;
}

export interface BasicPercentile {
  score: number | null;
  measure: number | null;
  estimated: boolean;
  basis?: 'current' | 'fmcsa_snapshot';
  peerGroupSize?: number;
  reason?: string;
}

async function rank(def: BasicDef, measure: number, relevant: number): Promise<{ percentile: number; groupSize: number } | null> {
  const group = def.groups.find(([lo, hi]) => relevant >= lo && relevant <= hi);
  if (!group) return null;
  const relCol = def.relevant === 'driver' ? 'driver_insp_total'
    : def.relevant === 'vehicle' ? 'vehicle_insp_total'
    : `${def.prefix}_insp_w_viol`;
  const inGroup = [
    `${relCol}::number >= ${group[0]}`,
    group[1] < INF ? `${relCol}::number <= ${group[1]}` : null,
    `${def.prefix}_insp_w_viol::number >= 1`,
    def.relevant === 'withViolation' ? null : `${relCol}::number >= ${def.minRelevant}`,
  ].filter(Boolean).join(' AND ');

  const [total, lower] = await Promise.all([
    socrata<any>(SMS_RESULTS, { $select: 'count(*)', $where: inGroup }, 8000),
    socrata<any>(SMS_RESULTS, { $select: 'count(*)', $where: `${inGroup} AND ${def.prefix}_measure::number < ${measure}` }, 8000),
  ]);
  const n = num(total?.[0]?.count);
  if (!n) return null;
  return { percentile: Math.round((num(lower?.[0]?.count) / n) * 1000) / 10, groupSize: n };
}

/** Estimated percentiles per BASIC for one carrier, or null if FMCSA lookups failed. */
export async function estimateBasicPercentiles(dotNumber: string): Promise<Partial<Record<Basic, BasicPercentile>> | null> {
  const dot = String(dotNumber).replace(/\D/g, '');
  if (!dot) return null;

  const [results, smsInsp, smsViol, vif] = await Promise.all([
    socrata<any>(SMS_RESULTS, { $where: `dot_number='${dot}'`, $limit: '1' }, 8000),
    socrata<any>(SMS_INSPECTIONS, { $where: `dot_number='${dot}'`, $limit: '1000' }, 8000),
    socrata<any>(SMS_VIOLATIONS, { $where: `dot_number='${dot}'`, $limit: '5000' }, 8000),
    socrata<any>(VEHICLE_INSPECTIONS, { $where: `dot_number=${dot}`, $order: 'insp_date DESC', $limit: '1000' }, 8000),
  ]);
  if (results === null && vif === null) return null;

  const row = results?.[0] || null;
  const now = new Date();

  // Inspections newer than FMCSA's snapshot, from the live inspection file.
  const lastSnapshotDate = (smsInsp || []).map((r) => smsDate(r.insp_date)).sort().pop() || '';
  const newer = (vif || []).filter((r) => vifDate(r.insp_date) > lastSnapshotDate && timeWeight(vifDate(r.insp_date), now) > 0);

  // Recomputing needs the carrier's whole 24-month history; big fleets exceed
  // what one fetch returns, so they use FMCSA's published measure instead.
  const canRecompute =
    !!smsInsp && smsInsp.length < 1000 && !!vif && vif.length < 1000 && newer.length <= 25;

  const out: Partial<Record<Basic, BasicPercentile>> = {};
  await Promise.all((Object.entries(BASICS) as Array<[Basic, BasicDef]>).map(async ([key, def]) => {
    try {
      const snapRelevant = row
        ? num(def.relevant === 'driver' ? row.driver_insp_total : def.relevant === 'vehicle' ? row.vehicle_insp_total : row[`${def.prefix}_insp_w_viol`])
        : 0;
      const snapWithViol = row ? num(row[`${def.prefix}_insp_w_viol`]) : 0;
      let measure = row ? num(row[`${def.prefix}_measure`]) : 0;
      let relevant = snapRelevant;
      let withViol = snapWithViol;
      let basis: BasicPercentile['basis'] = 'fmcsa_snapshot';

      // Recompute on current data. Inspections newer than the snapshot have
      // counts but no published severities, so they contribute a range: each
      // violation weighs 1–10 (+2 when out-of-service), capped at 30. Driver
      // violations could belong to any driver BASIC, so their low end is 0.
      let measureHigh: number | null = null;
      let uncategorized = 0; // recent driver violations FMCSA hasn't assigned a BASIC yet
      if (def.recompute && canRecompute && newer.length > 0 && smsInsp) {
        const levels = def.relevant === 'vehicle' ? VEHICLE_LEVELS : DRIVER_LEVELS;
        const relevantNewer = newer.filter((r) => levels.has(String(r.insp_level_id)));
        if (relevantNewer.length > 0) {
          const relevantSnap = smsInsp.filter((r) => levels.has(String(r.insp_level_id)));
          const sevByInsp = new Map<string, { date: string; sev: number }>();
          for (const v of smsViol || []) {
            if (!def.violation.test(String(v.basic_desc || ''))) continue;
            const cur = sevByInsp.get(v.unique_id) || { date: smsDate(v.insp_date), sev: 0 };
            cur.sev += num(v.total_severity_wght);
            sevByInsp.set(v.unique_id, cur);
          }
          let known = 0;
          for (const { date, sev } of sevByInsp.values()) known += Math.min(30, sev) * timeWeight(date, now);

          let low = 0;
          let high = 0;
          let newWithViol = 0;
          for (const r of relevantNewer) {
            const tw = timeWeight(vifDate(r.insp_date), now);
            const k = num(def.relevant === 'vehicle' ? r.vehicle_viol_total : r.driver_viol_total);
            const oos = num(def.relevant === 'vehicle' ? r.vehicle_oos_total : r.driver_oos_total);
            if (k <= 0) continue;
            newWithViol++;
            if (def.relevant !== 'vehicle') uncategorized++;
            if (def.relevant === 'vehicle') low += Math.min(30, k + 2 * oos) * tw;
            high += Math.min(30, 10 * k + 2 * oos) * tw;
          }

          const denominator =
            relevantSnap.reduce((a, r) => a + timeWeight(smsDate(r.insp_date), now), 0) +
            relevantNewer.reduce((a, r) => a + timeWeight(vifDate(r.insp_date), now), 0);
          if (denominator > 0) {
            measure = Math.round(((known + low) / denominator) * 100) / 100;
            if (high > low) measureHigh = Math.round(((known + high) / denominator) * 100) / 100;
            relevant = relevantSnap.filter((r) => timeWeight(smsDate(r.insp_date), now) > 0).length + relevantNewer.length;
            withViol = sevByInsp.size + (def.relevant === 'vehicle' ? newWithViol : 0);
            basis = 'current';
          }
        }
      }

      const sufficient = def.relevant === 'withViolation'
        ? withViol >= def.minRelevant
        : relevant >= def.minRelevant && withViol >= 1;
      if (!sufficient) {
        out[key] = {
          score: null, measure: measure || null, estimated: true, basis,
          reason: withViol === 0
            ? uncategorized > 0
              ? `No scored violations yet — ${uncategorized} recent driver inspection${uncategorized > 1 ? 's' : ''} with violations not yet categorized by FMCSA`
              : 'No violations in this category — FMCSA assigns no percentile'
            : `Not enough data: ${def.minRelevant} ${def.relevantLabel} needed, has ${def.relevant === 'withViolation' ? withViol : relevant}`,
        };
        return;
      }

      if (measure <= 0) {
        out[key] = { score: null, measure: 0, estimated: true, basis, reason: 'No recent violations — FMCSA assigns no percentile' };
        return;
      }

      const groupBy = def.relevant === 'withViolation' ? withViol : relevant;
      const [ranked, rankedHigh] = await Promise.all([
        rank(def, measure, groupBy),
        measureHigh != null ? rank(def, measureHigh, groupBy) : Promise.resolve(null),
      ]);
      if (!ranked) {
        out[key] = { score: null, measure, estimated: true, basis, reason: 'Peer group unavailable' };
      } else if (rankedHigh && rankedHigh.percentile !== ranked.percentile) {
        const mid = Math.round(((ranked.percentile + rankedHigh.percentile) / 2) * 10) / 10;
        out[key] = {
          score: mid, measure: Math.round(((measure + measureHigh!) / 2) * 100) / 100, estimated: true, basis,
          peerGroupSize: ranked.groupSize,
          reason: `Range ${ranked.percentile}–${rankedHigh.percentile}%: recent violations not yet scored by FMCSA`,
        };
      } else {
        out[key] = { score: ranked.percentile, measure, estimated: true, basis, peerGroupSize: ranked.groupSize };
      }
    } catch (err) {
      logger.warn(`BASIC percentile ${key} for DOT ${dot} failed: ${(err as Error).message}`);
    }
  }));
  return out;
}

/**
 * Fill null basicScores on a report with estimates. Mutates in place; marks the
 * report so cached copies aren't recomputed on every read. Provider-supplied
 * percentiles are never overwritten.
 */
export async function applyBasicPercentiles(report: any, dotNumber: string): Promise<boolean> {
  const scores: any[] = report?.safety?.basicScores;
  if (!Array.isArray(scores) || report[PERCENTILE_MARKER] !== undefined) return false;
  if (scores.some((b) => b.score != null)) {
    report[PERCENTILE_MARKER] = false;
    return false;
  }

  const estimates = await estimateBasicPercentiles(dotNumber);
  if (!estimates) return false; // lookup failed — try again next read
  report[PERCENTILE_MARKER] = true;

  for (const b of scores) {
    const key = (Object.keys(BASICS) as Basic[]).find((k) => BASICS[k].match.test(String(b.name || '')));
    const est = key ? estimates[key] : undefined;
    if (!est) {
      if (!key) b.reason = 'FMCSA does not publish this measure for property carriers';
      continue;
    }
    b.score = est.score;
    b.smsMeasure = est.measure;
    b.estimated = true;
    b.basis = est.basis;
    if (est.peerGroupSize) b.peerGroupSize = est.peerGroupSize;
    if (est.reason) b.reason = est.reason;
  }
  return true;
}
