import { CarrierIdentityObservation } from '../models';
import cacheService from './cacheService';
import { socrata } from './fmcsaLeadsService';
import logger from '../utils/logger';

/**
 * Chameleon Check evidence built straight from FMCSA open data (LINQ's own
 * chameleon endpoint reports EIN/equipment matching as "not yet available" and
 * its /related is empty in practice).
 *
 *  - Equipment: the carrier's roadside inspections → the VINs inspected → every
 *    other inspection of those VINs → the other DOT numbers running the same trucks.
 *  - Contact / officer / address overlap with other DOTs in the census.
 *  - Identity changes: the name/address printed on each inspection over the years,
 *    FMCSA files that disagree on phone/email/address (one was refreshed after a
 *    change), and our own record of what each earlier check saw.
 */

const INSPECTIONS = 'fx4q-ay7w'; // Vehicle Inspection File — inspection → DOT, date, carrier name/address (numeric ids)
const UNITS = 'wt8s-2hbx';       // Inspections Per Unit — inspection → VIN (inspection_id is text)
const CENSUS = 'az4n-8mr2';      // Company Census File — current identity (dot_number is numeric)
const SMS_CENSUS = 'kjg3-diqy';  // SMS census — refreshed monthly, so it lags the census
const CARRIER_AUTH = '6eyk-hxee';// Licensing carrier record — business phone/address on the docket
const AUTH_HIST = '9mw4-x3tu';   // Authority history

const CACHE_TTL = 6 * 3600;
const MAX_INSPECTIONS = 400;
const MAX_VINS = 150;
const ID_CHUNK = 100;
const VIN_CHUNK = 40;
const DOT_CHUNK = 150;
// A match list this long is a shared office building, registered agent or a
// common name, not a relationship — drop it rather than flag noise.
const MAX_MATCHES = 15;

// insp_unit_type_id: 11 truck tractor, 10 straight truck (power units); 9 semi-trailer,
// 12–14 other trailers. Trailers are pooled and interchanged, so they weigh less.
const POWER_UNIT_TYPES = new Set(['10', '11']);

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export interface IntelFlag {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  points: number;
  relatedDots?: string[];
}

export interface SharedVin {
  vin: string;
  unitType: 'power_unit' | 'trailer';
  make: string | null;
  ourFirstSeen: string;
  ourLastSeen: string;
  theirFirstSeen: string;
  theirLastSeen: string;
  // came_from: they ran it before us · went_to: after us · overlap: both at once
  relation: 'came_from' | 'went_to' | 'overlap';
}

export interface LinkedCarrier {
  dotNumber: string;
  legalName: string | null;
  status: 'active' | 'inactive' | 'unknown';
  addDate: string | null;
  location: string | null;
  powerUnits: number | null;
  reasons: string[]; // 'vin' | 'phone' | 'email' | 'officer' | 'address' | 'prior_revoke'
  sharedVins: SharedVin[];
  matchDetail: string[];
}

// One name or address the carrier went by on roadside inspections.
export interface IdentityPeriod {
  kind: 'name' | 'address';
  value: string;
  firstSeen: string;
  lastSeen: string;
  inspections: number;
}

export interface IdentityChange {
  field: string;
  from: string | null;
  to: string | null;
  source: 'inspections' | 'fmcsa_files' | 'domilea_history';
  when: string | null; // date or "between X and Y"
}

export interface ChameleonIntel {
  dotNumber: string;
  generatedAt: string;
  score: number;
  riskLevel: 'none' | 'low' | 'moderate' | 'high' | 'critical';
  flags: IntelFlag[];
  current: {
    legalName: string | null;
    dbaName: string | null;
    phone: string | null;
    cellPhone: string | null;
    fax: string | null;
    email: string | null;
    officers: string[];
    physicalAddress: string | null;
    mailingAddress: string | null;
    addDate: string | null;
    mcs150Date: string | null;
    priorRevokeDot: string | null;
  };
  linkedCarriers: LinkedCarrier[];
  identityTimeline: IdentityPeriod[];
  identityChanges: IdentityChange[];
  equipment: { vinsChecked: number; inspectionsChecked: number; truncated: boolean };
  sourcesFailed: string[];
}

// ==================== helpers ====================

const s = (v: unknown): string => (v == null ? '' : String(v).trim());
const upper = (v: unknown) => s(v).toUpperCase().replace(/\s+/g, ' ');
const digits = (v: unknown) => s(v).replace(/\D/g, '');
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
const chunk = <T,>(arr: T[], n: number) => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};
const isVin = (v: string) => /^[A-HJ-NPR-Z0-9]{17}$/.test(v) && !/^(.)\1+$/.test(v);

// YYYYMMDD → YYYY-MM-DD
function ymd(v: unknown): string {
  const d = digits(v);
  return d.length >= 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : s(v);
}

function fmtPhone(v: unknown): string | null {
  const d = digits(v).replace(/^1(?=\d{10}$)/, '');
  if (!d || /^0+$/.test(d)) return null;
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : d;
}

