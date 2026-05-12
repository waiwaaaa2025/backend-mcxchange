import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import Stripe from 'stripe';
import { addDays } from 'date-fns';
import { Op } from 'sequelize';
import {
  User,
  PdfPurchase,
  PdfPurchaseTier,
  PasswordResetToken,
  UserRole,
  UserStatus,
} from '../models';
import { emailService } from '../services/emailService';
import { config } from '../config';
import logger from '../utils/logger';

const BUNDLE_DAYS = 60;
const SETUP_TOKEN_DAYS = 7;
const PROMO_ACCESS_TYPE = 'pdf_bundle_60day';

export interface GuidePurchaseResult {
  purchase: PdfPurchase;
  user?: User;
  isNewUser: boolean;
  setupUrl?: string;
}

/**
 * Record a purchase row (idempotent on stripeSessionId).
 * Returns existing row if already recorded.
 */
async function recordPurchase(
  session: Stripe.Checkout.Session,
  tier: PdfPurchaseTier,
  email: string
): Promise<{ purchase: PdfPurchase; created: boolean }> {
  const existing = await PdfPurchase.findOne({
    where: { stripeSessionId: session.id },
  });
  if (existing) {
    return { purchase: existing, created: false };
  }

  const downloadToken = crypto.randomBytes(32).toString('hex');
  const purchase = await PdfPurchase.create({
    email: email.toLowerCase(),
    stripeSessionId: session.id,
    tier,
    downloadToken,
    amountCents: session.amount_total ?? null,
  });
  return { purchase, created: true };
}

/**
 * Find a user by email, or create a new BUYER account with a random password.
 * Returns the user and whether it was newly created.
 */
async function findOrCreateBuyer(email: string): Promise<{ user: User; isNew: boolean }> {
  const normalized = email.toLowerCase();
  const existing = await User.findOne({ where: { email: normalized } });
  if (existing) {
    return { user: existing, isNew: false };
  }

  const randomPassword = crypto.randomBytes(24).toString('hex');
  const hashedPassword = await bcrypt.hash(randomPassword, config.security.bcryptRounds);

  const user = await User.create({
    email: normalized,
    password: hashedPassword,
    name: normalized.split('@')[0],
    role: UserRole.BUYER,
    status: UserStatus.ACTIVE,
    verified: false,
    trustScore: 50,
    memberSince: new Date(),
    totalCredits: 0,
    usedCredits: 0,
    sellerVerified: false,
    emailVerified: false,
    identityVerified: false,
    carrierPulseAccess: false,
  });

  return { user, isNew: true };
}

/**
 * Grant or extend 60-day promo access. Never shortens an existing longer window.
 */
async function grantPromoAccess(user: User): Promise<void> {
  const newExpiry = addDays(new Date(), BUNDLE_DAYS);
  const currentExpiry = user.promoAccessExpiresAt;
  const finalExpiry =
    currentExpiry && currentExpiry > newExpiry ? currentExpiry : newExpiry;

  await user.update({
    promoAccessType: PROMO_ACCESS_TYPE,
    promoAccessExpiresAt: finalExpiry,
  });
}

/**
 * Create a one-time setup link the user can click to set a password.
 * Reuses PasswordResetToken machinery with a longer 7-day expiry.
 */
async function createSetupLink(user: User): Promise<string> {
  await PasswordResetToken.destroy({ where: { userId: user.id } });

  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');

  await PasswordResetToken.create({
    token,
    tokenHash,
    userId: user.id,
    expiresAt: addDays(new Date(), SETUP_TOKEN_DAYS),
  });

  return `${config.frontendUrl}/reset-password?token=${token}&setup=1`;
}

function downloadUrl(token: string): string {
  return `${config.apiUrl || config.frontendUrl}/api/guide/download?t=${token}`;
}

async function sendPdfOnlyEmail(purchase: PdfPurchase): Promise<void> {
  const url = downloadUrl(purchase.downloadToken);
  const html = `
    <h2>Thanks for buying the Trucking Buyer's Guide</h2>
    <p>Your download is ready. Click below to get your PDF:</p>
    <p><a href="${url}" style="display:inline-block;padding:12px 20px;background:#0b6dff;color:#fff;text-decoration:none;border-radius:6px">Download the Guide (PDF)</a></p>
    <p>This link is tied to your purchase. Keep this email — you can re-download anytime.</p>
    <p style="color:#666;font-size:12px">All payments are final.</p>
  `;

  await emailService.sendEmail({
    to: purchase.email,
    subject: 'Your Trucking Buyer\'s Guide is ready',
    html,
  });
}

