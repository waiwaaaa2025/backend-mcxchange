import { Response } from 'express';
import { AuthRequest } from '../types';
import { User, UserRole, UserTermsAcceptance } from '../models';
import { emailService } from '../services/emailService';
import logger from '../utils/logger';
import { asyncHandler } from '../middleware/errorHandler';

/**
 * Typed-signature agreement to the Terms of Service + Privacy Policy, asked of
 * every member (new or old) once. The signup checkbox ('register-checkbox-*')
 * and the listing NDA ('1.0') are separate records and don't count here.
 * Stored in user_terms_acceptances with IP + user agent as dispute evidence.
 */
export const TOS_SIGNATURE_VERSION = 'tos-signature-1.0';

const clientIp = (req: AuthRequest) =>
  (req.headers['x-forwarded-for']?.toString().split(',')[0].trim()) || req.ip || undefined;

// GET /api/auth/terms-signature
export const getTermsSignatureStatus = asyncHandler(async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user) { res.status(401).json({ success: false, error: 'Not authenticated' }); return; }
  if (req.user.role === UserRole.ADMIN) {
    res.json({ success: true, data: { required: false, signed: true, version: TOS_SIGNATURE_VERSION } });
    return;
  }
  const row = await UserTermsAcceptance.findOne({ where: { userId: req.user.id, termsVersion: TOS_SIGNATURE_VERSION } });
  res.json({
    success: true,
    data: {
      required: !row,
      signed: !!row,
      version: TOS_SIGNATURE_VERSION,
      signedAt: row?.acceptedAt || null,
      signatureName: row?.signatureName || null,
    },
  });
});

// POST /api/auth/terms-signature  { signatureName, agreed: true }
export const signTerms = asyncHandler(async (req: AuthRequest, res: Response): Promise<void> => {
  if (!req.user) { res.status(401).json({ success: false, error: 'Not authenticated' }); return; }
  const signatureName = String(req.body?.signatureName || '').trim().replace(/\s+/g, ' ');
  if (req.body?.agreed !== true) {
    res.status(400).json({ success: false, error: 'Check the box to agree to the Terms of Service and Privacy Policy.' });
    return;
  }
  if (signatureName.length < 3 || !signatureName.includes(' ') || signatureName.length > 255) {
    res.status(400).json({ success: false, error: 'Type your full legal name (first and last) as your signature.' });
    return;
  }
  const existing = await UserTermsAcceptance.findOne({ where: { userId: req.user.id, termsVersion: TOS_SIGNATURE_VERSION } });
  if (existing) {
    res.json({ success: true, data: { signed: true, signedAt: existing.acceptedAt, signatureName: existing.signatureName } });
    return;
  }
  const row = await UserTermsAcceptance.create({
    userId: req.user.id,
    signatureName,
    termsVersion: TOS_SIGNATURE_VERSION,
    acceptedAt: new Date(),
    ipAddress: clientIp(req)?.slice(0, 45),
    userAgent: req.headers['user-agent'] || undefined,
  } as any);
  logger.info('Terms signed', { userId: req.user.id, version: TOS_SIGNATURE_VERSION });

  // Copy to the member for their records (also strengthens dispute evidence).
  User.findByPk(req.user.id).then((u) => u && emailService.sendEmail({
    to: u.email,
    subject: 'Your signed agreement - Domilea Terms of Service',
    html: `
      <h2>Thanks for signing</h2>
      <p>Hi ${u.name},</p>
      <p>This confirms that on ${row.acceptedAt.toUTCString()} you electronically signed, as <strong>${signatureName.replace(/[<>&"]/g, '')}</strong>,
      your agreement to the Domilea <a href="https://www.domilea.com/terms">Terms of Service</a> and
      <a href="https://www.domilea.com/privacy">Privacy Policy</a>, including the Payment Terms, Subscription Billing and Dispute Prohibition policies.
      All payments are final.</p>
      <p>Signature record ID: ${row.id}</p>`,
  })).catch((e) => logger.warn('Terms signature email failed', { error: (e as Error).message }));

  res.status(201).json({ success: true, data: { signed: true, signedAt: row.acceptedAt, signatureName } });
});
