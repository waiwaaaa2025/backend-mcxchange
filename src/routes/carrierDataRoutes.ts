import { Router } from 'express';
import { getCarrierReport, refreshCarrierReport } from '../controllers/carrierDataController';
import { authenticate } from '../middleware/auth';
import { fmcsaLimiter } from '../middleware/rateLimiter';

const router = Router();

// Signed-in only (cached 24hr). Every caller is a logged-in page, and left open
// it answered "which carrier is this DOT?" for anyone sweeping numbers.
router.get('/report/:dotNumber', authenticate, fmcsaLimiter, getCarrierReport);

// Authenticated — force refresh cache
router.post('/report/:dotNumber/refresh', authenticate, refreshCarrierReport);

export default router;