function address(street: unknown, city: unknown, state: unknown, zip: unknown): string | null {
  const parts = [upper(street), upper(city), [upper(state), s(zip).slice(0, 5)].filter(Boolean).join(' ')].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// Inspection text carries escape junk like "\\S8535 S 77TH AV\\S".
function cleanText(v: unknown): string {
  return upper(s(v).replace(/\\[A-Z]?/gi, ' ')).replace(/[.,]/g, '').replace(/\s+/g, ' ').trim();
}

const CORP_SUFFIX = /\b(INC|INCORPORATED|LLC|L L C|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|LP|LLP|PLLC)\b/g;

// Comparison key for a company name: no punctuation, no corporate suffix.
function nameKey(v: unknown): string {
  return cleanText(v).replace(CORP_SUFFIX, '').replace(/\s+/g, ' ').trim();
}

// Comparison key for an address: street number + zip5 ("8535 S 77TH AVE" and
// "8535 S 77TH AV" are one place). No number → no key.
function streetKey(street: unknown, zip: unknown): string {
  const num = cleanText(street).match(/\b\d+[A-Z]?\b/);
  return num ? `${num[0]}|${s(zip).slice(0, 5)}` : '';
}

function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}

// Runs async jobs a few at a time.
async function pooled<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

// ==================== service ====================

class ChameleonIntelService {
  async getIntel(dotNumber: string): Promise<ChameleonIntel | null> {
    const dot = String(parseInt(dotNumber, 10));
    if (!dot || dot === 'NaN') return null;

    const cacheKey = `chameleon:intel:v1:${dot}`;
    const cached = await cacheService.get<ChameleonIntel>(cacheKey);
    if (cached) return cached;

    const intel = await this.build(dot);
    if (intel && intel.sourcesFailed.length === 0) await cacheService.set(cacheKey, intel, CACHE_TTL);
    return intel;
  }

