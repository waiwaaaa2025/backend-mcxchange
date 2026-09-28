import { Router } from 'express';
import { getCarrierReport, refreshCarrierReport, getChameleonIntel } from '../controllers/carrierDataController';
import { authenticate, optionalAuth } from '../middleware/auth';
import { anonymousCarrierDataLimiter, fmcsaLimiter } from '../middleware/rateLimiter';

const router = Router();

// Public (cached 24hr) — the Carrier Pulse preview loads it for logged-out
// visitors, who are capped per IP per hour.
router.get('/report/:dotNumber', optionalAuth, anonymousCarrierDataLimiter, fmcsaLimiter, getCarrierReport);

// Authenticated — Chameleon Check cross-references (VINs under other DOTs etc.)
router.get('/chameleon/:dotNumber', authenticate, fmcsaLimiter, getChameleonIntel);

// Authenticated — force refresh cache
router.post('/report/:dotNumber/refresh', authenticate, refreshCarrierReport);

export default router;
