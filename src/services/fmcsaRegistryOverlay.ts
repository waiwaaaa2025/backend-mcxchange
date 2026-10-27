/**
 * Corrects a carrier report's authority and insurance from FMCSA's live Motus
 * registry when LINQ is stale.
 *
 * LINQ's authority and insurance blocks stopped tracking FMCSA around the Motus
 * cutover (2026-05-14). MC 1808047 / DOT 4552258 showed "Not Authorized" and
 * "pending insurance" because LINQ still had the pre-grant snapshot (common
 * authority N, application pending Y) and listed a GEICO policy as active that
 * FMCSA cancelled on 2026-06-08 — the Progressive replacement wasn't in LINQ at
 * all. Motus has it right, and is refreshed daily.
 *
 * The overlay is conservative — FMCSA overrides only what it actually covers:
 *  - authority: per kind (motor carrier / broker), only when Motus has a row
 *    for that kind;
 *  - insurance: drops LINQ "active" policies FMCSA shows cancelled, adds
 *    FMCSA's active filings LINQ lacks, and flags real pending cancellations
 *    (BMC-35 notices). Policies FMCSA doesn't list (e.g. self-insurance) stay.
 *
 * The fetched rows are stored on the report (cached with it) and the overlay is
 * re-applied after every normalize, because cached LINQ reports are
 * re-normalized from their raw fields on read.
 */
import { socrata } from './fmcsaLeadsService';
import logger from '../utils/logger';

const MOTUS_CARRIER = 'inys-ebih'; // one row per operating authority — usdot_number TEXT
const MOTUS_INSUR = 'c5y8-a4uz'; // current filings (+ BMC-35 cancel notices) — usdot_number TEXT
const MOTUS_INSHIST = '3uet-3z4i'; // cancelled/replaced filings — usdot_number TEXT

export const REGISTRY_MARKER = '_fmcsaRegistry';

interface RegistryData {
  authorities: Array<{ type: string; status: string; docket: string }>;
  filings: any[];
  cancellations: any[];
}