  private async build(dot: string): Promise<ChameleonIntel | null> {
    const failed: string[] = [];
    const track = <T,>(name: string, rows: T[] | null): T[] => {
      if (rows === null) failed.push(name);
      return rows || [];
    };

    const [censusRow] = track('census', await socrata<any>(CENSUS, { $where: `dot_number=${dot}`, $limit: '1' }));
    if (!censusRow) return null;

    const padded = dot.padStart(8, '0');
    const [smsRows, authRows, histRows, inspRows, identityRows] = await Promise.all([
      socrata<any>(SMS_CENSUS, { $where: `dot_number=${q(dot)}`, $limit: '1' }),
      socrata<any>(CARRIER_AUTH, { $where: `dot_number=${q(padded)}`, $limit: '10' }),
      socrata<any>(AUTH_HIST, { $where: `dot_number=${q(padded)}`, $limit: '200' }),
      socrata<any>(INSPECTIONS, {
        $select: 'inspection_id,insp_date',
        $where: `dot_number=${dot}`,
        $order: 'insp_date DESC',
        $limit: String(MAX_INSPECTIONS),
      }),
      // Every name/address printed on the carrier's inspections, whole history.
      socrata<any>(INSPECTIONS, {
        $select: 'insp_carrier_name,insp_carrier_street,insp_carrier_city,insp_carrier_state,insp_carrier_zip_code,min(insp_date) as first_seen,max(insp_date) as last_seen,count(*) as n',
        $where: `dot_number=${dot}`,
        $group: 'insp_carrier_name,insp_carrier_street,insp_carrier_city,insp_carrier_state,insp_carrier_zip_code',
        $limit: '1000',
      }),
    ]);
    const sms = track('sms_census', smsRows)[0];
    const auth = track('carrier_authority', authRows);
    const hist = track('authority_history', histRows);
    const inspections = track('inspections', inspRows);
    const identityVariants = track('inspection_identity', identityRows);

    const current = this.currentIdentity(censusRow);
    const flags: IntelFlag[] = [];
    const linked = new Map<string, LinkedCarrier>();
    const link = (otherDot: string, reason: string, detail?: string): LinkedCarrier => {
      let lc = linked.get(otherDot);
      if (!lc) {
        lc = { dotNumber: otherDot, legalName: null, status: 'unknown', addDate: null, location: null, powerUnits: null, reasons: [], sharedVins: [], matchDetail: [] };
        linked.set(otherDot, lc);
      }
      if (!lc.reasons.includes(reason)) lc.reasons.push(reason);
      if (detail && !lc.matchDetail.includes(detail)) lc.matchDetail.push(detail);
      return lc;
    };

    // ---------- 1. Contact / officer / address overlap ----------
    const matchJobs: Array<{ reason: string; label: string; where: string }> = [];
    const phones = [...new Set([digits(censusRow.phone), digits(censusRow.cell_phone)].filter((p) => p.length >= 10))];
    for (const p of phones) {
      matchJobs.push({ reason: 'phone', label: `Phone ${fmtPhone(p)}`, where: `phone=${q(p)} OR cell_phone=${q(p)}` });
    }
    const email = s(censusRow.email_address).toLowerCase();
    if (email.includes('@')) {
      matchJobs.push({ reason: 'email', label: `Email ${email}`, where: `lower(email_address)=${q(email)}` });
    }
    for (const officer of current.officers) {
      // A single word ("OWNER", "JOHN") matches thousands of carriers.
      if (officer.split(' ').length < 2) continue;
      matchJobs.push({ reason: 'officer', label: `Officer ${officer}`, where: `upper(company_officer_1)=${q(officer)} OR upper(company_officer_2)=${q(officer)}` });
    }
    if (s(censusRow.phy_street) && s(censusRow.phy_zip)) {
      matchJobs.push({
        reason: 'address',
        label: `Address ${upper(censusRow.phy_street)}`,
        where: `upper(phy_street)=${q(upper(censusRow.phy_street))} AND starts_with(phy_zip, ${q(s(censusRow.phy_zip).slice(0, 5))})`,
      });
    }

    const matchResults = await Promise.all(matchJobs.map((job) =>
      socrata<any>(CENSUS, { $select: 'dot_number', $where: `(${job.where}) AND dot_number != ${dot}`, $limit: String(MAX_MATCHES + 1) })
        .then((rows) => ({ job, rows }))
    ));
    const tooCommon: string[] = [];
    for (const { job, rows } of matchResults) {
      if (rows === null) { failed.push(`match_${job.reason}`); continue; }
      if (rows.length > MAX_MATCHES) { tooCommon.push(job.label); continue; }
      for (const r of rows) link(s(r.dot_number), job.reason, job.label);
    }
    if (current.priorRevokeDot) link(current.priorRevokeDot, 'prior_revoke', 'FMCSA prior-revocation link');

    // ---------- 2. Equipment (VIN) cross-reference ----------
    const ourInspDate = new Map<string, string>();
    for (const r of inspections) if (/^\d+$/.test(s(r.inspection_id))) ourInspDate.set(s(r.inspection_id), ymd(r.insp_date));

    const unitRows = (await pooled(chunk([...ourInspDate.keys()], ID_CHUNK), 4, (ids) =>
      socrata<any>(UNITS, {
        $select: 'inspection_id,insp_unit_type_id,insp_unit_make,insp_unit_vehicle_id_number',
        $where: `inspection_id in (${ids.map(q).join(',')})`,
        $limit: '5000',
      }).then((rows) => track('inspection_units', rows))
    )).flat();

    interface OurVin { type: 'power_unit' | 'trailer'; make: string | null; first: string; last: string }
    const ourVins = new Map<string, OurVin>();
    for (const u of unitRows) {
      const vin = upper(u.insp_unit_vehicle_id_number);
      const date = ourInspDate.get(s(u.inspection_id));
      if (!isVin(vin) || !date) continue;
      const v = ourVins.get(vin);
      if (v) {
        if (date < v.first) v.first = date;
        if (date > v.last) v.last = date;
      } else {
        ourVins.set(vin, {
          type: POWER_UNIT_TYPES.has(s(u.insp_unit_type_id)) ? 'power_unit' : 'trailer',
          make: s(u.insp_unit_make) || null,
          first: date,
          last: date,
        });
      }
    }
    // Most recently seen first, so a cap keeps the fleet they run today.
    const vinList = [...ourVins.entries()].sort((a, b) => b[1].last.localeCompare(a[1].last)).slice(0, MAX_VINS);
    const vinsTruncated = ourVins.size > MAX_VINS;

    const otherUnitRows = (await pooled(chunk(vinList.map(([v]) => v), VIN_CHUNK), 4, (vins) =>
      socrata<any>(UNITS, {
        $select: 'inspection_id,insp_unit_vehicle_id_number',
        $where: `insp_unit_vehicle_id_number in (${vins.map(q).join(',')})`,
        $limit: '5000',
      }).then((rows) => track('vin_lookup', rows))
    )).flat().filter((u) => !ourInspDate.has(s(u.inspection_id)));

    const vinByInspection = new Map<string, string[]>();
    for (const u of otherUnitRows) {
      const id = s(u.inspection_id);
      if (!/^\d+$/.test(id)) continue;
      const list = vinByInspection.get(id) || [];
      list.push(upper(u.insp_unit_vehicle_id_number));
      vinByInspection.set(id, list);
    }

    const otherInspections = (await pooled(chunk([...vinByInspection.keys()], ID_CHUNK), 4, (ids) =>
      socrata<any>(INSPECTIONS, {
        $select: 'inspection_id,dot_number,insp_date,insp_carrier_name',
        $where: `inspection_id in (${ids.join(',')})`,
        $limit: '5000',
      }).then((rows) => track('vin_inspections', rows))
    )).flat();

    // (other DOT, VIN) → the dates that DOT was inspected with it
    const theirs = new Map<string, { first: string; last: string; name: string }>();
    for (const r of otherInspections) {
      const otherDot = String(parseInt(s(r.dot_number), 10));
      if (!otherDot || otherDot === 'NaN' || otherDot === dot || otherDot === '0') continue;
      const date = ymd(r.insp_date);
      for (const vin of vinByInspection.get(s(r.inspection_id)) || []) {
        const key = `${otherDot}|${vin}`;
        const t = theirs.get(key);
        if (t) {
          if (date < t.first) t.first = date;
          if (date > t.last) t.last = date;
        } else {
          theirs.set(key, { first: date, last: date, name: s(r.insp_carrier_name) });
        }
      }
    }
    for (const [key, t] of theirs) {
      const [otherDot, vin] = key.split('|');
      const ours = ourVins.get(vin)!;
      const relation: SharedVin['relation'] =
        t.last < ours.first ? 'came_from' : t.first > ours.last ? 'went_to' : 'overlap';
      const lc = link(otherDot, 'vin');
      if (!lc.legalName && t.name) lc.legalName = t.name;
      lc.sharedVins.push({
        vin,
        unitType: ours.type,
        make: ours.make,
        ourFirstSeen: ours.first,
        ourLastSeen: ours.last,
        theirFirstSeen: t.first,
        theirLastSeen: t.last,
        relation,
      });
    }

    // ---------- 3. Enrich every linked DOT from the census ----------
    const linkedDots = [...linked.keys()].filter((d) => /^\d+$/.test(d));
    const enrichRows = (await pooled(chunk(linkedDots, DOT_CHUNK), 4, (dots) =>
      socrata<any>(CENSUS, {
        $select: 'dot_number,legal_name,status_code,add_date,phy_city,phy_state,power_units',
        $where: `dot_number in (${dots.join(',')})`,
        $limit: String(DOT_CHUNK),
      }).then((rows) => track('linked_census', rows))
    )).flat();
    for (const r of enrichRows) {
      const lc = linked.get(String(parseInt(s(r.dot_number), 10)));
      if (!lc) continue;
      lc.legalName = s(r.legal_name) || lc.legalName;
      lc.status = s(r.status_code) === 'A' ? 'active' : s(r.status_code) ? 'inactive' : 'unknown';
      lc.addDate = r.add_date ? ymd(r.add_date) : null;
      lc.location = [s(r.phy_city), s(r.phy_state)].filter(Boolean).join(', ') || null;
      lc.powerUnits = r.power_units != null ? parseInt(r.power_units, 10) || 0 : null;
    }

    // ---------- 4. Identity timeline & changes ----------
    const names = this.inspectionPeriods(identityVariants, 'name');
    const addresses = this.inspectionPeriods(identityVariants, 'address');
    const identityTimeline = [...names, ...addresses];
    const identityChanges: IdentityChange[] = [
      ...this.periodChanges(names, 'Company name'),
      ...this.periodChanges(addresses, 'Address'),
    ];
    identityChanges.push(...this.fileDiscrepancies(censusRow, sms, auth));
    identityChanges.push(...(await this.recordObservation(dot, censusRow, current)));

    // ---------- 5. Flags ----------
    // Most telling first: inactive, several signals, shared trucks over trailers.
    const weight = (lc: LinkedCarrier) =>
      (lc.status === 'inactive' ? 1000 : 0) + lc.reasons.length * 100 +
      lc.sharedVins.filter((v) => v.unitType === 'power_unit').length * 10 + lc.sharedVins.length;
    const linkedCarriers = [...linked.values()].sort((a, b) => weight(b) - weight(a));
    flags.push(...this.buildFlags({ dot, current, censusRow, linkedCarriers, identityChanges, hist, tooCommon }));

    const score = Math.min(100, flags.reduce((sum, f) => sum + f.points, 0));
    const riskLevel: ChameleonIntel['riskLevel'] =
      score >= 76 ? 'critical' : score >= 51 ? 'high' : score >= 26 ? 'moderate' : score > 0 ? 'low' : 'none';

    if (failed.length) logger.warn(`Chameleon intel for DOT ${dot}: sources failed ${failed.join(', ')}`);

    return {
      dotNumber: dot,
      generatedAt: new Date().toISOString(),
      score,
      riskLevel,
      flags: flags.sort((a, b) => b.points - a.points),
      current,
      linkedCarriers,
      identityTimeline,
      identityChanges,
      equipment: { vinsChecked: vinList.length, inspectionsChecked: inspections.length, truncated: vinsTruncated },
      sourcesFailed: [...new Set(failed)],
    };
  }

