/**
 * Attaches the exact violations cited on each roadside inspection — CFR code,
 * FMCSA's description, unit, OOS flag, citation — from FMCSA's "Vehicle
 * Inspections and Violations" file (876r-jsdb), keyed by inspection_id.
 *
 * The BASIC, violation group and severity weight come from the SMS violation
 * file (8mt8-2mdr), matched on the violation code (those are code-level
 * attributes). Codes SMS doesn't carry get their BASIC from the CFR part.
 *
 * Runs on any report whose inspection records carry MCMIS inspection ids; a
 * record the file has nothing for is left as it was.
 */
import { socrata } from './fmcsaLeadsService';
import logger from '../utils/logger';

const INSPECTION_VIOLATIONS = '876r-jsdb'; // inspection_id is TEXT
const SMS_VIOLATIONS = '8mt8-2mdr'; // dot_number is TEXT

export const VIOLATION_DETAIL_MARKER = '_fmcsaViolationDetail';

const CHUNK = 80;
const n = (v: unknown) => parseInt(String(v ?? ''), 10) || 0;
const normCode = (c: unknown) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// BASIC by CFR part/section, for codes the SMS file has no row for.
function basicFromCode(code: string): { basic: string; group: string } {
  const m = /^(\d{3})\.?(\d+)?/.exec(code);
  const part = m ? m[1] : '';
  const section = m && m[2] ? n(m[2]) : 0;
  if (part === '395') return { basic: 'Hours-of-Service Compliance', group: '' };
  if (part === '391' || part === '383') return { basic: 'Driver Fitness', group: '' };
  if (part === '382' || (part === '392' && (section === 4 || section === 5))) {
    return { basic: 'Controlled Substances/Alcohol', group: '' };
  }
  // 392.2-SL* are state/local law citations — speeding is Unsafe Driving, but
  // size/weight and the like count toward no BASIC; don't guess.
  if (part === '392' && !/^392\.?2-?SL/.test(code)) return { basic: 'Unsafe Driving', group: '' };
  if (part === '393' || part === '396') return { basic: 'Vehicle Maintenance', group: '' };
  if (part === '397' || ['171', '172', '173', '177', '178', '180'].includes(part)) {
    return { basic: 'Hazardous Materials Compliance', group: '' };
  }
  return { basic: '', group: '' };
}

function unitLabel(u: unknown): string {
  const s = String(u || '').toUpperCase();
  if (s === 'D') return 'Driver';
  if (s === 'C') return 'Co-Driver';
  if (s === '1') return 'Unit 1 (Power Unit)';
  if (/^\d+$/.test(s)) return `Unit ${s} (Trailer)`;
  return s;
}

function hasCodedDetail(rec: any): boolean {
  const list = rec?.violations_list;
  return Array.isArray(list) && list.length > 0 && list.every((v: any) => v && v.code);
}

/**
 * Mutates `report` in place. Returns true when violation detail was added.
 */
export async function applyViolationDetail(report: any, dotNumber: string): Promise<boolean> {
  if (!report || report[VIOLATION_DETAIL_MARKER] !== undefined) return false;
  const records: any[] = Array.isArray(report?.inspections?.records) ? report.inspections.records : [];

  const targets = records.filter((r) => {
    const id = String(r?.unique_id ?? r?.inspection_id ?? '');
    return /^\d+$/.test(id) && (n(r.viol_total ?? r.violations) > 0 || n(r.oos_total) > 0) && !hasCodedDetail(r);
  });
  if (targets.length === 0) {
    report[VIOLATION_DETAIL_MARKER] = false;
    return false;
  }

  const ids = [...new Set(targets.map((r) => String(r.unique_id ?? r.inspection_id)))];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += CHUNK) chunks.push(ids.slice(i, i + CHUNK));

  const dot = String(dotNumber).replace(/\D/g, '');
  const [smsRows, ...chunkRows] = await Promise.all([
    dot ? socrata<any>(SMS_VIOLATIONS, { $where: `dot_number='${dot}'`, $limit: '5000' }, 10000) : Promise.resolve([]),
    ...chunks.map((c) =>
      socrata<any>(
        INSPECTION_VIOLATIONS,
        { $where: `inspection_id in(${c.map((id) => `'${id}'`).join(',')})`, $limit: '5000' },
        10000
      )
    ),
  ]);

  // Any failed chunk leaves the report unmarked so the next read retries.
  if (chunkRows.some((rows) => rows === null)) return false;

  const meta = new Map<string, { basic: string; group: string; severity: number }>();
  for (const s of smsRows || []) {
    const key = normCode(s.viol_code);
    if (key && !meta.has(key)) {
      meta.set(key, {
        basic: String(s.basic_desc || '').replace(/&#8203;/g, ''),
        group: s.group_desc || '',
        severity: n(s.severity_weight),
      });
    }
  }

  const byInspection = new Map<string, any[]>();
  for (const rows of chunkRows) {
    for (const v of rows || []) {
      const list = byInspection.get(String(v.inspection_id)) || [];
      list.push(v);
      byInspection.set(String(v.inspection_id), list);
    }
  }

  let attached = 0;
  for (const r of targets) {
    const rows = byInspection.get(String(r.unique_id ?? r.inspection_id));
    if (!rows?.length) continue;
    rows.sort((a, b) => n(a.seq_no) - n(b.seq_no));
    r.violations_list = rows.map((v) => {
      const code = String(v.viol_code || '');
      const sms = meta.get(normCode(code));
      const fromPart = basicFromCode(code);
      const oos = String(v.out_of_service_indicator || '').toUpperCase() === 'Y';
      return {
        code,
        cfr_part: v.part_no || '',
        cfr_section: v.part_no_section || '',
        description: v.viol_desc || '',
        basic_desc: sms?.basic || fromPart.basic,
        group_desc: sms?.group || fromPart.group,
        severity_weight: sms?.severity ?? 0,
        // false = not (yet) in SMS: BASIC is inferred from the CFR part, severity unknown.
        in_sms: !!sms,
        oos,
        unit: unitLabel(v.insp_viol_unit),
        citation_number: v.citation_number || '',
      };
    });
    attached++;
  }

  report[VIOLATION_DETAIL_MARKER] = attached > 0;
  if (attached > 0) logger.info(`FMCSA violation detail for DOT ${dot}: ${attached}/${targets.length} inspections`);
  return attached > 0;
}
