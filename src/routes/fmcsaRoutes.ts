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
import { optionalAuth } from '../middleware/auth';
import { lookupRegulations } from '../services/cfrRegulationService';
import { anonymousCarrierDataLimiter, anonymousLookupLimiter, fmcsaLimiter } from '../middleware/rateLimiter';

const router = Router();

// Regulation text (49 CFR, via eCFR) for FMCSA violation codes — public law, so
// no auth; the FMCSA limiter keeps it from being used as an eCFR proxy.
router.get('/regulations', fmcsaLimiter, async (req, res) => {
  const codes = String(req.query.codes || '').split(',').map((c) => c.trim()).filter(Boolean).slice(0, 60);
  if (codes.length === 0) return res.json({ success: true, data: {} });
  try {
    res.json({ success: true, data: await lookupRegulations(codes) });
  } catch {
    res.status(502).json({ success: false, error: 'Regulation lookup unavailable' });
  }
});

// Public lookups by MC — the home page, product page and pricing estimator use
// these before signup. Anonymous callers are held to a few per hour so they
// can't sweep an MC range to unmask a listing; signed-in users get the normal
// FMCSA limit.
router.get('/mc/:mcNumber', optionalAuth, anonymousLookupLimiter, fmcsaLimiter, lookupByMC);
router.get('/verify/:mcNumber', optionalAuth, anonymousLookupLimiter, fmcsaLimiter, verifyMC);

// Carrier detail by DOT. Public too: the Carrier Pulse preview renders these
// for logged-out visitors. With MC/DOT fully masked on listings there is no
// partial number left to sweep, so a per-IP hourly cap is enough here.
const carrierData = [optionalAuth, anonymousCarrierDataLimiter, fmcsaLimiter];
router.get('/dot/:dotNumber', ...carrierData, lookupByDOT);
router.get('/snapshot/:identifier', ...carrierData, getCarrierSnapshot);
router.get('/authority/:dotNumber', ...carrierData, getAuthorityHistory);
router.get('/insurance/:dotNumber', ...carrierData, getInsuranceHistory);
router.get('/sms/:dotNumber', ...carrierData, getSMSData);
router.get('/cargo-carried/:dotNumber', ...carrierData, getCargoCarried);

export default router;