  private currentIdentity(c: any): ChameleonIntel['current'] {
    const prior = s(c.prior_revoke_dot_number).replace(/^0+/, '');
    return {
      legalName: s(c.legal_name) || null,
      dbaName: s(c.dba_name) || null,
      phone: fmtPhone(c.phone),
      cellPhone: fmtPhone(c.cell_phone),
      fax: fmtPhone(c.fax),
      email: s(c.email_address).toLowerCase() || null,
      officers: [...new Set([upper(c.company_officer_1), upper(c.company_officer_2)].filter(Boolean))],
      physicalAddress: address(c.phy_street, c.phy_city, c.phy_state, c.phy_zip),
      mailingAddress: address(c.carrier_mailing_street, c.carrier_mailing_city, c.carrier_mailing_state, c.carrier_mailing_zip),
      addDate: c.add_date ? ymd(c.add_date) : null,
      mcs150Date: c.mcs150_date ? ymd(c.mcs150_date) : null,
      // FMCSA often points this at the carrier's own DOT (its own earlier
      // revocation) — only a different number is a link to another carrier.
      priorRevokeDot: s(c.prior_revoke_flag) === 'Y' && prior && prior !== String(parseInt(s(c.dot_number), 10)) ? prior : null,
    };
  }

  // The names (or addresses) printed on a carrier's inspections, oldest first.
  // Roadside data entry is messy — "NOVA LINES" vs "NOVA LINES, INC.", the same
  // street under three city names — so values are compared by a normalized key
  // and rare variants of a busy carrier are treated as typos.
  private inspectionPeriods(rows: any[], kind: 'name' | 'address'): IdentityPeriod[] {
    const groups = new Map<string, IdentityPeriod & { counts: Map<string, number> }>();
    let total = 0;
    for (const r of rows) {
      const n = parseInt(r.n, 10) || 0;
      total += n;
      const value = kind === 'name'
        ? cleanText(r.insp_carrier_name)
        : address(cleanText(r.insp_carrier_street), cleanText(r.insp_carrier_city), r.insp_carrier_state, r.insp_carrier_zip_code) || '';
      const key = kind === 'name' ? nameKey(r.insp_carrier_name) : streetKey(r.insp_carrier_street, r.insp_carrier_zip_code);
      if (!key) continue; // no street number / blank name — nothing to compare
      const first = ymd(r.first_seen);
      const last = ymd(r.last_seen);
      const g = groups.get(key);
      if (g) {
        g.inspections += n;
        if (first < g.firstSeen) g.firstSeen = first;
        if (last > g.lastSeen) g.lastSeen = last;
        g.counts.set(value, (g.counts.get(value) || 0) + n);
      } else {
        groups.set(key, { kind, value, firstSeen: first, lastSeen: last, inspections: n, counts: new Map([[value, n]]) });
      }
    }
    const minShare = total >= 30 ? Math.max(2, Math.ceil(total * 0.03)) : 1;
    return [...groups.values()]
      .filter((g) => g.inspections >= minShare)
      .map(({ counts, ...g }) => ({ ...g, value: [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0] }))
      .sort((a, b) => a.firstSeen.localeCompare(b.firstSeen));
  }

