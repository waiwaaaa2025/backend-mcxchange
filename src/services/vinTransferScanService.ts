/**
 * Truck-transfer scan for the admin Chameleon Search "Truck transfers" tab:
 * new MCs running power units (by VIN) that were inspected under another
 * carrier just before — especially several trucks from one carrier that has
 * since lost its authority, insurance or a satisfactory rating. Owners who come
 * back under a new MC often change the name, address and listed officer; the
 * trucks are what they can't change, so this match ignores identity entirely
 * and then reports whether any of it matches too.
 *
 *  1. New active DOTs with an MC docket from the census (`az4n-8mr2`).
 *  2. Their roadside inspections (`fx4q-ay7w`) → the power-unit VINs on them
 *     (`wt8s-2hbx`, unit types 10 straight truck / 11 tractor).
 *  3. Every other inspection of those VINs → the DOTs that ran them earlier.
 *  4. Pairs (old DOT → new DOT) with 2+ trucks moved, enriched with the old
 *     carrier's census record and when it stopped (fmcsaShutdownInfo).
 *
 * Thousands of Socrata requests — a couple of minutes — so it runs in the
 * background like the identity scan and is kept in memory for 12 hours.
 */
import { formatPhone } from './fmcsaLeadsService';
import { getShutdownInfo, socrataRetry } from './fmcsaShutdownInfo';
import logger from '../utils/logger';

const CENSUS = 'az4n-8mr2';
const INSPECTIONS = 'fx4q-ay7w';
const UNITS = 'wt8s-2hbx';

export const TRANSFER_WINDOWS = [90, 180, 365] as const;
const SCAN_TTL_MS = 12 * 3600 * 1000;
const CONCURRENCY = 6;
const DOT_CHUNK = 300;
const ID_CHUNK = 100;
const VIN_CHUNK = 40;
const CENSUS_PAGE = 50_000;
const MIN_UNITS = 2;
// A truck last seen under the old carrier more than two years before it shows
// up under the new one is an ordinary used-truck sale.
const MAX_GAP_DAYS = 730;

const CENSUS_SELECT =
  'dot_number, legal_name, dba_name, status_code, add_date, mcs150_date, phy_street, phy_city, phy_state, phy_zip, ' +
  'phone, cell_phone, email_address, company_officer_1, company_officer_2, docket1prefix, docket1, docket1_status_code, ' +
  'power_units, classdef, safety_rating';

export interface TransferUnit {
  vin: string;
  make: string | null;
  oldFirstSeen: string;
  oldLastSeen: string;
  newFirstSeen: string;
  newLastSeen: string;
}

export interface TransferCarrier {
  dotNumber: string;
  mcNumber: string | null;
  legalName: string;
  location: string | null;
  registeredDate: string | null;
  powerUnits: number | null;
  officer: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
}

export interface TransferOldCarrier extends TransferCarrier {
  dotInactive: boolean;
  authorityInactive: boolean;
  safetyRating: string | null;
  inactiveSince: string | null;
  inactiveReason: string | null;
  insuranceCancelled: string | null;
  everAuthorized: boolean | null;
  troubles: string[]; // human-readable: "Conditional rating", "Authority revoked 2026-03-02", …
}

export interface VinTransfer {
  id: string; // `${old}>${new}`
  newCarrier: TransferCarrier;
  oldCarrier: TransferOldCarrier;
  unitCount: number;
  shareOfFleet: number | null; // moved trucks / new carrier's reported power units
  gapDays: number | null;      // old carrier's last inspection of a moved truck → new carrier's first
  sameIdentity: string[];      // 'name' | 'phone' | 'email' | 'officer' | 'address' — empty = different people on paper
  units: TransferUnit[];
  score: number;
  riskLevel: 'low' | 'moderate' | 'high' | 'critical';
}

export interface TransferScan {
  days: number;
  since: string;
  builtAt: string;
  tookMs: number;
  stats: { newCarriers: number; inspected: number; vinsChecked: number };
  transfers: VinTransfer[];
}

export interface TransferFilters {
  state?: string | null;
  q?: string | null;
  minUnits?: number;
  minScore?: number;
  troubledOnly?: boolean;  // old carrier lost authority / insurance / has C or U rating / inactive
  hiddenOnly?: boolean;    // no name, phone, email, officer or address in common
}

