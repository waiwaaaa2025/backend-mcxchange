import { User, PlatformSetting } from '../models';
import { stripeService } from './stripeService';
import { emailService } from './emailService';
import { config } from '../config';
import logger from '../utils/logger';

/**
 * Names behind a user: the account name they typed, the legal name read off
 * their government ID by Stripe Identity, and the cardholder name(s) on the
 * cards they paid with. Used by admins to spot accounts verified with someone
 * else's ID / paying with someone else's card, and quoted in dispute evidence.
 */

function tokens(name?: string | null): string[] {
  return String(name || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 0);
}

/**
 * Loose person-name comparison: the reference name's first given name and at
 * least one surname token must appear in the other name. Tolerates case,
 * accents, punctuation, middle names, and compound surnames.
 */
export function namesMatch(referenceFirst: string | null | undefined, referenceLast: string | null | undefined, other: string | null | undefined): boolean | null {
  const first = tokens(referenceFirst);
  const last = tokens(referenceLast);
  const o = new Set(tokens(other));
  if ((!first.length && !last.length) || !o.size) return null;
  const firstOk = !first.length || o.has(first[0]);
  const lastOk = !last.length || last.some((t) => o.has(t));
  return firstOk && lastOk;
}

/** Split a full name ("Jane Q Doe") into first + rest for namesMatch. */
function splitFull(name?: string | null): [string, string] {
  const t = String(name || '').trim().split(/\s+/);
  return [t[0] || '', t.slice(1).join(' ')];
}

export function idFullName(user: any): string | null {
  const n = [user?.identityFirstName, user?.identityLastName].filter(Boolean).join(' ').trim();
  return n || null;
}

/** Every card name must match (one stranger's card is enough to flag). */
function allMatch(names: string[], fn: (n: string) => boolean | null): boolean | null {
  const r = names.map(fn).filter((x) => x !== null);
  return r.length ? r.every(Boolean) : null;
}

/** IDs often come back ALL CAPS; make them readable before saving as account name. */
function tidy(name: string): string {
  return name === name.toUpperCase()
    ? name.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_m, p, c) => p + c.toUpperCase())
    : name;
}

export interface NameCheck {
  accountName: string | null;
  signupName: string | null; // what they typed at signup (before the ID name replaced it)
  idName: string | null;
  cardholderName: string | null;
  idMatchesAccount: boolean | null; // null = nothing to compare
  idMatchesSignup: boolean | null;
  cardMatchesId: boolean | null;
  cardMatchesAccount: boolean | null;
}

export function buildNameCheck(user: any): NameCheck {
  const idName = idFullName(user);
  const card = user?.cardholderName || null;
  const [accFirst, accLast] = splitFull(user?.name);
  const cards = card ? String(card).split(' / ') : [];
  const signupName = user?.signupName || user?.name || null;
  return {
    accountName: user?.name || null,
    signupName,
    idName,
    cardholderName: card,
    idMatchesAccount: idName ? namesMatch(user.identityFirstName, user.identityLastName, user.name) : null,
    idMatchesSignup: idName ? namesMatch(user.identityFirstName, user.identityLastName, signupName) : null,
    cardMatchesId: idName && card ? allMatch(cards, (c) => namesMatch(user.identityFirstName, user.identityLastName, c)) : null,
    cardMatchesAccount: card ? allMatch(cards, (c) => namesMatch(accFirst, accLast, c)) : null,
  };
}

/**
 * What doesn't line up, in plain words, for admins and dispute evidence.
 * Informational only: nothing is blocked on a mismatch. null = nothing to compare.
 */
export function nameMismatches(check: NameCheck): string[] {
  const out: string[] = [];
  if (check.idMatchesSignup === false) out.push(`Signed up as "${check.signupName}" but the ID says "${check.idName}"`);
  if (check.cardMatchesId === false) out.push(`Card is in the name "${check.cardholderName}", not the ID name "${check.idName}"`);
  else if (check.cardMatchesId === null && check.cardMatchesAccount === false) out.push(`Card is in the name "${check.cardholderName}", not the account name "${check.accountName}"`);
  return out;
}