  // A change is one value taking over from another — the old one stops being
  // used around when the new one starts. Values used side by side are variants.
  private periodChanges(periods: IdentityPeriod[], field: string): IdentityChange[] {
    const out: IdentityChange[] = [];
    for (let i = 1; i < periods.length; i++) {
      const prev = periods[i - 1];
      const next = periods[i];
      if (daysBetween(next.firstSeen, prev.lastSeen) <= 30) {
        const when = next.firstSeen > prev.lastSeen ? `between ${prev.lastSeen} and ${next.firstSeen}` : `around ${next.firstSeen}`;
        out.push({ field, from: prev.value, to: next.value, source: 'inspections', when });
      }
    }
    return out;
  }

  // The census, the monthly SMS census and the licensing record are refreshed on
  // different schedules — when they disagree, the carrier changed it recently.
  private fileDiscrepancies(census: any, sms: any, auth: any[]): IdentityChange[] {
    const out: IdentityChange[] = [];
    if (sms) {
      const pairs: Array<[string, string | null, string | null]> = [
        ['Phone', fmtPhone(sms.telephone), fmtPhone(census.phone)],
        ['Email', s(sms.email_address).toLowerCase() || null, s(census.email_address).toLowerCase() || null],
        ['Company name', cleanText(sms.legal_name) || null, cleanText(census.legal_name) || null],
      ];
      for (const [field, older, newer] of pairs) {
        const same = field === 'Company name' ? nameKey(older) === nameKey(newer) : older === newer;
        if (older && newer && !same) out.push({ field, from: older, to: newer, source: 'fmcsa_files', when: 'recently (FMCSA monthly file still shows the old value)' });
      }
      if (streetKey(sms.phy_street, sms.phy_zip) && streetKey(census.phy_street, census.phy_zip) &&
          streetKey(sms.phy_street, sms.phy_zip) !== streetKey(census.phy_street, census.phy_zip)) {
        out.push({
          field: 'Address',
          from: address(sms.phy_street, sms.phy_city, sms.phy_state, sms.phy_zip),
          to: address(census.phy_street, census.phy_city, census.phy_state, census.phy_zip),
          source: 'fmcsa_files',
          when: 'recently (FMCSA monthly file still shows the old value)',
        });
      }
    }
    // The licensing record keeps the phone given on the authority application.
    const authPhone = auth.map((a) => fmtPhone(a.bus_telno)).find(Boolean) || null;
    const censusPhones = [fmtPhone(census.phone), fmtPhone(census.cell_phone)].filter(Boolean);
    if (authPhone && censusPhones.length && !censusPhones.includes(authPhone) && !out.some((c) => c.field === 'Phone')) {
      out.push({ field: 'Phone', from: authPhone, to: censusPhones[0], source: 'fmcsa_files', when: 'since the operating authority was filed' });
    }
    return out;
  }

