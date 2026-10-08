/**
 * When (and why) a carrier stopped operating, for many DOTs at once — used by
 * the bulk chameleon scans to say "the old MC went inactive N months ago".
 *
 * The census only says a DOT is inactive, never since when, so this combines:
 *  - AuthHist (`9mw4-x3tu`): the disposition on the carrier's latest grant of
 *    authority (REVOKED, OUT OF SERVICE, …) and its served date. NOTE: the file
 *    stops at the Motus cutover (mid-May 2026), so later revocations aren't in it.
 *  - Motus AuthHist (`yu5v-wbh6`, daily): dated status changes since the cutover
 *    (suspended for cancelled insurance, revoked, withdrawn, …).
 *  - Motus InsHist (`3uet-3z4i`, refreshed daily): the latest BIPD cancellation —
 *    no liability insurance means the authority is revoked about 30 days later,
 *    so it covers carriers that died after the cutover.
 */
import { socrata } from './fmcsaLeadsService';

const AUTH_HIST = '9mw4-x3tu';
const INS_HIST = '3uet-3z4i';
const MOTUS_AUTH_HIST = 'yu5v-wbh6'; // status changes since the Motus cutover (and older history)
const CHUNK = 150;
const CONCURRENCY = 6;

// Dispositions that end an authority. "DISCONTINUED REVOCATION" is the opposite —
// a revocation that was called off — and TRANSFERRED/RENUMBERED live on elsewhere.
const ENDING = new Set([
  'REVOKED', 'OUT OF SERVICE', 'SAFETY SUSPENSION', 'SAFETY REVOCATION', 'FAILURE TO REAPPLY',
  'ADMINISTRATIVE INACTIVATION', 'EXPIRED ETA OR TA', 'TERM EXPIRED',
]);

export interface ShutdownInfo {
  authorityEnded: { action: string; date: string } | null; // from AuthHist
  insuranceCancelled: string | null;                        // latest BIPD cancellation (ISO)
  inactiveSince: string | null;                             // best date the carrier stopped
  inactiveReason: string | null;                            // "Authority revoked", "Insurance cancelled", …
  everAuthorized: boolean | null;                           // false = applications only, never granted
}

const s = (v: unknown): string => (v == null ? '' : String(v).trim());

