/**
 * Direct buyer→seller questions are allowed on equipment and parts only. MC
 * authority deals go through Domilea, so a message that asks about or passes
 * along an MC/DOT/authority is refused before it reaches the seller.
 *
 * Deliberately NOT matched: "DOT inspection", "DOT annual", "DOT approved" —
 * normal equipment questions. DOT only counts next to a number or "number".
 */
const PATTERNS: RegExp[] = [
  /\bM\.?\s?C\.?\b/i, // "MC", "M.C.", "mc#123"
  /\bmotor\s+carrier\b/i,
  /\bauthorit(y|ies)\b/i,
  /\b(us\s?)?dot\s*(#|no\.?|num(ber)?|:)?\s*\d{3,8}\b/i, // "DOT 1234567", "USDOT#123456"
  /\bus\s?dot\b/i,
  /\bdot\s+(number|num|no\.?|#)/i,
  /\bdocket\b/i,
  /\bfmcsa\b/i,
  /\bbroker(age)?\s+(authority|license|bond)\b/i,
];

export function mentionsAuthority(text: string | null | undefined): boolean {
  const s = String(text || '');
  return PATTERNS.some((re) => re.test(s));
}

export const AUTHORITY_TALK_BLOCKED =
  "Questions about MC authorities can't be sent to sellers directly. Ask on the authority listing and the Domilea team will help.";