  // Store today's identity (only if it differs from the last one we saw) and
  // report what changed between earlier checks.
  private async recordObservation(dot: string, c: any, current: ChameleonIntel['current']): Promise<IdentityChange[]> {
    const snapshot = {
      dotNumber: dot,
      legalName: current.legalName,
      dbaName: current.dbaName,
      phone: current.phone,
      cellPhone: current.cellPhone,
      fax: current.fax,
      email: current.email,
      officer1: upper(c.company_officer_1) || null,
      officer2: upper(c.company_officer_2) || null,
      physicalAddress: current.physicalAddress,
      mailingAddress: current.mailingAddress,
      mcs150Date: current.mcs150Date,
    };
    try {
      const history = await CarrierIdentityObservation.findAll({ where: { dotNumber: dot }, order: [['createdAt', 'ASC']] });
      const last = history[history.length - 1];
      const fields: Array<[keyof typeof snapshot, string]> = [
        ['legalName', 'Company name'], ['phone', 'Phone'], ['cellPhone', 'Cell phone'], ['email', 'Email'],
        ['officer1', 'Officer'], ['officer2', 'Second officer'], ['physicalAddress', 'Address'], ['mailingAddress', 'Mailing address'],
      ];
      if (!last || fields.some(([f]) => (last as any)[f] !== snapshot[f]) || last.mcs150Date !== snapshot.mcs150Date) {
        history.push(await CarrierIdentityObservation.create(snapshot));
      }
      const changes: IdentityChange[] = [];
      for (let i = 1; i < history.length; i++) {
        const a = history[i - 1] as any;
        const b = history[i] as any;
        for (const [f, label] of fields) {
          if (a[f] !== b[f]) {
            changes.push({
              field: label,
              from: a[f] || null,
              to: b[f] || null,
              source: 'domilea_history',
              when: `between ${a.createdAt.toISOString().slice(0, 10)} and ${b.createdAt.toISOString().slice(0, 10)}`,
            });
          }
        }
      }
      return changes;
    } catch (error) {
      logger.warn(`Chameleon intel: identity history for DOT ${dot} failed: ${(error as Error).message}`);
      return [];
    }
  }

