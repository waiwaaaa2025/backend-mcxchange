/**
 * Bulk chameleon search for the admin "Chameleon Search" page: every recently
 * registered, active carrier that looks like a shut-down carrier coming back
 * under a new USDOT number.
 *
 * The per-DOT Chameleon Check (chameleonIntelService) also follows VINs through
 * roadside inspections, which takes seconds per carrier — far too slow for the
 * whole census. This scan uses only what the FMCSA Company Census (`az4n-8mr2`)
 * can answer in bulk:
 *
 *  1. Grouped queries find every phone / email / officer shared by 2–15 DOTs,
 *     at least one of them shut down and at least one registered in the window.
 *  2. The members of those groups are fetched, and each new active DOT is linked
 *     to every older shut-down DOT it shares something with. Name and address
 *     are compared on the fetched rows to corroborate a link.
 *  3. FMCSA's own prior-revocation link (`prior_revoke_dot_number`) is added.
 *
 * A full scan is ~1 minute (Heroku cuts requests at 30s), so it runs in the
 * background and the result is kept in memory (a year's scan is ~15 MB — too
 * big for Redis); the page polls until it's ready.
 * Measured 2026-10-07: 180-day window → ~6,300 linked new DOTs in ~40s for
 * phone + email alone.
 */
import { socrata, formatPhone } from './fmcsaLeadsService';
import { getShutdownInfo } from './fmcsaShutdownInfo';
import logger from '../utils/logger';

const CENSUS = 'az4n-8mr2';
const SCAN_TTL_MS = 12 * 3600 * 1000;
export const SCAN_WINDOWS = [30, 90, 180, 365] as const;
// A value shared by more DOTs than this is a filing agent, a shared office or a
// common name, not a relationship.
const MAX_GROUP = 15;
const VALUE_CHUNK = 150;
const CONCURRENCY = 6;
const MIN_SCORE = 15;
const MAX_LINKS = 6;

const MEMBER_SELECT =
  'dot_number, legal_name, dba_name, status_code, add_date, mcs150_date, phy_street, phy_city, phy_state, phy_zip, ' +
  'phone, cell_phone, email_address, company_officer_1, company_officer_2, docket1prefix, docket1, docket1_status_code, ' +
  'power_units, total_drivers, classdef, safety_rating, prior_revoke_flag, prior_revoke_dot_number';

type GroupField = 'phone' | 'email_address' | 'company_officer_1';
export type LinkReason = 'prior_revoke' | 'phone' | 'email' | 'officer' | 'name' | 'address';

// Points per shared signal on one link. Phone/email/officer find the link; name
// and address only ever corroborate one.
const REASON_POINTS: Record<LinkReason, number> = {
  prior_revoke: 40,
  phone: 25,
  email: 25,
  name: 25,
  officer: 15,
  address: 10,
};

export interface ScanLink {
  dotNumber: string;
  mcNumber: string | null;
  legalName: string;
  location: string | null;
  registeredDate: string | null;
  powerUnits: number | null;
  dotInactive: boolean;       // USDOT status not active
  authorityInactive: boolean; // MC docket inactive (revoked / lapsed)
  safetyRating: string | null; // S / C / U
  lastActive: string | null;   // latest of its registration / last MCS-150
  inactiveSince: string | null; // authority revoked / insurance cancelled date
  inactiveReason: string | null;
  insuranceCancelled: string | null;
  everAuthorized: boolean | null; // false = only ever applied (dismissed/withdrawn), never had authority
  reasons: LinkReason[];
}

export interface ScanCandidate {
  dotNumber: string;
  mcNumber: string | null;
  legalName: string;
  dbaName: string | null;
  city: string | null;
  state: string | null;
  registeredDate: string | null;
  mcs150Date: string | null;
  powerUnits: number | null;
  drivers: number | null;
  forHire: boolean;
  officer: string | null;
  phone: string | null;
  email: string | null;
  score: number;
  riskLevel: 'low' | 'moderate' | 'high' | 'critical';
  reasons: LinkReason[]; // union over links
  links: ScanLink[];     // strongest first
  // The same company back under a new DOT/MC: which old DOT, and on what basis.
  reRegistered: { dotNumber: string; basis: string } | null;
}

