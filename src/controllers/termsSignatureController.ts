import { Response } from 'express';
import { AuthRequest } from '../types';
import { User, UserRole, UserTermsAcceptance } from '../models';
import { emailService } from '../services/emailService';
import { buildNameCheck, namesMatch, sameNameText } from '../services/identityNameService';
import logger from '../utils/logger';
import { asyncHandler } from '../middleware/errorHandler';

/**
 * One window after login collects, with a single typed signature:
 *  - TOS: agreement to the Terms of Service + Privacy Policy (every member once).
 *  - NAME: acknowledgement that the account name was changed to the legal name
 *    on their government ID (only when it was changed from what they signed up with).
 *  - CARD: authorization statement when the cardholder name on their payment
 *    card doesn't match their ID: they are the cardholder or authorized by them.
 * Each is a user_terms_acceptances row (typed name + IP + user agent) and is
 * dispute evidence. The signup checkbox ('register-checkbox-*') and listing
 * NDA ('1.0') are separate records and don't count.
 */
export const TOS_SIGNATURE_VERSION = 'tos-signature-1.0';
export const NAME_ACK_VERSION = 'id-name-ack-1.0';
export const CARD_AUTH_VERSION = 'card-auth-1.0';

const clientIp = (req: AuthRequest) =>
  (req.headers['x-forwarded-for']?.toString().split(',')[0].trim()) || req.ip || undefined;
const esc = (v: any) => String(v ?? '').replace(/[<>&"]/g, '');

interface Pending {
  tos: boolean;
  nameChange: { accountName: string; signupName: string } | null;
  card: { cardholderName: string; idName: string } | null;
}

async function pendingFor(userId: string): Promise<{ user: any; pending: Pending; signedVersions: Set<string> }> {
  const user: any = await User.findByPk(userId);
  const rows = await UserTermsAcceptance.findAll({
    where: { userId, termsVersion: [TOS_SIGNATURE_VERSION, NAME_ACK_VERSION, CARD_AUTH_VERSION] } as any,
  });
  const signed = new Set(rows.map((r) => r.termsVersion));
  const check = buildNameCheck(user);
  // Only a real change (not just capitals/spacing) needs their acknowledgement.
  const nameChanged = !!(user?.signupName && !sameNameText(user.signupName, user.name));
  return {
    user,
    signedVersions: signed,
    pending: {
      tos: !signed.has(TOS_SIGNATURE_VERSION),
      nameChange: nameChanged && !signed.has(NAME_ACK_VERSION)
        ? { accountName: user.name, signupName: user.signupName } : null,
      card: check.cardMatchesId === false && !signed.has(CARD_AUTH_VERSION)
        ? { cardholderName: check.cardholderName as string, idName: user.name } : null,
    },
  };
}

// GET /api/auth/terms-signature
export const getTermsSignatureStatus = asyncHandler(async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user) { res.status(401).json({ success: false, error: 'Not authenticated' }); return; }
  if (req.user.role === UserRole.ADMIN) {
    res.json({ success: true, data: { required: false, tos: false, nameChange: null, card: null } });
    return;
  }
  const { user, pending } = await pendingFor(req.user.id);
  res.json({
    success: true,
    data: {
      required: pending.tos || !!pending.nameChange || !!pending.card,
      ...pending,
      // Signature must match the ID name when we have one.
      signatureMustMatch: user?.identityFirstName || user?.identityLastName ? user.name : null,
    },
  });
});

// POST /api/auth/terms-signature  { signatureName, agreed, ackName, authorizeCard }
export const signTerms = asyncHandler(async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user) { res.status(401).json({ success: false, error: 'Not authenticated' }); return; }
  const signatureName = String(req.body?.signatureName || '').trim().replace(/\s+/g, ' ');
  const { user, pending } = await pendingFor(req.user.id);
  if (!user) { res.status(404).json({ success: false, error: 'User not found' }); return; }

  if (signatureName.length < 3 || !signatureName.includes(' ') || signatureName.length > 255) {
    res.status(400).json({ success: false, error: 'Type your full legal name (first and last) as your signature.' });
    return;
  }
  if ((user.identityFirstName || user.identityLastName) &&
      namesMatch(user.identityFirstName, user.identityLastName, signatureName) === false) {
    res.status(400).json({ success: false, error: `Your signature must match the name on your ID: ${user.name}.` });
    return;
  }
  if (pending.tos && req.body?.agreed !== true) {
    res.status(400).json({ success: false, error: 'Check the box to agree to the Terms of Service and Privacy Policy.' });
    return;
  }
  if (pending.nameChange && req.body?.ackName !== true) {
    res.status(400).json({ success: false, error: 'Check the box to confirm your account name.' });
    return;
  }
  if (pending.card && req.body?.authorizeCard !== true) {
    res.status(400).json({ success: false, error: 'Check the box to confirm you are authorized to use this card.' });
    return;
  }

  const base = {
    userId: user.id,
    signatureName,
    acceptedAt: new Date(),
    ipAddress: clientIp(req)?.slice(0, 45),
    userAgent: req.headers['user-agent'] || undefined,
  };
  const versions = [
    pending.tos && TOS_SIGNATURE_VERSION,
    pending.nameChange && NAME_ACK_VERSION,
    pending.card && CARD_AUTH_VERSION,
  ].filter(Boolean) as string[];
  const rows: any[] = [];
  for (const v of versions) {
    const [row] = await UserTermsAcceptance.findOrCreate({ where: { userId: user.id, termsVersion: v }, defaults: { ...base, termsVersion: v } as any });
    rows.push(row);
  }
  logger.info('Login signature recorded', { userId: user.id, versions });

  // Emailed copy of exactly what they signed (their records + dispute evidence).
  if (rows.length) {
    const when = base.acceptedAt.toUTCString();
    const items: string[] = [];
    if (pending.tos) items.push(`I have read and agree to the Domilea <a href="https://www.domilea.com/terms">Terms of Service</a> and <a href="https://www.domilea.com/privacy">Privacy Policy</a>, including the Payment Terms, Subscription Billing and Dispute Prohibition policies. All payments are final.`);
    if (pending.nameChange) items.push(`My account name has been updated to the legal name on my government ID: <strong>${esc(pending.nameChange.accountName)}</strong> (previously "${esc(pending.nameChange.signupName)}"), and that is my correct legal name.`);
    if (pending.card) items.push(`The payment card in the name <strong>${esc(pending.card.cardholderName)}</strong> used on my Domilea account is mine, or I am authorized by the cardholder to use it. All charges to it for my Domilea account are authorized, and I will not dispute them.`);
    emailService.sendEmail({
      to: user.email,
      subject: 'Your signed confirmation - Domilea',
      html: `
        <h2>Thanks for signing</h2>
        <p>Hi ${esc(user.name)},</p>
        <p>On ${when} you electronically signed, as <strong>${esc(signatureName)}</strong>, the following:</p>
        <ul>${items.map((i) => `<li style="margin-bottom:8px">${i}</li>`).join('')}</ul>
        <p>Signature record ID(s): ${rows.map((r) => r.id).join(', ')}</p>`,
    }).catch((e) => logger.warn('Signature email failed', { error: (e as Error).message }));
  }

  res.status(201).json({ success: true, data: { signed: versions } });
});