  private buildFlags(ctx: {
    dot: string;
    current: ChameleonIntel['current'];
    censusRow: any;
    linkedCarriers: LinkedCarrier[];
    identityChanges: IdentityChange[];
    hist: any[];
    tooCommon: string[];
  }): IntelFlag[] {
    const { current, linkedCarriers, identityChanges, hist } = ctx;
    const flags: IntelFlag[] = [];
    const label = (lc: LinkedCarrier) => `DOT ${lc.dotNumber}${lc.legalName ? ` (${lc.legalName})` : ''}`;
    const today = new Date().toISOString().slice(0, 10);

    if (current.priorRevokeDot) {
      flags.push({
        id: 'prior_revoke',
        severity: 'critical',
        title: `FMCSA links this carrier to previously revoked DOT ${current.priorRevokeDot}`,
        detail: 'FMCSA itself recorded that this registration is tied to an earlier USDOT number whose authority was revoked — the textbook chameleon pattern.',
        points: 35,
        relatedDots: [current.priorRevokeDot],
      });
    }

    // Equipment
    const withPowerUnits = linkedCarriers.filter((lc) => lc.sharedVins.some((v) => v.unitType === 'power_unit'));
    const cameFromInactive = withPowerUnits.filter((lc) => lc.status !== 'active' &&
      lc.sharedVins.some((v) => v.unitType === 'power_unit' && v.relation === 'came_from' && daysBetween(v.theirLastSeen, v.ourFirstSeen) <= 730));
    if (cameFromInactive.length) {
      flags.push({
        id: 'equipment_from_inactive',
        severity: 'high',
        title: `Trucks came over from ${cameFromInactive.length} now-inactive carrier${cameFromInactive.length > 1 ? 's' : ''}`,
        detail: `Power units this carrier runs were last inspected under ${cameFromInactive.map(label).join(', ')}, which ${cameFromInactive.length > 1 ? 'are' : 'is'} no longer active. Equipment moving from a shut-down carrier to a new DOT is the core chameleon signal.`,
        points: Math.min(35, 25 + (cameFromInactive.length - 1) * 5),
        relatedDots: cameFromInactive.map((lc) => lc.dotNumber),
      });
    }
    // Big fleets sell used trucks by the dozen — a block bought from one of them
    // is normal. From a small or shut-down carrier it's the operation moving.
    const fleetMoves = withPowerUnits.filter((lc) =>
      (lc.status !== 'active' || (lc.powerUnits ?? 0) <= 50) &&
      lc.sharedVins.filter((v) => v.unitType === 'power_unit' && v.relation === 'came_from').length >= 3);
    if (fleetMoves.length) {
      flags.push({
        id: 'fleet_transfer',
        severity: 'high',
        title: 'Several trucks moved over from the same carrier',
        detail: `3 or more power units came from ${fleetMoves.map(label).join(', ')}. One used truck is a normal purchase; a block of a single carrier's fleet usually means the same operation continuing under a new number.`,
        points: 20,
        relatedDots: fleetMoves.map((lc) => lc.dotNumber),
      });
    }
    // Same trucks passing between many small carriers: a rental/lease pool at best,
    // a network of LLCs rotating one fleet at worst.
    const smallSharers = withPowerUnits.filter((lc) => (lc.powerUnits ?? 0) <= 50);
    if (smallSharers.length >= 5) {
      flags.push({
        id: 'equipment_network',
        severity: 'medium',
        title: `Trucks shared with ${smallSharers.length} other small carriers`,
        detail: `This carrier's power units have also been inspected under ${smallSharers.length} other carriers with 50 or fewer trucks (${smallSharers.slice(0, 6).map(label).join(', ')}${smallSharers.length > 6 ? ', …' : ''}). Check whether they lease from the same fleet or are one operation spread across several authorities.`,
        points: 10,
        relatedDots: smallSharers.map((lc) => lc.dotNumber),
      });
    }
    const overlap = withPowerUnits.filter((lc) => lc.sharedVins.some((v) => v.unitType === 'power_unit' && v.relation === 'overlap'));
    if (overlap.length) {
      flags.push({
        id: 'equipment_overlap',
        severity: 'medium',
        title: `Same trucks inspected under ${overlap.length} other DOT${overlap.length > 1 ? 's' : ''} during the same period`,
        detail: `Power units were inspected under both this carrier and ${overlap.map(label).join(', ')} in overlapping periods — either undisclosed leasing or two authorities sharing one fleet.`,
        points: 15,
        relatedDots: overlap.map((lc) => lc.dotNumber),
      });
    }

    // Contact / officer / address overlap
    const byReason = (reason: string) => linkedCarriers.filter((lc) => lc.reasons.includes(reason));
    const contact = [...byReason('phone'), ...byReason('email')].filter((lc, i, arr) => arr.indexOf(lc) === i);
    if (contact.length) {
      const inactive = contact.filter((lc) => lc.status !== 'active');
      flags.push({
        id: 'shared_contact',
        severity: inactive.length ? 'high' : 'medium',
        title: `Same phone or email as ${contact.length} other DOT${contact.length > 1 ? 's' : ''}${inactive.length ? ` (${inactive.length} inactive)` : ''}`,
        detail: `Registered with contact details also used by ${contact.map(label).join(', ')}.`,
        points: inactive.length ? 20 : 10,
        relatedDots: contact.map((lc) => lc.dotNumber),
      });
    }
    const officers = byReason('officer');
    if (officers.length) {
      const inactive = officers.filter((lc) => lc.status !== 'active');
      flags.push({
        id: 'shared_officer',
        severity: inactive.length ? 'medium' : 'low',
        title: `Officer also listed on ${officers.length} other DOT${officers.length > 1 ? 's' : ''}${inactive.length ? ` (${inactive.length} inactive)` : ''}`,
        detail: `${current.officers.join(' / ')} also appear${current.officers.length > 1 ? '' : 's'} as an officer of ${officers.map(label).join(', ')}.`,
        points: inactive.length ? 15 : 5,
        relatedDots: officers.map((lc) => lc.dotNumber),
      });
    }
    const addr = byReason('address');
    if (addr.length) {
      const inactive = addr.filter((lc) => lc.status !== 'active');
      flags.push({
        id: 'shared_address',
        severity: inactive.length ? 'medium' : 'low',
        title: `Same street address as ${addr.length} other DOT${addr.length > 1 ? 's' : ''}${inactive.length ? ` (${inactive.length} inactive)` : ''}`,
        detail: `${current.physicalAddress} is also the address of ${addr.map(label).join(', ')}.`,
        points: inactive.length ? 10 : 5,
        relatedDots: addr.map((lc) => lc.dotNumber),
      });
    }

    // One match can be coincidence (a common name, a shared office); the same
    // other carrier turning up on two independent signals rarely is.
    const multi = linkedCarriers.filter((lc) => lc.reasons.length >= 2);
    if (multi.length) {
      const describe = (lc: LinkedCarrier) => `${label(lc)}: ${lc.reasons.map((r) => r === 'vin' ? 'shared trucks' : r.replace('_', ' ')).join(' + ')}`;
      flags.push({
        id: 'multi_signal_link',
        severity: multi.some((lc) => lc.status !== 'active') ? 'high' : 'medium',
        title: `${multi.length} carrier${multi.length > 1 ? 's' : ''} linked on more than one signal`,
        detail: multi.map(describe).join('; '),
        points: multi.some((lc) => lc.status !== 'active') ? 20 : 10,
        relatedDots: multi.map((lc) => lc.dotNumber),
      });
    }

    // Identity changes
    const nameChanges = identityChanges.filter((c) => c.field === 'Company name');
    if (nameChanges.length) {
      flags.push({
        id: 'name_change',
        severity: 'medium',
        title: `Company name changed ${nameChanges.length} time${nameChanges.length > 1 ? 's' : ''}`,
        detail: nameChanges.map((c) => `"${c.from}" → "${c.to}" (${c.when})`).join('; '),
        points: Math.min(20, nameChanges.length * 10),
      });
    }
    const ownerChanges = identityChanges.filter((c) => ['Phone', 'Cell phone', 'Email', 'Officer', 'Second officer'].includes(c.field));
    if (ownerChanges.length) {
      const officerChanged = ownerChanges.some((c) => c.field.includes('fficer'));
      flags.push({
        id: 'contact_change',
        severity: officerChanged ? 'high' : 'medium',
        title: officerChanged ? 'Officer / contact details changed — possible ownership change' : 'Phone or email changed recently',
        detail: ownerChanges.map((c) => `${c.field}: ${c.from || '—'} → ${c.to || '—'} (${c.when})`).join('; '),
        points: officerChanged ? 20 : 10,
      });
    }
    const addrChanges = identityChanges.filter((c) => c.field === 'Address' || c.field === 'Mailing address');
    if (addrChanges.length) {
      flags.push({
        id: 'address_change',
        severity: 'low',
        title: `Address changed ${addrChanges.length} time${addrChanges.length > 1 ? 's' : ''}`,
        detail: addrChanges.map((c) => `${c.from || '—'} → ${c.to || '—'} (${c.when})`).join('; '),
        points: Math.min(10, addrChanges.length * 5),
      });
    }

    // Recent MCS-150 — filed whenever details change, including on a sale.
    if (current.mcs150Date && daysBetween(current.mcs150Date, today) <= 90) {
      flags.push({
        id: 'recent_mcs150',
        severity: 'info',
        title: `MCS-150 updated ${current.mcs150Date}`,
        detail: 'The carrier refiled its registration in the last 90 days. Owners file an update when a company is sold or its officers change — check whether anything else changed with it.',
        points: 3,
      });
    }

    // Aged DOT with brand-new authority: a dormant registration being put back to use.
    const granted = hist
      .filter((h) => /GRANT/i.test(s(h.original_action_desc)))
      .map((h) => { const [m, d, y] = s(h.orig_served_date).split('/'); return y ? `${y}-${m}-${d}` : ''; })
      .filter(Boolean)
      .sort();
    const lastGrant = granted[granted.length - 1];
    if (lastGrant && current.addDate && daysBetween(lastGrant, today) <= 365 && daysBetween(current.addDate, lastGrant) >= 3 * 365) {
      flags.push({
        id: 'dormant_dot_new_authority',
        severity: 'medium',
        title: 'Old DOT number with newly granted authority',
        detail: `The DOT was registered ${current.addDate} but operating authority was granted ${lastGrant}. Dormant DOT numbers are bought and reactivated to look established.`,
        points: 10,
      });
    }

    const revocations = hist.filter((h) => /REVOKED/i.test(s(h.disp_action_desc)) || /REVOKED/i.test(s(h.original_action_desc))).length;
    if (revocations >= 2) {
      flags.push({
        id: 'repeat_revocations',
        severity: 'low',
        title: `Authority revoked ${revocations} times`,
        detail: 'Repeated revocations and reinstatements show a history of insurance or compliance lapses.',
        points: 5,
      });
    }

    if (ctx.tooCommon.length) {
      flags.push({
        id: 'common_identifiers',
        severity: 'info',
        title: 'Some details are shared by many carriers',
        detail: `${ctx.tooCommon.join(', ')} ${ctx.tooCommon.length > 1 ? 'are' : 'is'} on file for more than ${MAX_MATCHES} other carriers (a shared office, registered agent or common name), so ${ctx.tooCommon.length > 1 ? 'they were' : 'it was'} not used for matching.`,
        points: 0,
      });
    }

    return flags;
  }
}

