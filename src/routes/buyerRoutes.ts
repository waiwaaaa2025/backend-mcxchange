import { Router } from 'express';
import {
  getDashboardStats,
  getOffers,
  getPurchases,
  getSavedListings,
  getUnlockedListings,
  getSubscription,
  getTransactions,
  getStripePaymentHistory,
  createSubscriptionCheckout,
  cancelSubscription,
  verifySubscription,
  createPremiumRequest,
  getPremiumRequests,
  getTermsStatus,
  acceptTerms,
  getCreditsafeSearch,
  getCreditsafeReport,
  getCreditsafeFreeSearch,
  getCarrierPulseAccess,
  createCarrierPulseCheckout,
  getCarrierPulseCreditsafeSearch,
  getCarrierPulseCreditsafeReport,
  checkOrUnlockCreditReport,
  createCreditReportCheckout,
  checkCreditReportPurchase,
  creditsafeOpenSearch,
  creditsafePurchasedReport,
  getMyPreferences,
  updateMyPreferences,
  getMyMatches,
} from '../controllers/buyerController';
import { authenticate, buyerOnly, requireSubscription, requireProfessionalSubscription, requireEnterpriseSubscription } from '../middleware/auth';

const router = Router();

// All buyer routes require authentication and buyer role
router.use(authenticate);
router.use(buyerOnly);

// Subscription routes - no subscription required (so users can subscribe)
router.get('/subscription', getSubscription);
router.post('/subscription/checkout', createSubscriptionCheckout);
router.post('/subscription/cancel', cancelSubscription);
router.post('/subscription/verify', verifySubscription);

// Dashboard - no subscription required (shows subscription status)
router.get('/dashboard', getDashboardStats);

// Routes that require active subscription
router.get('/offers', requireSubscription, getOffers);
router.get('/purchases', requireSubscription, getPurchases);
router.get('/saved', requireSubscription, getSavedListings);
router.get('/unlocked', requireSubscription, getUnlockedListings);
router.get('/transactions', getTransactions);

// Premium requests - require subscription to request premium access
router.post('/premium-requests', requireSubscription, createPremiumRequest);
router.get('/premium-requests', requireSubscription, getPremiumRequests);

// Stripe payment history - no subscription required (to see payment history)
router.get('/stripe-history', getStripePaymentHistory);

// Creditsafe credit reports
// VIP-only: free-form Creditsafe search (no listing required) — must be before :listingId route
router.get('/creditsafe/search', requireEnterpriseSubscription, getCreditsafeFreeSearch);
router.get('/creditsafe/search/:listingId', requireProfessionalSubscription, getCreditsafeSearch);
router.get('/creditsafe/companies/:connectId', requireProfessionalSubscription, getCreditsafeReport);

// CarrierPulse - no subscription required (gating handled in endpoint)
router.get('/carrier-pulse/access', getCarrierPulseAccess);
router.post('/carrier-pulse/checkout', createCarrierPulseCheckout);
router.get('/carrier-pulse/creditsafe/search', getCarrierPulseCreditsafeSearch);
router.get('/carrier-pulse/creditsafe/report/:connectId', getCarrierPulseCreditsafeReport);
router.get('/carrier-pulse/credit-report/:dotNumber', requireSubscription, checkOrUnlockCreditReport);

// Credit report — open to all buyers (search free, report $35 or included in Premium)
router.get('/creditsafe/open-search', creditsafeOpenSearch);
router.get('/creditsafe/purchased-report/:connectId', creditsafePurchasedReport);
router.post('/creditsafe/checkout', createCreditReportCheckout);
router.get('/creditsafe/purchase/:connectId', checkCreditReportPurchase);

// Terms of Service - no subscription required
router.get('/terms-status', getTermsStatus);
router.post('/accept-terms', acceptTerms);

// Buyer preferences (what I'm looking to buy) + matches
router.get('/preferences', getMyPreferences);
router.put('/preferences', updateMyPreferences);
router.get('/matches', getMyMatches);

export default router;
