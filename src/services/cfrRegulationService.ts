/**
 * Resolves an FMCSA violation code (e.g. "393.75A3-TAOLTIS") to the 49 CFR
 * regulation it cites — "49 CFR 393.75(a)(3)" — with the section title and the
 * paragraph's text, read from the official eCFR (ecfr.gov).
 *
 * Violation codes are the CFR section plus the paragraph path squashed together
 * (A3 → (a)(3)) and, after a dash or at the end, an FMCSA suffix that narrows
 * the defect (TAOLTIS, SLLED…). The paragraph path is only kept as far as the
 * section actually has those paragraphs, so a suffix is never mistaken for one.
 */
import cacheService from './cacheService';
import logger from '../utils/logger';

const ECFR = 'https://www.ecfr.gov/api/versioner/v1';
const SECTION_TTL = 7 * 24 * 3600; // regulations change rarely
const MAX_TEXT = 900;

export interface CfrRegulation {
  code: string;
  section: string; // "393.75"
  paragraph: string; // "(a)(3)" or ""
  citation: string; // "49 CFR 393.75(a)(3)"
  title: string; // "Tires"
  text: string; // lead-in + paragraph text, plain
  url: string;
}

interface ParsedSection {
  title: string;
  paras: { labels: string[]; text: string }[]; // labels = full path, e.g. ['a','3']
}

// ─── eCFR fetch + parse ───

let titleDate: { value: string; at: number } | null = null;
async function title49Date(): Promise<string> {
  if (titleDate && Date.now() - titleDate.at < 6 * 3600_000) return titleDate.value;
  const res = await fetch(`${ECFR}/titles.json`, { headers: { 'Accept-Encoding': 'gzip' } });
  if (!res.ok) throw new Error(`eCFR titles ${res.status}`);
  const body: any = await res.json();
  const t = (body.titles || []).find((x: any) => x.number === 49);
  const value = t?.up_to_date_as_of || 'current';
  titleDate = { value, at: Date.now() };
  return value;
}

const decode = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x2014;|&#8212;/g, '—')
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/\s+/g, ' ')
    .trim();

const ROMAN = /^(i|ii|iii|iv|v|vi|vii|viii|ix|x|xi|xii|xiii|xiv|xv|xvi|xvii|xviii|xix|xx)$/;

// Paragraph depth by label style: (a)=0, (1)=1, (i)=2, (A)=3.
function depthOf(label: string, prevDepth: number, prevLabel: string): number {
  if (/^\d+$/.test(label)) return 1;
  if (/^[A-Z]+$/.test(label)) return 3;
  if (ROMAN.test(label)) {
    // (i) right after (h) is a letter; after a number it's roman.
    if (label === 'i' && prevDepth === 0 && prevLabel === 'h') return 0;
    if (label === 'v' && prevDepth === 0 && prevLabel === 'u') return 0;
    if (label === 'x' && prevDepth === 0 && prevLabel === 'w') return 0;
    return prevDepth >= 1 ? 2 : 0;
  }
  return 0;
}

function parseSectionXml(xml: string): ParsedSection {
  const head = /<HEAD>([\s\S]*?)<\/HEAD>/.exec(xml);
  const title = head ? decode(head[1]).replace(/^§\s*[\d.]+\s*/, '').replace(/\.$/, '') : '';
  const paras: ParsedSection['paras'] = [];
  const stack: string[] = [];
  let prevDepth = -1;
  let prevLabel = '';
  const re = /<P>([\s\S]*?)<\/P>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const text = decode(m[1]);
    // Leading labels: "(h)(1) Tire loading…" → ['h','1']
    const labels: string[] = [];
    let rest = text;
    let lm: RegExpExecArray | null;
    while ((lm = /^\(([a-zA-Z0-9]{1,5})\)\s*/.exec(rest))) {
      labels.push(lm[1]);
      rest = rest.slice(lm[0].length);
    }
    if (labels.length === 0) {
      if (paras.length) paras[paras.length - 1].text += ' ' + text;
      else paras.push({ labels: [], text });
      continue;
    }
    labels.forEach((label, i) => {
      const d = i === 0 ? depthOf(label, prevDepth, prevLabel) : Math.min(prevDepth + 1, 3);
      stack.length = d;
      stack[d] = label;
      prevDepth = d;
      prevLabel = label;
    });
    paras.push({ labels: stack.filter((x) => x !== undefined).slice(), text });
  }
  return { title, paras };
}

const fetchEcfr = (url: string) =>
  fetch(url, { headers: { 'Accept-Encoding': 'gzip' }, signal: AbortSignal.timeout(25_000) });

