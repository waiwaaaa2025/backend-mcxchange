import { Router, Request, Response } from 'express';
import { PdfPurchase } from '../models';
import { getPresignedUrl } from '../middleware/upload';
import logger from '../utils/logger';

const router = Router();

const GUIDE_S3_KEY = process.env.GUIDE_PDF_S3_KEY || 'guides/how-to-buy-trucking-business-v1.pdf';
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

export default router;
