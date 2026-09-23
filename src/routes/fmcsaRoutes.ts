import { Router } from 'express';
import {
  lookupByDOT,
  lookupByMC,
  getCarrierSnapshot,
  getAuthorityHistory,
  getInsuranceHistory,
  verifyMC,
  getSMSData,
  getCargoCarried,
} from '../controllers/fmcsaController';
import { authenticate, optionalAuth } from '../middleware/auth';
import { anonymousLookupLimiter, fmcsaLimiter } from '../middleware/rateLimiter';

const router = Router();

// Public lookups by MC — the home page, product page and pricing estimator use
// these before signup. Anonymous callers are held to a few per hour so they
// can't sweep an MC range to unmask a listing; signed-in users get the normal
// FMCSA limit.
router.get('/mc/:mcNumber', optionalAuth, anonymousLookupLimiter, fmcsaLimiter, lookupByMC);
router.get('/verify/:mcNumber', optionalAuth, anonymousLookupLimiter, fmcsaLimiter, verifyMC);

// Everything else is only called from signed-in pages.
router.get('/dot/:dotNumber', authenticate, fmcsaLimiter, lookupByDOT);
router.get('/snapshot/:identifier', authenticate, fmcsaLimiter, getCarrierSnapshot);
router.get('/authority/:dotNumber', authenticate, fmcsaLimiter, getAuthorityHistory);
router.get('/insurance/:dotNumber', authenticate, fmcsaLimiter, getInsuranceHistory);
router.get('/sms/:dotNumber', authenticate, fmcsaLimiter, getSMSData);
router.get('/cargo-carried/:dotNumber', authenticate, fmcsaLimiter, getCargoCarried);

export default router;
