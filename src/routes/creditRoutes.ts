import { Router } from 'express';
import {
  getBalance,
  getHistory,
  getPlans,
  getCurrentSubscription,
  subscribe,
  cancelSubscription,
  addBonusCredits,
  refundCredits,
  checkCredits,
  subscribeValidation,
  addBonusCreditsValidation,
  getCreditPacks,
  purchaseCreditPack,
} from '../controllers/creditController';
import { authenticate, adminOnly } from '../middleware/auth';
import validate from '../middleware/validate';

const router = Router();

// Public routes
router.get('/plans', getPlans);
router.get('/packs', getCreditPacks);

// Protected routes
router.use(authenticate);

// User routes
router.get('/balance', getBalance);
router.get('/history', getHistory);
router.get('/check', checkCredits);
router.get('/subscription', getCurrentSubscription);
router.post('/subscribe', validate(subscribeValidation), subscribe);
router.post('/cancel-subscription', cancelSubscription);
router.post('/packs/:packId/checkout', purchaseCreditPack);

// Admin routes
router.post('/bonus', adminOnly, validate(addBonusCreditsValidation), addBonusCredits);
router.post('/refund', adminOnly, refundCredits);

export default router;