export type TransferStatus =
  | { status: 'ready'; scan: TransferScan }
  | { status: 'building'; startedAt: string; progress: string }
  | { status: 'failed'; error: string };

// ==================== helpers ====================

const s = (v: unknown): string => (v == null ? '' : String(v).trim());
const upper = (v: unknown) => s(v).toUpperCase().replace(/\s+/g, ' ');
const digits = (v: unknown) => s(v).replace(/\D/g, '');
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;
const dotOf = (v: unknown) => String(parseInt(s(v), 10));
const isVin = (v: string) => /^[A-HJ-NPR-Z0-9]{17}$/.test(v) && !/^(.)\1+$/.test(v);

function stamp(date: Date): string {
  return date.toISOString().slice(0, 10).replace(/-/g, '');
}
function iso(v: unknown): string | null {
  const d = digits(v);
  return d.length >= 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
}
function num(v: unknown): number | null {
  const n = parseInt(s(v), 10);
  return Number.isFinite(n) ? n : null;
}
function daysBetween(a: string, b: string): number {
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 86_400_000);
}
function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}
async function pooled<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

const CORP_SUFFIX = /\b(INC|INCORPORATED|LLC|L L C|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|LP|LLP|PLLC)\b/g;
const nameKey = (v: unknown) => upper(v).replace(/[.,'&-]/g, ' ').replace(CORP_SUFFIX, '').replace(/\s+/g, ' ').trim();
function streetKey(street: unknown, zip: unknown): string {
  const n = upper(street).match(/\b\d+[A-Z]?\b/);
  const z = s(zip).slice(0, 5);
  return n && z ? `${n[0]}|${z}` : '';
}
const officersOf = (r: any) =>
  [upper(r.company_officer_1), upper(r.company_officer_2)].map((o) => o.replace(/[.,]/g, '')).filter((o) => o.split(' ').length >= 2);

function carrierOf(r: any): TransferCarrier {
  const dot = dotOf(r.dot_number);
  const docket = s(r.docket1);
  return {
    dotNumber: dot,
    mcNumber: docket ? `${s(r.docket1prefix)}${docket}` : null,
    legalName: s(r.legal_name) || `DOT ${dot}`,
    location: [s(r.phy_city), s(r.phy_state)].filter(Boolean).join(', ') || null,
    registeredDate: iso(r.add_date),
    powerUnits: num(r.power_units),
    officer: [s(r.company_officer_1), s(r.company_officer_2)].filter(Boolean).join(' / ') || null,
    phone: formatPhone(r.phone),
    email: s(r.email_address).toLowerCase() || null,
    address: [upper(r.phy_street), upper(r.phy_city), [upper(r.phy_state), s(r.phy_zip).slice(0, 5)].filter(Boolean).join(' ')]
      .filter(Boolean).join(', ') || null,
  };
}

function sameIdentity(a: any, b: any): string[] {
  const out: string[] = [];
  const nk = nameKey(a.legal_name);
  if (nk.length >= 4 && (nk === nameKey(b.legal_name) || nk === nameKey(b.dba_name))) out.push('name');
  const phonesA = [digits(a.phone), digits(a.cell_phone)].filter((p) => p.length >= 10);
  const phonesB = [digits(b.phone), digits(b.cell_phone)].filter((p) => p.length >= 10);
  if (phonesA.some((p) => phonesB.includes(p))) out.push('phone');
  const email = s(a.email_address).toLowerCase();
  if (email.includes('@') && email === s(b.email_address).toLowerCase()) out.push('email');
  const offB = officersOf(b);
  if (officersOf(a).some((o) => offB.includes(o))) out.push('officer');
  const sk = streetKey(a.phy_street, a.phy_zip);
  if (sk && sk === streetKey(b.phy_street, b.phy_zip)) out.push('address');
  return out;
}

// ==================== service ====================

class VinTransferScanService {
  private running = new Map<number, { startedAt: string; progress: string }>();
  private failures = new Map<number, string>();
  private scans = new Map<number, TransferScan>();

  normalizeDays(days: unknown): number {
    const d = parseInt(s(days), 10);
    return (TRANSFER_WINDOWS as readonly number[]).includes(d) ? d : 180;
  }

  async get(daysInput: unknown, force = false): Promise<TransferStatus> {
    const days = this.normalizeDays(daysInput);
    const job = this.running.get(days);
    if (job) return { status: 'building', ...job };
    if (!force) {
      const cached = this.cached(days);
      if (cached) return { status: 'ready', scan: cached };
      if (this.failures.has(days)) {
        const error = this.failures.get(days)!;
        this.failures.delete(days); // next poll retries
        return { status: 'failed', error };
      }
    }
    this.start(days);
    return { status: 'building', ...this.running.get(days)! };
  }

  cached(days: number): TransferScan | null {
    const scan = this.scans.get(days);
    if (!scan || Date.now() - new Date(scan.builtAt).getTime() > SCAN_TTL_MS) return null;
    return scan;
  }

  filter(scan: TransferScan, f: TransferFilters): VinTransfer[] {
    const state = f.state ? f.state.trim().toUpperCase() : '';
    const needle = f.q ? f.q.trim().toUpperCase() : '';
    const needleDigits = digits(needle);
    return scan.transfers.filter((t) => {
      if (t.unitCount < (f.minUnits ?? MIN_UNITS)) return false;
      if (t.score < (f.minScore ?? 0)) return false;
      if (state && !(t.newCarrier.location || '').endsWith(`, ${state}`)) return false;
      if (f.troubledOnly && t.oldCarrier.troubles.length === 0) return false;
      if (f.hiddenOnly && t.sameIdentity.length > 0) return false;
      if (needle) {
        const names = `${t.newCarrier.legalName} ${t.oldCarrier.legalName}`.toUpperCase();
        const numbers = [t.newCarrier.dotNumber, t.oldCarrier.dotNumber, digits(t.newCarrier.mcNumber), digits(t.oldCarrier.mcNumber)];
        const vinHit = t.units.some((u) => u.vin.includes(needle));
        if (!names.includes(needle) && !(needleDigits && numbers.includes(needleDigits)) && !vinHit) return false;
      }
      return true;
    });
  }

  private start(days: number) {
    const job = { startedAt: new Date().toISOString(), progress: 'Starting…' };
    this.running.set(days, job);
    this.build(days, (p) => { job.progress = p; })
      .then((scan) => {
        this.scans.set(days, scan);
        logger.info(`VIN transfer scan ${days}d: ${scan.transfers.length} transfers in ${scan.tookMs}ms`);
      })
      .catch((error: Error) => {
        logger.warn(`VIN transfer scan ${days}d failed: ${error.message}`);
        this.failures.set(days, error.message);
      })
      .finally(() => this.running.delete(days));
  }

  private async build(days: number, progress: (p: string) => void): Promise<TransferScan> {
    const t0 = Date.now();
    const sinceStamp = stamp(new Date(Date.now() - days * 86_400_000));
    const must = <T,>(name: string, rows: T[] | null): T[] => {
      if (rows === null) throw new Error(`FMCSA query failed (${name}) — try again shortly`);
      return rows;
    };

    // ---------- 1. New carriers with an MC ----------
    progress('Loading new carriers…');
    const newRows: any[] = [];
    for (let offset = 0; ; offset += CENSUS_PAGE) {
      const page = must('new_carriers', await socrataRetry<any>(CENSUS, {
        $select: CENSUS_SELECT,
        $where: `add_date >= '${sinceStamp}' AND status_code='A' AND docket1 IS NOT NULL`,
        $order: 'dot_number',
        $offset: String(offset),
        $limit: String(CENSUS_PAGE),
      }, 120_000));
      newRows.push(...page);
      if (page.length < CENSUS_PAGE) break;
    }
    const newByDot = new Map(newRows.map((r) => [dotOf(r.dot_number), r]));

    // ---------- 2. Their inspections → power-unit VINs ----------
    progress(`Finding inspections for ${newByDot.size.toLocaleString()} new carriers…`);
    const ourInspections = new Map<string, { dot: string; date: string }>();
    const inspChunks = chunks([...newByDot.keys()], DOT_CHUNK);
    await pooled(inspChunks, CONCURRENCY, async (part) => {
      const rows = must('new_inspections', await socrataRetry<any>(INSPECTIONS, {
        $select: 'inspection_id, dot_number, insp_date',
        $where: `dot_number in (${part.join(',')})`,
        $limit: '50000',
      }));
      for (const r of rows) {
        const id = s(r.inspection_id);
        if (/^\d+$/.test(id)) ourInspections.set(id, { dot: dotOf(r.dot_number), date: iso(r.insp_date) || '' });
      }
    });

    progress(`Reading trucks on ${ourInspections.size.toLocaleString()} inspections…`);
    // new DOT|VIN → when the new carrier ran it
    const newVins = new Map<string, { dot: string; vin: string; make: string | null; first: string; last: string }>();
    await pooled(chunks([...ourInspections.keys()], ID_CHUNK), CONCURRENCY, async (ids) => {
      const rows = must('new_units', await socrataRetry<any>(UNITS, {
        $select: 'inspection_id, insp_unit_make, insp_unit_vehicle_id_number',
        $where: `inspection_id in (${ids.map(q).join(',')}) AND insp_unit_type_id in ('10','11')`,
        $limit: '5000',
      }));
      for (const u of rows) {
        const vin = upper(u.insp_unit_vehicle_id_number);
        const insp = ourInspections.get(s(u.inspection_id));
        if (!isVin(vin) || !insp?.date) continue;
        const key = `${insp.dot}|${vin}`;
        const v = newVins.get(key);
        if (v) {
          if (insp.date < v.first) v.first = insp.date;
          if (insp.date > v.last) v.last = insp.date;
        } else {
          newVins.set(key, { dot: insp.dot, vin, make: s(u.insp_unit_make) || null, first: insp.date, last: insp.date });
        }
      }
    });

    // ---------- 3. Everywhere else those VINs were inspected ----------
    const vinList = [...new Set([...newVins.values()].map((v) => v.vin))];
    progress(`Tracing ${vinList.length.toLocaleString()} trucks through inspection history…`);
    const otherVinsByInspection = new Map<string, string[]>();
    await pooled(chunks(vinList, VIN_CHUNK), CONCURRENCY, async (vins) => {
      const rows = must('vin_lookup', await socrataRetry<any>(UNITS, {
        $select: 'inspection_id, insp_unit_vehicle_id_number',
        $where: `insp_unit_vehicle_id_number in (${vins.map(q).join(',')})`,
        $limit: '10000',
      }));
      for (const u of rows) {
        const id = s(u.inspection_id);
        if (!/^\d+$/.test(id) || ourInspections.has(id)) continue;
        const list = otherVinsByInspection.get(id) || [];
        list.push(upper(u.insp_unit_vehicle_id_number));
        otherVinsByInspection.set(id, list);
      }
    });

    progress(`Matching ${otherVinsByInspection.size.toLocaleString()} earlier inspections to carriers…`);
    // old DOT|VIN → when the old carrier ran it
    const oldVins = new Map<string, { first: string; last: string }>();
    await pooled(chunks([...otherVinsByInspection.keys()], ID_CHUNK), CONCURRENCY, async (ids) => {
      const rows = must('vin_inspections', await socrataRetry<any>(INSPECTIONS, {
        $select: 'inspection_id, dot_number, insp_date',
        $where: `inspection_id in (${ids.join(',')})`,
        $limit: '5000',
      }));
      for (const r of rows) {
        const dot = dotOf(r.dot_number);
        const date = iso(r.insp_date);
        if (!date || dot === 'NaN' || dot === '0') continue;
        for (const vin of otherVinsByInspection.get(s(r.inspection_id)) || []) {
          const key = `${dot}|${vin}`;
          const v = oldVins.get(key);
          if (v) {
            if (date < v.first) v.first = date;
            if (date > v.last) v.last = date;
          } else {
            oldVins.set(key, { first: date, last: date });
          }
        }
      }
    });

    // ---------- 4. Pairs: trucks that came from the old DOT to the new one ----------
    const newByVin = new Map<string, Array<{ dot: string; make: string | null; first: string; last: string }>>();
    for (const v of newVins.values()) {
      const list = newByVin.get(v.vin) || [];
      list.push(v);
      newByVin.set(v.vin, list);
    }
    const pairs = new Map<string, TransferUnit[]>(); // "old>new"
    for (const [key, old] of oldVins) {
      const [oldDot, vin] = key.split('|');
      for (const nv of newByVin.get(vin) || []) {
        if (nv.dot === oldDot || old.last >= nv.first) continue; // only trucks the old carrier ran first
        if (daysBetween(old.last, nv.first) > MAX_GAP_DAYS) continue;
        const pairKey = `${oldDot}>${nv.dot}`;
        const list = pairs.get(pairKey) || [];
        list.push({ vin, make: nv.make, oldFirstSeen: old.first, oldLastSeen: old.last, newFirstSeen: nv.first, newLastSeen: nv.last });
        pairs.set(pairKey, list);
      }
    }
    const kept = [...pairs.entries()].filter(([, units]) => units.length >= MIN_UNITS);

    // ---------- 5. Who the old carriers are ----------
    const oldDots = [...new Set(kept.map(([k]) => k.split('>')[0]))];
    progress(`Checking ${oldDots.length.toLocaleString()} carriers the trucks came from…`);
    const oldByDot = new Map<string, any>();
    await pooled(chunks(oldDots, 150), CONCURRENCY, async (part) => {
      const rows = must('old_carriers', await socrataRetry<any>(CENSUS, {
        $select: CENSUS_SELECT,
        $where: `dot_number in (${part.join(',')})`,
        $limit: '5000',
      }));
      for (const r of rows) oldByDot.set(dotOf(r.dot_number), r);
    });
    const shutdown = await getShutdownInfo(oldDots);

    // ---------- 6. Score ----------
    const transfers: VinTransfer[] = [];
    for (const [pairKey, units] of kept) {
      const [oldDot, newDot] = pairKey.split('>');
      const nr = newByDot.get(newDot);
      const or = oldByDot.get(oldDot);
      if (!nr || !or) continue;
      const info = shutdown.get(oldDot);
      const rating = s(or.safety_rating) || null;
      const dotInactive = s(or.status_code) !== 'A';
      const authorityInactive = (!!s(or.docket1) && s(or.docket1_status_code) === 'I') || !!info?.authorityEnded;
      const oldPU = num(or.power_units);

      const troubles: string[] = [];
      if (rating === 'U') troubles.push('Unsatisfactory rating');
      if (rating === 'C') troubles.push('Conditional rating');
      if (info?.authorityEnded) troubles.push(`${info.authorityEnded.action} ${info.authorityEnded.date}`);
      else if (authorityInactive) troubles.push('Authority inactive');
      if (info?.insuranceCancelled) troubles.push(`Insurance cancelled ${info.insuranceCancelled}`);
      if (dotInactive) troubles.push('USDOT inactive');

      // A big, healthy fleet selling used trucks is business as usual.
      if (!troubles.length && (oldPU ?? 0) > 50) continue;

      units.sort((a, b) => a.newFirstSeen.localeCompare(b.newFirstSeen));
      const gapDays = Math.min(...units.map((u) => daysBetween(u.oldLastSeen, u.newFirstSeen)));
      const newPU = num(nr.power_units);
      const share = newPU && newPU > 0 ? Math.min(1, units.length / newPU) : null;
      const identity = sameIdentity(nr, or);

      let score = units.length >= 5 ? 40 : units.length >= 3 ? 30 : 20;
      if (rating === 'U') score += 25;
      else if (rating === 'C') score += 15;
      if (authorityInactive) score += 15;
      if (info?.insuranceCancelled) score += 10;
      if (dotInactive) score += 10;
      if (gapDays <= 90) score += 10;
      if (share != null && share >= 0.5) score += 10;
      if (identity.length) score += 5;
      // Small active carrier, no trouble: likely a plain sale between owner-operators.
      if (!troubles.length) score -= 15;
      score = Math.max(0, Math.min(100, score));

      transfers.push({
        id: pairKey,
        newCarrier: carrierOf(nr),
        oldCarrier: {
          ...carrierOf(or),
          dotInactive,
          authorityInactive,
          safetyRating: rating,
          inactiveSince: info?.inactiveSince || null,
          inactiveReason: info?.inactiveReason || null,
          insuranceCancelled: info?.insuranceCancelled || null,
          everAuthorized: info?.everAuthorized ?? null,
          troubles,
        },
        unitCount: units.length,
        shareOfFleet: share,
        gapDays,
        sameIdentity: identity,
        units,
        score,
        riskLevel: score >= 70 ? 'critical' : score >= 45 ? 'high' : score >= 25 ? 'moderate' : 'low',
      });
    }
    transfers.sort((a, b) => b.score - a.score || b.unitCount - a.unitCount);

    return {
      days,
      since: iso(sinceStamp)!,
      builtAt: new Date().toISOString(),
      tookMs: Date.now() - t0,
      stats: { newCarriers: newByDot.size, inspected: ourInspections.size, vinsChecked: vinList.length },
      transfers,
    };
  }
}

export const vinTransferScanService = new VinTransferScanService();
export default vinTransferScanService;
