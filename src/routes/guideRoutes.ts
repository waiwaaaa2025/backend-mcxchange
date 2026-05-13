import { Router, Request, Response } from 'express';
import { PdfPurchase, PdfPurchaseTier, User } from '../models';
import { getPresignedUrl } from '../middleware/upload';
import stripeService from '../services/stripeService';
import logger from '../utils/logger';
import { config } from '../config';
import {
  processPdfPurchase,
  processBundlePurchase,
  getOrCreateSetupLink,
  hasBundlePromoAccess,
} from '../services/buyerGuideService';
import Stripe from 'stripe';

const router = Router();

const GUIDE_S3_KEY = process.env.GUIDE_PDF_S3_KEY || 'guides/how-to-buy-trucking-business-v1.pdf';
const GUIDE_DOWNLOAD_FILENAME = 'how-to-buy-trucking-business.pdf';
const SIGNED_URL_TTL_SECONDS = 300; // 5 minutes — long enough to follow redirect

/**
 * GET /api/guide/download?t=<token>
 *
 * Public route. Looks up the purchase by token, generates a short-lived
 * presigned S3 URL for the guide PDF, and redirects the browser to it.
 */
router.get('/download', async (req: Request, res: Response): Promise<void> => {
  const token = String(req.query.t || '').trim();
  if (!token || token.length < 16) {
    res.status(400).send('Invalid download link.');
    return;
  }

  const purchase = await PdfPurchase.findOne({ where: { downloadToken: token } });
  if (!purchase) {
    res.status(404).send('Download link not recognized. Check your email for the correct link.');
    return;
  }

  const signed = await getPresignedUrl(
    GUIDE_S3_KEY,
    SIGNED_URL_TTL_SECONDS,
    `attachment; filename="${GUIDE_DOWNLOAD_FILENAME}"`
  );
  if (!signed) {
    logger.error('Guide download requested but S3 not configured', {
      purchaseId: purchase.id,
      key: GUIDE_S3_KEY,
    });
    res.status(503).send('Download is temporarily unavailable. Please contact support.');
    return;
  }

  await purchase.update({
    downloadCount: purchase.downloadCount + 1,
    lastDownloadedAt: new Date(),
  });

  logger.info('Guide PDF downloaded', {
    purchaseId: purchase.id,
    email: purchase.email,
    tier: purchase.tier,
    downloadCount: purchase.downloadCount + 1,
  });

  res.redirect(302, signed);
});

/**
 * Identify whether a Stripe Checkout Session matches a guide purchase, and which tier.
 * Returns null if no match.
 */
function detectTierFromSession(
  session: Stripe.Checkout.Session
): PdfPurchaseTier | null {
  const guidePriceId = process.env.STRIPE_PRICE_GUIDE_PDF;
  const bundlePriceId = process.env.STRIPE_PRICE_GUIDE_BUNDLE;
  const metadataType = session.metadata?.type;
  const priceIds = (session.line_items?.data || [])
    .map((li) => li.price?.id)
    .filter((id): id is string => Boolean(id));

  if (metadataType === 'guide_pdf_bundle') return PdfPurchaseTier.PDF_PLUS_60DAY;
  if (metadataType === 'guide_pdf') return PdfPurchaseTier.PDF;
  if (bundlePriceId && priceIds.includes(bundlePriceId)) return PdfPurchaseTier.PDF_PLUS_60DAY;
  if (guidePriceId && priceIds.includes(guidePriceId)) return PdfPurchaseTier.PDF;
  return null;
}

/**
 * GET /api/guide/download-by-session?session_id=cs_...
 *
 * Stripe redirects buyers here after payment ("After payment → Redirect to URL"
 * on the Payment Link). Verifies the Checkout Session is paid and that it
 * matches a guide purchase, then redirects to the frontend thank-you page so
 * the buyer sees their account-setup CTA (bundle) alongside the auto-download.
 *
 * The webhook still runs in parallel to create the PdfPurchase row and send
 * the email backup link.
 */