/** MC docket → USDOT number, from the census (MC is docket1 on almost every carrier). */
export async function resolveMcToDot(mc: string): Promise<string | null> {
  const num = digits(mc).replace(/^0+/, '');
  if (!num) return null;
  const rows = await socrata<any>(CENSUS, {
    $select: 'dot_number',
    $where: `(docket1prefix='MC' AND docket1 in (${q(num)}, ${q(num.padStart(6, '0'))})) OR (docket2prefix='MC' AND docket2=${q(num)}) OR (docket3prefix='MC' AND docket3=${q(num)})`,
    $limit: '1',
  });
  return rows?.[0]?.dot_number ? String(parseInt(rows[0].dot_number, 10)) : null;
}

/**
 * The same intel, cut down to what an LLM needs to explain it — the full
 * payload for a carrier sharing trucks with ~100 DOTs would blow the agent's
 * tool-result budget and get truncated mid-JSON.
 */
export function summarizeIntelForAgent(intel: ChameleonIntel) {
  return {
    dotNumber: intel.dotNumber,
    legalName: intel.current.legalName,
    score: intel.score,
    riskLevel: intel.riskLevel,
    flags: intel.flags.map((f) => ({ severity: f.severity, title: f.title, detail: f.detail.slice(0, 400) })),
    current: {
      phone: intel.current.phone,
      cellPhone: intel.current.cellPhone,
      email: intel.current.email,
      officers: intel.current.officers,
      address: intel.current.physicalAddress,
      dotRegistered: intel.current.addDate,
      lastMcs150: intel.current.mcs150Date,
      priorRevokeDot: intel.current.priorRevokeDot,
    },
    linkedCarriers: {
      total: intel.linkedCarriers.length,
      top: intel.linkedCarriers.slice(0, 15).map((lc) => ({
        dotNumber: lc.dotNumber,
        legalName: lc.legalName,
        status: lc.status,
        location: lc.location,
        powerUnits: lc.powerUnits,
        linkedBy: lc.reasons,
        matchDetail: lc.matchDetail,
        sharedTrucks: lc.sharedVins.filter((v) => v.unitType === 'power_unit').length,
        sharedTrailers: lc.sharedVins.filter((v) => v.unitType === 'trailer').length,
        equipmentDirection: [...new Set(lc.sharedVins.map((v) => v.relation))],
        sampleVins: lc.sharedVins.slice(0, 3).map((v) => `${v.vin} (${v.unitType === 'power_unit' ? 'truck' : 'trailer'}, them ${v.theirFirstSeen}→${v.theirLastSeen}, this carrier ${v.ourFirstSeen}→${v.ourLastSeen})`),
      })),
    },
    identityChanges: intel.identityChanges.slice(0, 10),
    equipmentChecked: intel.equipment,
    incomplete: intel.sourcesFailed.length > 0,
  };
}

export const chameleonIntelService = new ChameleonIntelService();
export default chameleonIntelService;