// '20260608' → ISO, else null
function ymd(v: unknown): string | null {
  const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(v || ''));
  return m ? new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00.000Z`).toISOString() : null;
}

const todayYmd = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const policyKey = (v: unknown) => String(v || '').replace(/\s+/g, '').toUpperCase();
const formCode = (v: unknown) => String(v || '').toUpperCase().replace(/^BMC-/, '');

const FORM_LABELS: Record<string, string> = {
  '91X': 'Bodily Injury & Property Damage',
  '91': 'Bodily Injury & Property Damage',
  '34': 'Cargo',
  '83': 'Cargo',
  '82': 'Surety Bond',
  '84': 'Surety Bond',
  '85': 'Trust Fund',
};

/**
 * Fetches the Motus rows for a DOT onto `report[REGISTRY_MARKER]`. Leaves the
 * report unmarked when a lookup fails so the next read retries.
 */
export async function fetchFmcsaRegistry(report: any, dotNumber: string): Promise<void> {
  if (!report || report[REGISTRY_MARKER] !== undefined) return;
  const dot = String(dotNumber).replace(/\D/g, '').replace(/^0+/, '');
  if (!dot) return;

  const where = { $where: `usdot_number='${dot}'`, $limit: '500' };
  const [carrier, insur, hist] = await Promise.all([
    socrata<any>(MOTUS_CARRIER, where, 8000),
    socrata<any>(MOTUS_INSUR, where, 8000),
    socrata<any>(MOTUS_INSHIST, { ...where, $where: `${where.$where} AND filing_status_reason='CANCEL'` }, 8000),
  ]);
  if (carrier === null || insur === null || hist === null) return;

  const data: RegistryData = {
    authorities: carrier.map((r) => ({
      type: String(r.op_auth_type || ''),
      status: String(r.op_auth_status || ''),
      docket: String(r.docket_number || ''),
    })),
    filings: insur,
    cancellations: hist,
  };
  report[REGISTRY_MARKER] = data;
}

// Motus status for one kind of authority: ACTIVE beats PENDING beats INACTIVE.
function kindStatus(rows: RegistryData['authorities']): 'ACTIVE' | 'PENDING' | 'INACTIVE' | null {
  if (!rows.length) return null;
  const statuses = rows.map((r) => r.status.toUpperCase());
  if (statuses.includes('ACTIVE')) return 'ACTIVE';
  if (statuses.includes('PENDING')) return 'PENDING';
  return 'INACTIVE';
}

function overlayAuthority(report: any, data: RegistryData): void {
  const auth = report.authority;
  if (!auth) return;
  const motor = data.authorities.filter((a) => /motor carrier/i.test(a.type));
  const broker = data.authorities.filter((a) => /^broker/i.test(a.type));

  const apply = (kind: 'common' | 'broker', status: ReturnType<typeof kindStatus>) => {
    if (!status) return;
    if (auth.statuses?.[kind]) auth.statuses[kind].status = status === 'ACTIVE' ? 'ACTIVE' : status === 'INACTIVE' ? 'INACTIVE' : null;
    if (auth.pendingFlags) auth.pendingFlags[`${kind}Pending`] = status === 'PENDING' ? 'Y' : 'N';
    auth[`${kind}_authority`] = status === 'ACTIVE' ? 'A' : 'N';
    auth[`${kind}_app_pending`] = status === 'PENDING';
  };
  const motorStatus = kindStatus(motor);
  apply('common', motorStatus);
  // Motus doesn't split common/contract — "Motor Carrier" covers both.
  if (motorStatus && motorStatus !== 'ACTIVE' && auth.statuses?.contract) auth.statuses.contract.status = null;
  apply('broker', kindStatus(broker));

  const carrier = report.carrier;
  if (carrier && (motor.length || broker.length)) {
    const anyActive = ['common', 'contract', 'broker'].some((k) => auth.statuses?.[k]?.status === 'ACTIVE');
    const dotActive = String(carrier.status_code || 'A').toUpperCase() === 'A';
    carrier.allowedToOperate = dotActive && anyActive ? 'Y' : 'N';
  }
}

function overlayInsurance(report: any, data: RegistryData): void {
  const ins = report.insurance;
  if (!ins) return;
  const today = todayYmd();
  const todayIso = ymd(today)!;

  const cancelled = new Set(
    data.cancellations
      .filter((c) => String(c.cancl_effective_date || '') <= today)
      .map((c) => policyKey(c.policy_no))
  );
  // BMC-35 = insurer's notice; its effective_date is the cancellation date.
  const pendingCancel = new Map<string, string>();
  for (const f of data.filings) {
    if (formCode(f.ins_form_code) !== '35') continue;
    const on = String(f.effective_date || '');
    if (on > today) pendingCancel.set(policyKey(f.policy_no), on);
    else cancelled.add(policyKey(f.policy_no));
  }

  const kept = (ins.activePolicies || []).filter((p: any) => {
    if (cancelled.has(policyKey(p.policyNumber))) return false;
    return !(p.cancelDate && p.cancelDate <= todayIso);
  });

  const have = new Set(kept.map((p: any) => `${policyKey(p.policyNumber)}|${formCode(p.type)}`));
  for (const f of data.filings) {
    const form = formCode(f.ins_form_code);
    if (form === '35' || cancelled.has(policyKey(f.policy_no))) continue;
    const key = `${policyKey(f.policy_no)}|${form}`;
    if (have.has(key)) continue;
    have.add(key);
    const coverage = Number(f.max_cov_amount);
    kept.push({
      insurer: f.insurance_company_name ?? null,
      policyNumber: f.policy_no ?? null,
      type: form,
      typeLabel: FORM_LABELS[form] ?? null,
      coverage: isNaN(coverage) ? null : coverage >= 1000 ? Math.round(coverage / 1000) : coverage,
      required: null,
      status: 'active',
      effectiveDate: ymd(f.effective_date),
      expirationDate: null,
      cancelDate: null,
      cancelMethod: null,
      docket: f.docket_number ?? null,
      source: 'fmcsa',
    });
  }

  for (const p of kept) {
    const on = pendingCancel.get(policyKey(p.policyNumber));
    if (on) p.cancelDate = ymd(on);
  }
  ins.activePolicies = kept;
}

/** Applies stored Motus rows to a (normalized) report. Pure, no network. */
export function applyFmcsaRegistry(report: any): any {
  const data: RegistryData | undefined = report?.[REGISTRY_MARKER];
  if (!data) return report;
  try {
    overlayAuthority(report, data);
    overlayInsurance(report, data);
  } catch (err) {
    logger.warn(`FMCSA registry overlay failed: ${(err as Error).message}`);
  }
  return report;
}
