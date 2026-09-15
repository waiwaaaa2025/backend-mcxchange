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
  getInsuranceLeadsAccess,
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
  getInsuranceLeads,
  requestBrokerOutreach,
} from '../controllers/buyerController';
import { authenticate, buyerOnly, requireSubscription, requireProfessionalSubscription, requireEnterpriseSubscription } from '../middleware/auth';

const router = Router();

// All routes require authentication.
router.use(authenticate);

// Subscription routes — authenticated users of ANY role may read/purchase/cancel
// their subscription. This lets non-buyers (e.g. sellers) subscribe to cross-role
// products like Lead Generator. Plan-level role enforcement (buyer-marketplace
// plans stay buyer/admin only) lives in createSubscriptionCheckout.
router.get('/subscription', getSubscription);
router.post('/subscription/checkout', createSubscriptionCheckout);
router.post('/subscription/cancel', cancelSubscription);
router.post('/subscription/verify', verifySubscription);

// Everything below requires buyer (or admin) role.
router.use(buyerOnly);

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

// Pending Insurance Leads - same access gate as CarrierPulse (handled in endpoint)
router.get('/insurance-leads', getInsuranceLeads);
router.get('/insurance-leads/access', getInsuranceLeadsAccess);
router.post('/insurance-leads/:dotNumber/request-outreach', requestBrokerOutreach);

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