async function sendBundleEmail(
  purchase: PdfPurchase,
  setupUrl: string | undefined,
  isNewUser: boolean
): Promise<void> {
  const downloadHref = downloadUrl(purchase.downloadToken);
  const accountBlock = setupUrl
    ? `<p><strong>Step 2 — activate your 60 days of Due Diligence access:</strong></p>
       <p><a href="${setupUrl}" style="display:inline-block;padding:12px 20px;background:#0b6dff;color:#fff;text-decoration:none;border-radius:6px">${isNewUser ? 'Set Your Password' : 'Sign In'}</a></p>
       <p>You'll get 60 days of unlimited Chameleon checks, UCC filings, tax-lien lookups, Safety Improvement Reports, and daily BASIC score updates.</p>`
    : '';

  const html = `
    <h2>Welcome — your Buyer's Guide + 60-Day Due Diligence Access</h2>
    <p><strong>Step 1 — download the guide:</strong></p>
    <p><a href="${downloadHref}" style="display:inline-block;padding:12px 20px;background:#0b6dff;color:#fff;text-decoration:none;border-radius:6px">Download the Guide (PDF)</a></p>
    ${accountBlock}
    <p style="color:#666;font-size:12px">All payments are final.</p>
  `;

  await emailService.sendEmail({
    to: purchase.email,
    subject: 'Your Trucking Buyer\'s Guide + 60-day access',
    html,
  });
}

/**
 * Process a paid Stripe checkout session for the PDF-only tier.
 */
export async function processPdfPurchase(
  session: Stripe.Checkout.Session
): Promise<GuidePurchaseResult | null> {
  const email = session.customer_details?.email || session.customer_email;
  if (!email) {
    logger.warn('PDF purchase missing customer email', { sessionId: session.id });
    return null;
  }

  const { purchase, created } = await recordPurchase(
    session,
    PdfPurchaseTier.PDF,
    email
  );

  if (!created) {
    logger.info('PDF purchase already recorded — skipping email', {
      sessionId: session.id,
    });
    return { purchase, isNewUser: false };
  }

  await sendPdfOnlyEmail(purchase);
  logger.info('PDF purchase processed', { sessionId: session.id, email });
  return { purchase, isNewUser: false };
}

/**
 * Process a paid Stripe checkout session for the PDF + 60-day-access bundle.
 */
export async function processBundlePurchase(
  session: Stripe.Checkout.Session
): Promise<GuidePurchaseResult | null> {
  const email = session.customer_details?.email || session.customer_email;
  if (!email) {
    logger.warn('Bundle purchase missing customer email', { sessionId: session.id });
    return null;
  }

  const { purchase, created } = await recordPurchase(
    session,
    PdfPurchaseTier.PDF_PLUS_60DAY,
    email
  );

  const { user, isNew } = await findOrCreateBuyer(email);
  await grantPromoAccess(user);

  if (!purchase.userId) {
    await purchase.update({ userId: user.id });
  }

  if (!created) {
    logger.info('Bundle purchase already recorded — skipping email', {
      sessionId: session.id,
    });
    return { purchase, user, isNewUser: isNew };
  }

  const setupUrl = isNew ? await createSetupLink(user) : undefined;
  await sendBundleEmail(purchase, setupUrl, isNew);
  logger.info('Bundle purchase processed', {
    sessionId: session.id,
    email,
    userId: user.id,
    isNewUser: isNew,
  });

  return { purchase, user, isNewUser: isNew, setupUrl };
}

/**
 * Returns true if a user currently has an active 60-day buyer's-guide promo.
 */
export function hasBundlePromoAccess(user: User): boolean {
  if (user.promoAccessType !== PROMO_ACCESS_TYPE) return false;
  if (!user.promoAccessExpiresAt) return false;
  return user.promoAccessExpiresAt.getTime() > Date.now();
}

/**
 * Expire any promo-access rows past their cutoff. Returns the affected user IDs.
 */
export async function expireOverdueBundleAccess(): Promise<string[]> {
  const users = await User.findAll({
    where: {
      promoAccessType: PROMO_ACCESS_TYPE,
      promoAccessExpiresAt: { [Op.lt]: new Date() },
    },
  });

  for (const user of users) {
    await user.update({
      promoAccessType: undefined,
      promoAccessExpiresAt: undefined,
    });
    logger.info('Expired buyer-bundle promo access', { userId: user.id });
  }

  return users.map((u) => u.id);
}