/** Email the admin notification list about a user whose names don't line up. Never throws. */
export async function notifyAdminsOfNameMismatch(user: any, check: NameCheck, problems: string[]): Promise<void> {
  try {
    const setting: any = await PlatformSetting.findOne({ where: { key: 'admin_notification_emails' } });
    const emails = String(setting?.value || 'support@domilea.com')
      .split(',').map((e) => e.trim()).filter((e) => e.includes('@'));
    const esc = (v: any) => String(v ?? '—').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    const html = `
      <h2>Name mismatch after ID verification</h2>
      <p><strong>${esc(user.email)}</strong> (${esc(user.role)}) verified their ID. Their account name was updated to the name on the ID. Nothing was blocked; this is for your records.</p>
      <ul>${problems.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
      <table cellpadding="4">
        <tr><td><strong>Name at signup</strong></td><td>${esc(check.signupName)}</td></tr>
        <tr><td><strong>Name on ID (now the account name)</strong></td><td>${esc(check.idName)}</td></tr>
        <tr><td><strong>Cardholder name</strong></td><td>${esc(check.cardholderName)}</td></tr>
      </table>
      <p><a href="${config.frontendUrl}/admin/users">Review in admin → Users</a></p>`;
    await Promise.all(emails.map((to) =>
      emailService.sendEmail({ to, subject: `[Domilea] Name mismatch: ${user.email}`, html })));
  } catch (e) {
    logger.warn('Name mismatch admin email failed', { userId: user?.id, error: (e as Error).message });
  }
}

/**
 * After ID verification: remember the signup name (once), then make the
 * account name the legal name from the ID. Safe to call repeatedly.
 */
export async function adoptIdName(user: any): Promise<NameCheck> {
  const raw = idFullName(user);
  if (raw) {
    const updates: any = {};
    if (!user.signupName && user.name) updates.signupName = user.name;
    const idName = tidy(raw);
    if (user.name !== idName) updates.name = idName;
    if (Object.keys(updates).length) {
      await user.update(updates);
      logger.info('Account name set from ID', { userId: user.id, signupName: user.signupName, idName });
    }
  }
  return buildNameCheck(user);
}

/**
 * Pull the ID name (from the user's verified Stripe Identity session) and the
 * cardholder name (from their Stripe customer's cards / charges) and store
 * them on the user. Safe to call repeatedly; never throws.
 */
export async function syncIdentityNames(user: any, opts: { sessionId?: string } = {}): Promise<NameCheck> {
  const updates: any = {};
  try {
    const sessionId = opts.sessionId || user.stripeVerificationSessionId;
    if (sessionId && (user.identityVerified || opts.sessionId)) {
      const out = await stripeService.getVerifiedIdentityName(sessionId);
      if (out?.firstName || out?.lastName) {
        updates.identityFirstName = out.firstName || null;
        updates.identityLastName = out.lastName || null;
      }
    }
  } catch (e) {
    logger.warn('Identity name sync: ID name fetch failed', { userId: user.id, error: (e as Error).message });
  }
  try {
    if (user.stripeCustomerId) {
      const names = await stripeService.getCardholderNames(user.stripeCustomerId);
      if (names.length) updates.cardholderName = names.join(' / ').slice(0, 255);
    }
  } catch (e) {
    logger.warn('Identity name sync: cardholder fetch failed', { userId: user.id, error: (e as Error).message });
  }
  if (Object.keys(updates).length) {
    await user.update(updates);
  }
  return buildNameCheck(user);
}

/** Admin action: replace the account name with the name on the ID. */
export async function applyIdNameToAccount(userId: string): Promise<NameCheck> {
  const user: any = await User.findByPk(userId);
  if (!user) throw new Error('User not found');
  const raw = idFullName(user);
  if (!raw) throw new Error('No ID name on file for this user');
  const idName = tidy(raw);
  const previous = user.name;
  await user.update({ name: idName, ...(user.signupName ? {} : { signupName: previous }) });
  logger.info('Admin applied ID name to account', { userId, previous, idName });
  return buildNameCheck(user);
}
