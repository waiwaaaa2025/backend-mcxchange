import { Router, Request, Response } from 'express';
import { PdfPurchase } from '../models';
import { getPresignedUrl } from '../middleware/upload';
import stripeService from '../services/stripeService';
import logger from '../utils/logger';

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

  const signed = await getPresignedUrl(GUIDE_S3_KEY, SIGNED_URL_TTL_SECONDS);
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
 * GET /api/guide/download-by-session?session_id=cs_...
 *
 * Stripe redirects buyers here after payment ("After payment → Redirect to URL"
 * on the Payment Link). Verifies the Checkout Session is paid and that one of
 * its line items matches a guide price, then redirects to a presigned S3 URL
 * so the PDF downloads immediately — no email round-trip required.
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

  let session;
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

  const guidePriceId = process.env.STRIPE_PRICE_GUIDE_PDF;
  const bundlePriceId = process.env.STRIPE_PRICE_GUIDE_BUNDLE;
  const metadataType = session.metadata?.type;
  const priceIds = (session.line_items?.data || [])
    .map((li) => li.price?.id)
    .filter((id): id is string => Boolean(id));
  const matchesGuide =
    metadataType === 'guide_pdf' ||
    metadataType === 'guide_pdf_bundle' ||
    (guidePriceId && priceIds.includes(guidePriceId)) ||
    (bundlePriceId && priceIds.includes(bundlePriceId));

  if (!matchesGuide) {
    logger.warn('download-by-session: session does not match a guide purchase', {
      sessionId,
      metadataType,
      priceIds,
    });
    res.status(403).send('This payment is not for the Buyer\'s Guide.');
    return;
  }

  const signed = await getPresignedUrl(
    GUIDE_S3_KEY,
    SIGNED_URL_TTL_SECONDS,
    `attachment; filename="${GUIDE_DOWNLOAD_FILENAME}"`
  );
  if (!signed) {
    logger.error('download-by-session: S3 not configured', { sessionId, key: GUIDE_S3_KEY });
    res.status(503).send('Download is temporarily unavailable. Please contact support.');
    return;
  }

  logger.info('Guide PDF downloaded via session redirect', {
    sessionId,
    email: session.customer_details?.email,
  });

  res.redirect(302, signed);
});

export default router;