// MM/DD/YYYY → YYYY-MM-DD
function mdy(v: unknown): string | null {
  const m = s(v).match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[1]}-${m[2]}` : null;
}

function ymd(v: unknown): string | null {
  const d = s(v).replace(/\D/g, '');
  return d.length >= 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null;
}

/** One retry — a single Socrata hiccup shouldn't fail a minutes-long scan. */
export async function socrataRetry<T>(dataset: string, params: Record<string, string>, timeoutMs = 60_000): Promise<T[] | null> {
  const first = await socrata<T>(dataset, params, timeoutMs);
  if (first) return first;
  await new Promise((r) => setTimeout(r, 1500));
  return socrata<T>(dataset, params, timeoutMs);
}

async function pooled<T, R>(items: T[], size: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) out.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  return out;
}

function chunks<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

const label = (action: string) => `Authority ${action.toLowerCase()}`;

// Motus reasons are free text ("Involuntary Suspension - insurance cancellation effective; …").
function motusLabel(status: string, reason: string): string {
  const r = reason.toLowerCase();
  if (status === 'Withdrawn' || r.startsWith('withdrawn')) return 'Application withdrawn';
  if (r.includes('insurance') && r.includes('boc-3')) return 'Suspended (no insurance or process agent)';
  if (r.includes('insurance')) return 'Suspended (insurance cancelled)';
  if (r.includes('boc-3')) return 'Suspended (no process agent)';
  if (r.includes('revoked')) return 'Authority revoked';
  if (r.includes('voluntary suspension')) return 'Voluntarily suspended';
  if (r.includes('dismissed')) return 'Application dismissed';
  if (r.includes('administrative')) return 'Administratively inactivated';
  return `Authority ${status.toLowerCase()}`;
}

/**
 * Shutdown info per DOT (keys are DOTs without leading zeros). A DOT whose
 * lookups failed is simply missing from the map — the dates are context, not
 * something worth failing a whole scan over.
 */
export async function getShutdownInfo(dotList: string[]): Promise<Map<string, ShutdownInfo>> {
  const dots = [...new Set(dotList.filter((d) => /^\d+$/.test(d)))];
  const today = new Date().toISOString().slice(0, 10);

  const inList = (part: string[]) => part.map((d) => `'${d}'`).join(',');
  const [authRows, motusRows, insRows] = await Promise.all([
    pooled(chunks(dots, CHUNK), CONCURRENCY, async (part) =>
      (await socrataRetry<any>(AUTH_HIST, {
        $select: 'dot_number, docket_number, original_action_desc, orig_served_date, disp_action_desc, disp_served_date, disp_decided_date',
        $where: `dot_number in (${part.map((d) => `'${d.padStart(8, '0')}'`).join(',')})`,
        $limit: '5000',
      })) || []
    ),
    pooled(chunks(dots, CHUNK), CONCURRENCY, async (part) =>
      (await socrataRetry<any>(MOTUS_AUTH_HIST, {
        $select: 'usdot_number, docket_number, op_auth_status, reason, status_change_date',
        $where: `usdot_number in (${inList(part)})`,
        $limit: '5000',
      })) || []
    ),
    pooled(chunks(dots, CHUNK), CONCURRENCY, async (part) =>
      (await socrataRetry<any>(INS_HIST, {
        $select: 'usdot_number, max(cancl_effective_date) AS cancelled',
        $where: `usdot_number in (${inList(part)}) AND filing_status_reason='CANCEL' AND ins_type_desc='BIPD'`,
        $group: 'usdot_number',
        $limit: '5000',
      })) || []
    ),
  ]);

  // Every status event per docket from both histories; the latest one decides
  // whether that authority is alive, ended (and how), or just pending.
  type Event = { date: string; state: 'alive' | 'ended' | 'pending'; label: string };
  const everGranted = new Set<string>();
  const events = new Map<string, { dot: string; latest: Event }>();
  const record = (dot: string, docket: string, e: Event) => {
    const key = `${dot}|${docket.replace(/^(MC|FF|MX)0*/, '$1')}`;
    const prev = events.get(key);
    if (!prev || e.date >= prev.latest.date) events.set(key, { dot, latest: e });
  };
  for (const r of authRows.flat()) {
    const dot = String(parseInt(s(r.dot_number), 10));
    const original = s(r.original_action_desc).toUpperCase();
    const served = mdy(r.orig_served_date);
    // Rows are actions: a grant/reinstatement, a revocation proceeding (whose
    // disposition says whether it went through), or an application that never
    // became an authority (DISMISSED, WITHDRAWN, REJECTED, DENIED, CANCELLED).
    if (served && (original === 'GRANTED' || original === 'REINSTATED')) {
      record(dot, s(r.docket_number), { date: served, state: 'alive', label: original === 'GRANTED' ? 'Granted' : 'Reinstated' });
      everGranted.add(dot);
    } else if (served && original === 'SUSPENDED') {
      record(dot, s(r.docket_number), { date: served, state: 'ended', label: 'Authority suspended' });
    } else if (served && original && !original.includes('REVOCATION')) {
      record(dot, s(r.docket_number), { date: served, state: 'ended', label: `Application ${original.toLowerCase()}` });
    }
    const action = s(r.disp_action_desc).toUpperCase();
    const when = mdy(r.disp_served_date) || mdy(r.disp_decided_date);
    if (!action || !when) continue;
    if (ENDING.has(action)) record(dot, s(r.docket_number), { date: when, state: 'ended', label: label(action) });
    else if (action === 'DISCONTINUED REVOCATION') record(dot, s(r.docket_number), { date: when, state: 'alive', label: 'Reinstated' });
  }
  for (const r of motusRows.flat()) {
    const date = ymd(r.status_change_date);
    if (!date) continue;
    const status = s(r.op_auth_status);
    const state = status === 'Active' ? 'alive' : status === 'Pending' ? 'pending' : 'ended';
    const dot = String(parseInt(s(r.usdot_number), 10));
    if (status === 'Active' || /GRANTED|REINSTATED/i.test(s(r.reason)) || status === 'Inactive') everGranted.add(dot);
    record(dot, s(r.docket_number), { date, state, label: motusLabel(status, s(r.reason)) });
  }

  const hasRecord = new Set([...events.values()].map((e) => e.dot));
  const authorityEnded = new Map<string, { action: string; date: string }>();
  const authorityAlive = new Set<string>();
  for (const { dot, latest } of events.values()) {
    if (latest.state === 'alive') authorityAlive.add(dot);
    if (latest.state !== 'ended') continue;
    const prev = authorityEnded.get(dot);
    if (!prev || latest.date > prev.date) authorityEnded.set(dot, { action: latest.label, date: latest.date });
  }

  const insuranceCancelled = new Map<string, string>();
  for (const r of insRows.flat()) {
    const date = ymd(r.cancelled);
    if (date && date <= today) insuranceCancelled.set(String(parseInt(s(r.usdot_number), 10)), date);
  }

  const out = new Map<string, ShutdownInfo>();
  for (const dot of dots) {
    // Another docket still carrying a live grant means the carrier didn't stop.
    const ended = authorityAlive.has(dot) ? null : authorityEnded.get(dot) || null;
    const cancelled = insuranceCancelled.get(dot) || null;
    let inactiveSince: string | null = null;
    let inactiveReason: string | null = null;
    if (ended && (!cancelled || ended.date >= cancelled)) {
      inactiveSince = ended.date;
      inactiveReason = ended.action;
    } else if (cancelled) {
      inactiveSince = cancelled;
      inactiveReason = 'Insurance cancelled';
    }
    out.set(dot, {
      authorityEnded: ended,
      insuranceCancelled: cancelled,
      inactiveSince,
      inactiveReason,
      // Only known when FMCSA has any authority record for the DOT at all.
      everAuthorized: everGranted.has(dot) || !!cancelled ? true : hasRecord.has(dot) ? false : null,
    });
  }
  return out;
}