router.get('/download-by-session', async (req: Request, res: Response): Promise<void> => {
  const sessionId = String(req.query.session_id || '').trim();
  if (!sessionId.startsWith('cs_')) {
    res.status(400).send('Invalid session.');
    return;
  }

  const stripe = stripeService.getStripe();
  if (!stripe) {
    logger.error('download-by-session called but Stripe not configured');
    res.status(503).send('Download is temporarily unavailable. Please contact support.');
    return;
  }

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items'] });
  } catch (err) {
    logger.warn('download-by-session: failed to retrieve session', { sessionId, err });
    res.status(404).send('Session not found.');
    return;
  }

  if (session.payment_status !== 'paid') {
    res.status(402).send(
      'Payment is still processing. Please check your email for the download link in a few minutes.'
    );
    return;
  }

  const tier = detectTierFromSession(session);
  if (!tier) {
    logger.warn('download-by-session: session does not match a guide purchase', { sessionId });
    res.status(403).send('This payment is not for the Buyer\'s Guide.');
    return;
  }

  const target = `${config.frontendUrl.replace(/\/$/, '')}/guide/thank-you?session_id=${encodeURIComponent(sessionId)}`;
  res.redirect(302, target);
});

/**
 * GET /api/guide/post-purchase?session_id=cs_...
 *
 * Called by the frontend thank-you page. Verifies the Stripe session is paid,
 * provisions the PdfPurchase row and (for bundle) the user + 60-day promo
 * on demand if the webhook hasn't fired yet, and returns the data the page
 * needs to auto-download the PDF and show the right account-setup CTA.
 */
router.get('/post-purchase', async (req: Request, res: Response): Promise<void> => {
  const sessionId = String(req.query.session_id || '').trim();
  if (!sessionId.startsWith('cs_')) {
    res.status(400).json({ success: false, error: 'Invalid session.' });
    return;
  }

  const stripe = stripeService.getStripe();
  if (!stripe) {
    logger.error('post-purchase called but Stripe not configured');
    res.status(503).json({ success: false, error: 'Service temporarily unavailable.' });
    return;
  }

  let session: Stripe.Checkout.Session;
  try {
    session = await stripe.checkout.sessions.retrieve(sessionId, { expand: ['line_items'] });
  } catch (err) {
    logger.warn('post-purchase: failed to retrieve session', { sessionId, err });
    res.status(404).json({ success: false, error: 'Session not found.' });
    return;
  }

  if (session.payment_status !== 'paid') {
    res.status(402).json({
      success: false,
      error: 'Payment is still processing. Please check back in a moment.',
      code: 'PAYMENT_PENDING',
    });
    return;
  }

  const tier = detectTierFromSession(session);
  if (!tier) {
    res.status(403).json({ success: false, error: 'This payment is not for the Buyer\'s Guide.' });
    return;
  }

  // Provision on demand if the webhook hasn't fired yet. Both helpers are
  // idempotent on stripeSessionId.
  if (tier === PdfPurchaseTier.PDF_PLUS_60DAY) {
    await processBundlePurchase(session);
  } else {
    await processPdfPurchase(session);
  }

  const purchase = await PdfPurchase.findOne({ where: { stripeSessionId: sessionId } });
  if (!purchase) {
    logger.error('post-purchase: purchase row missing after provisioning', { sessionId });
    res.status(500).json({ success: false, error: 'Purchase record not found.' });
    return;
  }

  const apiBase = (config.apiUrl || '').replace(/\/$/, '');
  const downloadUrl = `${apiBase}/api/guide/download?t=${purchase.downloadToken}`;

  if (tier === PdfPurchaseTier.PDF) {
    res.json({
      success: true,
      data: {
        tier: 'pdf',
        email: purchase.email,
        downloadUrl,
      },
    });
    return;
  }

  // Bundle: surface the setup-password CTA (or sign-in if they've already
  // claimed the account) plus the promo expiry.
  const user = purchase.userId ? await User.findByPk(purchase.userId) : null;
  let setupUrl: string | null = null;
  let isClaimed = false;
  if (user) {
    isClaimed = Boolean(user.lastLoginAt);
    if (!isClaimed) {
      setupUrl = await getOrCreateSetupLink(user);
    }
  }

  const signInUrl = `${config.frontendUrl.replace(/\/$/, '')}/login?email=${encodeURIComponent(purchase.email)}`;
  const promoActive = user ? hasBundlePromoAccess(user) : false;

  res.json({
    success: true,
    data: {
      tier: 'bundle',
      email: purchase.email,
      downloadUrl,
      setupUrl,
      signInUrl,
      isClaimed,
      promoActive,
      promoExpiresAt: user?.promoAccessExpiresAt || null,
    },
  });
});

export default router;