export interface ScanResult {
  days: number;
  since: string;
  builtAt: string;
  tookMs: number;
  dataThrough: string | null;
  candidates: ScanCandidate[];
}

export interface ScanFilters {
  state?: string | null;
  q?: string | null;           // name, DOT or MC
  minScore?: number;
  reason?: LinkReason | null;
  forHireOnly?: boolean;
  withMcOnly?: boolean;
  multiSignalOnly?: boolean;   // at least one link on 2+ signals
  reRegisteredOnly?: boolean;
  authorizedOnly?: boolean;    // re-registered from an MC that actually held authority
}

export type ScanStatus =
  | { status: 'ready'; scan: ScanResult }
  | { status: 'building'; startedAt: string }
  | { status: 'failed'; error: string };

// ==================== helpers ====================

const s = (v: unknown): string => (v == null ? '' : String(v).trim());
const upper = (v: unknown) => s(v).toUpperCase().replace(/\s+/g, ' ');
const digits = (v: unknown) => s(v).replace(/\D/g, '');
const q = (v: string) => `'${v.replace(/'/g, "''")}'`;

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

const CORP_SUFFIX = /\b(INC|INCORPORATED|LLC|L L C|CORP|CORPORATION|CO|COMPANY|LTD|LIMITED|LP|LLP|PLLC)\b/g;
function nameKey(v: unknown): string {
  return upper(v).replace(/[.,'&-]/g, ' ').replace(CORP_SUFFIX, '').replace(/\s+/g, ' ').trim();
}

// Street number + zip5 — "123 MAIN ST" and "123 MAIN STREET" are one place.
function streetKey(street: unknown, zip: unknown): string {
  const n = upper(street).match(/\b\d+[A-Z]?\b/);
  const z = s(zip).slice(0, 5);
  return n && z ? `${n[0]}|${z}` : '';
}

// One word ("OWNER", "JOHN") or a title matches thousands of carriers.
function usableOfficer(v: unknown): string {
  const o = upper(v).replace(/[.,]/g, '');
  if (o.split(' ').length < 2) return '';
  if (/^(THE )?(OWNER|PRESIDENT|MANAGER|MEMBER|CEO|DIRECTOR|N\/?A|NONE)\b/.test(o)) return '';
  return o;
}

function mcOf(r: any): string | null {
  const docket = s(r.docket1);
  return docket ? `${s(r.docket1prefix)}${docket}` : null;
}

// Shut down: USDOT inactive, or the operating authority is no longer active.
function isShutDown(r: any): boolean {
  return s(r.status_code) !== 'A' || (!!s(r.docket1) && s(r.docket1_status_code) === 'I');
}

async function pooled<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return out;
}

/**
 * The same company back under a new number: same name (or FMCSA's own revoke
 * link, or the same officer with the same phone/email) as a carrier that has
 * stopped. Newest stop first, since that's the one it replaced.
 */
function reRegistration(links: ScanLink[]): ScanCandidate['reRegistered'] {
  const basisOf = (l: ScanLink): string | null => {
    if (l.reasons.includes('prior_revoke')) return 'FMCSA revocation link';
    if (l.reasons.includes('name')) return 'Same company name';
    if (l.reasons.includes('officer') && (l.reasons.includes('phone') || l.reasons.includes('email'))) return 'Same officer and contact';
    return null;
  };
  const match = links
    .filter((l) => basisOf(l) && (l.dotInactive || l.authorityInactive || l.inactiveSince))
    .sort((a, b) => (b.inactiveSince || b.lastActive || '').localeCompare(a.inactiveSince || a.lastActive || ''))[0];
  return match ? { dotNumber: match.dotNumber, basis: basisOf(match)! } : null;
}

// ==================== service ====================

class ChameleonScanService {
  private running = new Map<number, { startedAt: string; promise: Promise<ScanResult | null> }>();
  private failures = new Map<number, string>();
  private scans = new Map<number, ScanResult>();

  normalizeDays(days: unknown): number {
    const d = parseInt(s(days), 10);
    return (SCAN_WINDOWS as readonly number[]).includes(d) ? d : 180;
  }

  /** The cached scan, or kicks one off in the background and says so. */
  async get(daysInput: unknown, force = false): Promise<ScanStatus> {
    const days = this.normalizeDays(daysInput);
    // A rescan in progress wins over the old result, so polls wait for the new one.
    const job = this.running.get(days);
    if (job) return { status: 'building', startedAt: job.startedAt };
    if (!force) {
      const cached = await this.cached(days);
      if (cached) return { status: 'ready', scan: cached };
    }
    if (!force && this.failures.has(days)) {
      const error = this.failures.get(days)!;
      this.failures.delete(days); // next poll retries
      return { status: 'failed', error };
    }
    this.start(days);
    return { status: 'building', startedAt: this.running.get(days)!.startedAt };
  }

  /** The kept scan if it's still fresh — never starts one. */
  async cached(days: number): Promise<ScanResult | null> {
    const scan = this.scans.get(days);
    if (!scan || Date.now() - new Date(scan.builtAt).getTime() > SCAN_TTL_MS) return null;
    return scan;
  }

  filter(scan: ScanResult, f: ScanFilters): ScanCandidate[] {
    const state = f.state ? f.state.trim().toUpperCase() : '';
    const needle = f.q ? f.q.trim().toUpperCase() : '';
    const needleDigits = digits(needle);
    const minScore = f.minScore ?? 0;
    return scan.candidates.filter((c) => {
      if (c.score < minScore) return false;
      if (state && c.state !== state) return false;
      if (f.forHireOnly && !c.forHire) return false;
      if (f.withMcOnly && !c.mcNumber) return false;
      if (f.reason && !c.reasons.includes(f.reason)) return false;
      if (f.multiSignalOnly && !c.links.some((l) => l.reasons.length >= 2)) return false;
      if (f.reRegisteredOnly && !c.reRegistered) return false;
      if (f.authorizedOnly && c.links.find((l) => l.dotNumber === c.reRegistered?.dotNumber)?.everAuthorized !== true) return false;
      if (needle) {
        const byName = c.legalName.toUpperCase().includes(needle) || (c.dbaName || '').toUpperCase().includes(needle);
        const byNumber = !!needleDigits && needleDigits === needle.replace(/^(MC|DOT|USDOT)\s*#?/, '') &&
          (c.dotNumber === needleDigits || digits(c.mcNumber) === needleDigits ||
            c.links.some((l) => l.dotNumber === needleDigits || digits(l.mcNumber) === needleDigits));
        if (!byName && !byNumber) return false;
      }
      return true;
    });
  }

  private start(days: number) {
    const startedAt = new Date().toISOString();
    const promise = this.build(days)
      .then((scan) => {
        this.scans.set(days, scan);
        logger.info(`Chameleon scan ${days}d: ${scan.candidates.length} candidates in ${scan.tookMs}ms`);
        return scan;
      })
      .catch((error: Error) => {
        logger.warn(`Chameleon scan ${days}d failed: ${error.message}`);
        this.failures.set(days, error.message);
        return null;
      })
      .finally(() => this.running.delete(days));
    this.running.set(days, { startedAt, promise });
  }

  private async build(days: number): Promise<ScanResult> {
    const t0 = Date.now();
    const sinceStamp = stamp(new Date(Date.now() - days * 86_400_000));
    const must = <T,>(name: string, rows: T[] | null): T[] => {
      // A partial scan would silently miss carriers — fail it and let the admin retry.
      if (rows === null) throw new Error(`FMCSA census query failed (${name}) — try again shortly`);
      return rows;
    };

    // ---------- 1. Shared identifiers ----------
    const fields: GroupField[] = ['phone', 'email_address', 'company_officer_1'];
    const groups = await Promise.all(fields.map(async (field) => {
      const rows = must(`group_${field}`, await socrata<any>(CENSUS, {
        $select: `${field}, count(*) AS n, sum(case(status_code='A' AND (docket1_status_code IS NULL OR docket1_status_code != 'I'), 0, true, 1)) AS shut, max(add_date) AS newest`,
        $where: `${field} IS NOT NULL AND ${field} != ''`,
        $group: field,
        $having: `n BETWEEN 2 AND ${MAX_GROUP} AND shut >= 1 AND newest >= '${sinceStamp}'`,
        $limit: '50000',
      }, 120_000));
      let values = rows.map((r) => s(r[field])).filter(Boolean);
      if (field === 'phone') values = values.filter((v) => digits(v).length >= 10 && !/^(\d)\1+$/.test(digits(v)));
      if (field === 'company_officer_1') values = values.filter((v) => usableOfficer(v));
      return { field, values };
    }));

    const priorRevoke = must('prior_revoke', await socrata<any>(CENSUS, {
      $select: MEMBER_SELECT,
      $where: `prior_revoke_flag='Y' AND status_code='A' AND add_date >= '${sinceStamp}'`,
      $limit: '5000',
    }));

    // ---------- 2. Members of every group ----------
    const jobs: Array<{ field: GroupField; values: string[] }> = [];
    for (const g of groups) {
      for (let i = 0; i < g.values.length; i += VALUE_CHUNK) jobs.push({ field: g.field, values: g.values.slice(i, i + VALUE_CHUNK) });
    }
    const memberRows = (await pooled(jobs, CONCURRENCY, async (job) =>
      must(`members_${job.field}`, await socrata<any>(CENSUS, {
        $select: MEMBER_SELECT,
        $where: `${job.field} in (${job.values.map(q).join(',')})`,
        $limit: '5000',
      }, 60_000))
    )).flat();

    const rowsByDot = new Map<string, any>();
    for (const r of [...memberRows, ...priorRevoke]) rowsByDot.set(String(parseInt(s(r.dot_number), 10)), r);

    // FMCSA's prior-revoke DOTs we haven't fetched yet.
    const ownDot = (r: any) => String(parseInt(s(r.dot_number), 10));
    const revokedDots = [...new Set(priorRevoke
      .map((r) => String(parseInt(s(r.prior_revoke_dot_number), 10)))
      .filter((d, i) => d !== 'NaN' && d !== ownDot(priorRevoke[i]) && !rowsByDot.has(d)))];
    for (let i = 0; i < revokedDots.length; i += VALUE_CHUNK) {
      const rows = must('prior_revoke_targets', await socrata<any>(CENSUS, {
        $select: MEMBER_SELECT,
        $where: `dot_number in (${revokedDots.slice(i, i + VALUE_CHUNK).join(',')})`,
        $limit: '5000',
      }));
      for (const r of rows) rowsByDot.set(ownDot(r), r);
    }

    // ---------- 3. Link new active DOTs to older shut-down DOTs ----------
    const clusters = new Map<string, string[]>(); // "field|value" → DOTs
    const addTo = (key: string, dot: string) => {
      const list = clusters.get(key) || [];
      if (!list.includes(dot)) list.push(dot);
      clusters.set(key, list);
    };
    for (const [dot, r] of rowsByDot) {
      const phone = digits(r.phone);
      if (phone.length >= 10) addTo(`phone|${phone}`, dot);
      const cell = digits(r.cell_phone);
      if (cell.length >= 10) addTo(`phone|${cell}`, dot);
      const email = s(r.email_address).toLowerCase();
      if (email.includes('@')) addTo(`email|${email}`, dot);
      for (const o of [usableOfficer(r.company_officer_1), usableOfficer(r.company_officer_2)]) if (o) addTo(`officer|${o}`, dot);
    }

    const isNew = (r: any) => s(r.status_code) === 'A' && s(r.add_date) >= sinceStamp && !isShutDown(r);
    const links = new Map<string, Map<string, Set<LinkReason>>>(); // new DOT → old DOT → reasons
    const link = (newDot: string, oldDot: string, reason: LinkReason) => {
      let m = links.get(newDot);
      if (!m) links.set(newDot, (m = new Map()));
      let set = m.get(oldDot);
      if (!set) m.set(oldDot, (set = new Set()));
      set.add(reason);
    };

    for (const [key, dots] of clusters) {
      if (dots.length < 2 || dots.length > MAX_GROUP) continue;
      const reason = key.slice(0, key.indexOf('|')) as LinkReason;
      for (const newDot of dots) {
        const nr = rowsByDot.get(newDot);
        if (!isNew(nr)) continue;
        for (const oldDot of dots) {
          const or = rowsByDot.get(oldDot);
          // The old carrier must be shut down and must predate the new one.
          if (oldDot === newDot || !isShutDown(or) || s(or.add_date) > s(nr.add_date)) continue;
          link(newDot, oldDot, reason);
        }
      }
    }
    for (const r of priorRevoke) {
      const newDot = ownDot(r);
      const oldDot = String(parseInt(s(r.prior_revoke_dot_number), 10));
      if (oldDot !== 'NaN' && oldDot !== newDot && isNew(r) && rowsByDot.has(oldDot)) link(newDot, oldDot, 'prior_revoke');
    }

    // Name and address corroborate a link found above.
    for (const [newDot, m] of links) {
      const nr = rowsByDot.get(newDot);
      for (const [oldDot, reasons] of m) {
        const or = rowsByDot.get(oldDot);
        const nk = nameKey(nr.legal_name);
        if (nk && nk.length >= 4 && (nk === nameKey(or.legal_name) || nk === nameKey(or.dba_name))) reasons.add('name');
        const sk = streetKey(nr.phy_street, nr.phy_zip);
        if (sk && sk === streetKey(or.phy_street, or.phy_zip)) reasons.add('address');
      }
    }

    // When each old carrier stopped (authority revoked / insurance cancelled).
    const oldDots = new Set<string>();
    for (const m of links.values()) for (const d of m.keys()) oldDots.add(d);
    const shutdown = await getShutdownInfo([...oldDots]);

    // ---------- 4. Score ----------
    const candidates: ScanCandidate[] = [];
    for (const [newDot, m] of links) {
      const r = rowsByDot.get(newDot);
      const scored = [...m.entries()].map(([oldDot, reasons]) => {
        const or = rowsByDot.get(oldDot);
        const list = [...reasons].sort((a, b) => REASON_POINTS[b] - REASON_POINTS[a]);
        // An officer name alone is the weakest link — two different people share it.
        let points = list.reduce((sum, rs) => sum + REASON_POINTS[rs], 0);
        if (list.length === 1 && list[0] === 'officer') points = 8;
        const rating = s(or.safety_rating) || null;
        if (rating === 'U') points += 20;
        else if (rating === 'C') points += 10;
        if (s(or.docket1) && s(or.docket1_status_code) === 'I') points += 5;
        // When the old carrier went dark (revocation / cancelled insurance, else its
        // last filing): a new DOT right after is the pattern; one coming back
        // after years away is usually just a restart.
        const lastActive = [iso(or.mcs150_date), iso(or.add_date)].filter(Boolean).sort().pop() || null;
        const info = shutdown.get(oldDot);
        const wentDark = info?.inactiveSince || lastActive;
        const gapDays = wentDark && iso(r.add_date)
          ? Math.round((new Date(iso(r.add_date)!).getTime() - new Date(wentDark).getTime()) / 86_400_000)
          : null;
        if (gapDays != null && gapDays <= 365) points += 10;
        else if (gapDays != null && gapDays > 3 * 365) points -= 10;
        // An old DOT that only ever applied had no record to escape — re-applying isn't hiding.
        if (info?.everAuthorized === false) points -= 15;
        const l: ScanLink = {
          dotNumber: oldDot,
          mcNumber: mcOf(or),
          legalName: s(or.legal_name) || `DOT ${oldDot}`,
          location: [s(or.phy_city), s(or.phy_state)].filter(Boolean).join(', ') || null,
          registeredDate: iso(or.add_date),
          powerUnits: num(or.power_units),
          dotInactive: s(or.status_code) !== 'A',
          authorityInactive: (!!s(or.docket1) && s(or.docket1_status_code) === 'I') || !!info?.authorityEnded,
          safetyRating: rating,
          lastActive,
          inactiveSince: info?.inactiveSince || null,
          inactiveReason: info?.inactiveReason || null,
          insuranceCancelled: info?.insuranceCancelled || null,
          everAuthorized: info?.everAuthorized ?? null,
          reasons: list,
        };
        return { l, points };
      }).sort((a, b) => b.points - a.points);

      // Strongest link, plus a little for each further shut-down carrier tied to it.
      const score = Math.max(0, Math.min(100, scored[0].points + Math.min(15, (scored.length - 1) * 5)));
      // A lone officer-name match with nothing behind it is noise.
      if (score < MIN_SCORE) continue;
      const reasons = [...new Set(scored.flatMap((x) => x.l.reasons))].sort((a, b) => REASON_POINTS[b] - REASON_POINTS[a]);
      const officer = [s(r.company_officer_1), s(r.company_officer_2)].filter(Boolean).join(' / ');
      const reRegistered = reRegistration(scored.map((x) => x.l));
      const shown = scored.slice(0, MAX_LINKS).map((x) => x.l);
      // Keep the carrier it re-registered from in the list even if weaker links outscore it.
      if (reRegistered && !shown.some((l) => l.dotNumber === reRegistered.dotNumber)) {
        shown.push(scored.find((x) => x.l.dotNumber === reRegistered.dotNumber)!.l);
      }
      candidates.push({
        dotNumber: newDot,
        mcNumber: mcOf(r),
        legalName: s(r.legal_name) || `DOT ${newDot}`,
        dbaName: s(r.dba_name) || null,
        city: s(r.phy_city) || null,
        state: s(r.phy_state) || null,
        registeredDate: iso(r.add_date),
        mcs150Date: iso(r.mcs150_date),
        powerUnits: num(r.power_units),
        drivers: num(r.total_drivers),
        forHire: upper(r.classdef).includes('AUTHORIZED FOR HIRE'),
        officer: officer || null,
        phone: formatPhone(r.phone),
        email: s(r.email_address).toLowerCase() || null,
        score,
        riskLevel: score >= 70 ? 'critical' : score >= 45 ? 'high' : score >= 25 ? 'moderate' : 'low',
        reasons,
        links: shown,
        reRegistered,
      });
    }
    candidates.sort((a, b) => b.score - a.score || (b.registeredDate || '').localeCompare(a.registeredDate || ''));

    const newest = await socrata<{ m?: string }>(CENSUS, {
      $select: 'max(add_date) AS m',
      $where: `add_date >= '${sinceStamp}'`,
    });

    return {
      days,
      since: iso(sinceStamp)!,
      builtAt: new Date().toISOString(),
      tookMs: Date.now() - t0,
      dataThrough: iso(newest?.[0]?.m),
      candidates,
    };
  }
}

export const chameleonScanService = new ChameleonScanService();
export default chameleonScanService;