async function getSection(section: string): Promise<ParsedSection | null> {
  const key = `cfr:49:${section}`;
  const cached = await cacheService.get<ParsedSection>(key).catch(() => null);
  if (cached) return cached;

  const part = section.split('.')[0];
  const date = await title49Date();
  const url = `${ECFR}/full/${date}/title-49.xml?part=${part}&section=${section}`;
  let res = await fetchEcfr(url);
  // eCFR throttles bursts — back off once.
  if (res.status === 429 || res.status >= 500) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await fetchEcfr(url);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`eCFR ${section} ${res.status}`);
  const parsed = parseSectionXml(await res.text());
  await cacheService.set(key, parsed, SECTION_TTL).catch(() => undefined);
  return parsed;
}

// ─── code → section + paragraph path ───

/** "393.75A3-TAOLTIS" → { section: "393.75", tokens: ['a','3'] } */
export function parseViolationCode(code: string): { section: string; tokens: string[] } | null {
  const c = String(code || '').toUpperCase().replace(/\s+/g, '');
  const m = /^(\d{3})\.(\d+)(.*)$/.exec(c);
  if (!m) return null;
  const section = `${m[1]}.${m[2]}`;
  // Paragraph path lives before the dash; "(A)(1)" style is accepted too.
  const tail = m[3].split('-')[0].replace(/[()]/g, '');
  // Alternate letter-run / digit-run: A3 → [A,3]; A1BL → [A,1,BL]
  const tokens = (tail.match(/[A-Z]+|\d+/g) || []).map((t) => t);
  return { section, tokens };
}

function matchPath(sec: ParsedSection, tokens: string[]): string[] {
  // Walk tokens, keeping each only while some paragraph has that exact prefix.
  const path: string[] = [];
  for (const raw of tokens) {
    const depth = path.length;
    // Letter runs at depth 0 are (a); at depth 2 roman (i); at depth 3 caps (A).
    const candidates = /^\d+$/.test(raw) ? [raw] : depth === 3 ? [raw] : [raw.toLowerCase()];
    const next = candidates.find((cand) =>
      sec.paras.some((p) => p.labels.length > depth && p.labels[depth] === cand && path.every((x, i) => p.labels[i] === x))
    );
    if (!next) break;
    path.push(next);
  }
  return path;
}

function excerpt(sec: ParsedSection, path: string[]): string {
  const startsWith = (p: { labels: string[] }, n: number) => p.labels.length >= n && path.slice(0, n).every((x, i) => p.labels[i] === x);
  if (path.length === 0) {
    const text = sec.paras.map((p) => p.text).join(' ');
    return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT).replace(/\s+\S*$/, '') + '…' : text;
  }
  const parts: string[] = [];
  // Lead-ins of each ancestor ("(a) No motor vehicle shall be operated on any tire that—")
  for (let n = 1; n < path.length; n++) {
    const anc = sec.paras.find((p) => p.labels.length === n && startsWith(p, n));
    if (anc && !parts.includes(anc.text)) parts.push(anc.text);
  }
  // The paragraph itself and its sub-paragraphs.
  for (const p of sec.paras) if (startsWith(p, path.length) && !parts.includes(p.text)) parts.push(p.text);
  const text = parts.join(' ');
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT).replace(/\s+\S*$/, '') + '…' : text;
}

export async function lookupRegulation(code: string): Promise<CfrRegulation | null> {
  const parsed = parseViolationCode(code);
  if (!parsed) return null;
  const sec = await getSection(parsed.section);
  if (!sec) return null;
  const path = matchPath(sec, parsed.tokens);
  const paragraph = path.map((x) => `(${x})`).join('');
  return {
    code,
    section: parsed.section,
    paragraph,
    citation: `49 CFR ${parsed.section}${paragraph}`,
    title: sec.title,
    text: excerpt(sec, path),
    url: `https://www.ecfr.gov/current/title-49/section-${parsed.section}${paragraph ? `#p-${parsed.section}${paragraph}` : ''}`,
  };
}

export async function lookupRegulations(codes: string[]): Promise<Record<string, CfrRegulation | null>> {
  const unique = [...new Set(codes.map((c) => String(c || '').trim()).filter(Boolean))].slice(0, 60);
  const out: Record<string, CfrRegulation | null> = {};
  // Codes sharing a section reuse one fetch; a few sections at a time.
  const bySection = new Map<string, string[]>();
  for (const code of unique) {
    const sec = parseViolationCode(code)?.section || code;
    bySection.set(sec, [...(bySection.get(sec) || []), code]);
  }
  const groups = [...bySection.values()];
  let next = 0;
  const worker = async () => {
    while (next < groups.length) {
      const group = groups[next++];
      for (const code of group) {
        try {
          out[code] = await lookupRegulation(code);
        } catch (err) {
          logger.warn(`CFR lookup failed for ${code}: ${(err as Error).message}`);
          out[code] = null;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
  return out;
}
