import { Router } from 'express';
import { getCarrierReport, refreshCarrierReport } from '../controllers/carrierDataController';
import { authenticate, optionalAuth } from '../middleware/auth';
import { blockFlaggedIps } from '../middleware/ipBlock';
import { anonymousCarrierDataLimiter, fmcsaLimiter } from '../middleware/rateLimiter';

const router = Router();

// Public (cached 24hr) — the Carrier Pulse preview loads it for logged-out
// visitors, who are capped per IP per hour.
router.get('/report/:dotNumber', optionalAuth, blockFlaggedIps, anonymousCarrierDataLimiter, fmcsaLimiter, getCarrierReport);

// Authenticated — force refresh cache
router.post('/report/:dotNumber/refresh', authenticate, refreshCarrierReport);

export default router;
