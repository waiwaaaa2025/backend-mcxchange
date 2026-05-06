import { Response } from 'express';
import { buyerService } from '../services/buyerService';
import { stripeService } from '../services/stripeService';
import { creditsafeService } from '../services/creditsafeService';
import { asyncHandler, BadRequestError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { parseIntParam } from '../utils/helpers';
import { config } from '../config';
import { User, UnlockedListing, Listing, Subscription, SubscriptionPlan, SubscriptionStatus, UserRole, CreditTransaction, CreditTransactionType, ListingStatus } from '../models';
import { creditService } from '../services/creditService';
import { buyerPreferencesService } from '../services/buyerPreferencesService';
import { rankListings, hasAnyCriteria } from '../services/matchService';

function maskNumber(num: string | null | undefined): string | null | undefined {
  if (!num) return num;
  const half = Math.ceil(num.length / 2);
  return num.substring(0, half) + '•'.repeat(num.length - half);
}

// Get buyer dashboard stats
export const getDashboardStats = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const stats = await buyerService.getDashboardStats(req.user.id);

  res.json({
    success: true,
    data: stats,
  });
});

// Get buyer's offers
export const getOffers = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const status = req.query.status as string | undefined;
  const page = parseIntParam(req.query.page as string) || 1;
  const limit = parseIntParam(req.query.limit as string) || 20;

  const result = await buyerService.getOffers(req.user.id, status, page, limit);

  res.json({
    success: true,
    data: result.offers,
    pagination: result.pagination,
  });
});

// Get buyer's purchases
export const getPurchases = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const page = parseIntParam(req.query.page as string) || 1;
  const limit = parseIntParam(req.query.limit as string) || 20;

  const result = await buyerService.getPurchases(req.user.id, page, limit);

  res.json({
    success: true,
    data: result.purchases,
    pagination: result.pagination,
  });
});

// Get saved listings
export const getSavedListings = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const page = parseIntParam(req.query.page as string) || 1;
  const limit = parseIntParam(req.query.limit as string) || 20;

  const result = await buyerService.getSavedListings(req.user.id, page, limit);

  res.json({
    success: true,
    data: result.listings,
    pagination: result.pagination,
  });
});

// Get unlocked listings
export const getUnlockedListings = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const page = parseIntParam(req.query.page as string) || 1;
  const limit = parseIntParam(req.query.limit as string) || 20;

  const result = await buyerService.getUnlockedListings(req.user.id, page, limit);

  res.json({
    success: true,
    data: result.listings,
    pagination: result.pagination,
  });
});

// Get subscription details
export const getSubscription = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const result = await buyerService.getSubscription(req.user.id);

  res.json({
    success: true,
    data: result,
  });
});

// Create subscription checkout session
export const createSubscriptionCheckout = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { plan, isYearly } = req.body;

  // Validate plan. VIP / Deal Access Pass is a one-time payment (handled below).
  const validPlans = ['starter', 'premium', 'enterprise', 'vip_access'];
  if (!plan || !validPlans.includes(plan)) {
    throw new BadRequestError('Invalid subscription plan');
  }

  // Get or create Stripe customer (validates existing ID and recreates if invalid)
  const customer = await stripeService.getOrCreateCustomer(
    req.user.id,
    req.user.email,
    req.user.name || req.user.email,
    req.user.stripeCustomerId || undefined
  );

  // Update user's stripeCustomerId if it changed (new customer created)
  if (customer.id !== req.user.stripeCustomerId) {
    await User.update({ stripeCustomerId: customer.id }, { where: { id: req.user.id } });
  }

  const frontendUrl = config.frontendUrl || 'http://localhost:5173';

  // VIP / Deal Access Pass — one-time payment, not a subscription
  if (plan === 'vip_access') {
    const vipResult = await stripeService.createVipPassCheckout({
      customerId: customer.id,
      userId: req.user.id,
      successUrl: `${frontendUrl}/buyer/subscription?success=true&vip=true`,
      cancelUrl: `${frontendUrl}/buyer/subscription?canceled=true`,
    });

    if (!vipResult.success) {
      throw new BadRequestError(vipResult.error || 'Failed to create VIP checkout session');
    }

    res.json({
      success: true,
      data: {
        sessionId: vipResult.sessionId,
        url: vipResult.url,
      },
    });
    return;
  }

  // Get the price ID for the selected subscription plan
  const priceId = stripeService.getPriceId(
    plan as 'starter' | 'premium' | 'enterprise',
    isYearly ? 'yearly' : 'monthly'
  );

  // Create checkout session
  const result = await stripeService.createCheckoutSession({
    customerId: customer.id,
    priceId,
    successUrl: `${frontendUrl}/buyer/subscription?success=true`,
    cancelUrl: `${frontendUrl}/buyer/subscription?canceled=true`,
    metadata: {
      userId: req.user.id,
      plan,
      isYearly: isYearly ? 'true' : 'false',
    },
  });

  if (!result.success) {
    throw new BadRequestError(result.error || 'Failed to create checkout session');
  }

  res.json({
    success: true,
    data: {
      sessionId: result.sessionId,
      url: result.url,
    },
  });
});

// Check CarrierPulse access for the current user
export const getCarrierPulseAccess = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const user = await User.findByPk(req.user.id);
  const subscription = await Subscription.findOne({ where: { userId: req.user.id } });

  const plan = subscription?.plan?.toUpperCase();
  const isActive = subscription?.status === SubscriptionStatus.ACTIVE;

  // CarrierPulse is included with any active subscription
  const includedInPlan = isActive;

  // Standalone CarrierPulse access (legacy: purchased separately before bundling)
  const hasStandaloneAccess = user?.carrierPulseAccess || false;

  // Admin always has access
  const isAdmin = req.user.role === UserRole.ADMIN;

  res.json({
    success: true,
    data: {
      hasAccess: includedInPlan || hasStandaloneAccess || isAdmin,
      reason: isAdmin ? 'admin' : includedInPlan ? 'included_in_plan' : hasStandaloneAccess ? 'standalone' : 'none',
      currentPlan: plan || null,
      isActive,
    },
  });
});

// Create CarrierPulse checkout session ($12.99/mo standalone or add-on for Starter)
export const createCarrierPulseCheckout = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  // Check if user already has CarrierPulse access
  const user = await User.findByPk(req.user.id);
  const subscription = await Subscription.findOne({ where: { userId: req.user.id } });
  const isActive = subscription?.status === SubscriptionStatus.ACTIVE;

  if (user?.carrierPulseAccess) {
    res.json({ success: false, error: 'You already have CarrierPulse access' });
    return;
  }

  if (isActive) {
    res.json({ success: false, error: 'CarrierPulse is already included in your subscription' });
    return;
  }

  // Get or create Stripe customer
  const customer = await stripeService.getOrCreateCustomer(
    req.user.id,
    req.user.email,
    req.user.name || req.user.email,
    req.user.stripeCustomerId || undefined
  );

  if (customer.id !== req.user.stripeCustomerId) {
    await User.update({ stripeCustomerId: customer.id }, { where: { id: req.user.id } });
  }

  const frontendUrl = config.frontendUrl || 'http://localhost:5173';
  const carrierPulsePriceId = process.env.STRIPE_PRICE_CARRIER_PULSE || 'price_1TC6kqFnDj2YhGIWZjMc7hWD';

  const result = await stripeService.createCheckoutSession({
    customerId: customer.id,
    priceId: carrierPulsePriceId,
    successUrl: `${frontendUrl}/buyer/carrier-pulse?purchase=success`,
    cancelUrl: `${frontendUrl}/buyer/carrier-pulse?purchase=canceled`,
    metadata: {
      userId: req.user.id,
      type: 'carrier_pulse',
    },
  });

  if (!result.success) {
    throw new BadRequestError(result.error || 'Failed to create checkout session');
  }

  res.json({
    success: true,
    data: {
      sessionId: result.sessionId,
      url: result.url,
    },
  });
});

// Cancel subscription
export const cancelSubscription = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const result = await buyerService.cancelSubscription(req.user.id);

  res.json({
    success: true,
    data: result,
  });
});

// Verify and fulfill subscription after Stripe checkout success
// This is called by frontend when redirected back from Stripe with success=true
export const verifySubscription = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const result = await buyerService.verifyAndFulfillSubscription(req.user.id);

  res.json({
    success: true,
    data: result,
  });
});

// Get buyer's transactions
export const getTransactions = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const page = parseIntParam(req.query.page as string) || 1;
  const limit = parseIntParam(req.query.limit as string) || 20;

  const result = await buyerService.getTransactions(req.user.id, page, limit);

  res.json({
    success: true,
    data: result.transactions,
    pagination: result.pagination,
  });
});

// Get buyer's Stripe payment history directly from Stripe
export const getStripePaymentHistory = asyncHandler(async (req: AuthRequest, res: Response) => {
  console.log('[getStripePaymentHistory] Starting...');
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  console.log('[getStripePaymentHistory] User:', req.user.id);

  // Get user's Stripe customer ID
  const { User } = await import('../models');
  const user = await User.findByPk(req.user.id);

  console.log('[getStripePaymentHistory] User from DB:', user?.id, 'stripeCustomerId:', user?.stripeCustomerId);

  if (!user || !user.stripeCustomerId) {
    console.log('[getStripePaymentHistory] No stripeCustomerId found, returning empty');
    res.json({
      success: true,
      data: {
        charges: [],
        paymentIntents: [],
        checkoutSessions: [],
        subscriptions: [],
      },
    });
    return;
  }

  console.log('[getStripePaymentHistory] Fetching from Stripe for customer:', user.stripeCustomerId);
  // Get payment history from Stripe
  const history = await stripeService.getCustomerPaymentHistory(user.stripeCustomerId);
  console.log('[getStripePaymentHistory] Got history:', {
    charges: history.charges.length,
    paymentIntents: history.paymentIntents.length,
    checkoutSessions: history.checkoutSessions.length,
    subscriptions: history.subscriptions.length,
  });

  // Helper function to safely convert Unix timestamp to ISO string
  const safeDate = (timestamp: number | null | undefined): string | null => {
    if (!timestamp || timestamp <= 0) return null;
    try {
      return new Date(timestamp * 1000).toISOString();
    } catch {
      return null;
    }
  };

  // Transform the data for frontend consumption
  const transformedCharges = history.charges.map(charge => ({
    id: charge.id,
    amount: charge.amount / 100, // Convert cents to dollars
    currency: charge.currency,
    status: charge.status,
    description: charge.description,
    receiptUrl: charge.receipt_url,
    created: safeDate(charge.created),
    paymentMethod: charge.payment_method_details?.card ? {
      brand: charge.payment_method_details.card.brand,
      last4: charge.payment_method_details.card.last4,
    } : null,
    metadata: charge.metadata,
  }));

  const transformedPaymentIntents = history.paymentIntents.map(pi => ({
    id: pi.id,
    amount: pi.amount / 100,
    currency: pi.currency,
    status: pi.status,
    description: pi.description,
    created: safeDate(pi.created),
    metadata: pi.metadata,
  }));

  const transformedCheckoutSessions = history.checkoutSessions
    .filter(session => session.payment_status === 'paid')
    .map(session => ({
      id: session.id,
      amountTotal: session.amount_total ? session.amount_total / 100 : 0,
      currency: session.currency,
      status: session.status,
      paymentStatus: session.payment_status,
      mode: session.mode,
      created: safeDate(session.created),
      metadata: session.metadata,
    }));

  const transformedSubscriptions = history.subscriptions.map(sub => ({
    id: sub.id,
    status: sub.status,
    plan: sub.metadata?.plan || 'unknown',
    currentPeriodStart: safeDate((sub as any).current_period_start),
    currentPeriodEnd: safeDate((sub as any).current_period_end),
    created: safeDate(sub.created),
    cancelAtPeriodEnd: sub.cancel_at_period_end,
  }));

  res.json({
    success: true,
    data: {
      charges: transformedCharges,
      paymentIntents: transformedPaymentIntents,
      checkoutSessions: transformedCheckoutSessions,
      subscriptions: transformedSubscriptions,
      stripeCustomerId: user.stripeCustomerId,
    },
  });
});

// Create a premium request for a listing
export const createPremiumRequest = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { listingId, message } = req.body;

  if (!listingId) {
    res.status(400).json({ success: false, error: 'Listing ID is required' });
    return;
  }

  const request = await buyerService.createPremiumRequest(req.user.id, listingId, message);

  const isAutoApproved = request.status === 'COMPLETED';

  res.status(201).json({
    success: true,
    data: request,
    message: isAutoApproved
      ? 'Premium listing unlocked instantly with your subscription.'
      : 'Premium request submitted successfully. Admin will review your request.',
  });
});

// Get buyer's premium requests
export const getPremiumRequests = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const page = parseIntParam(req.query.page as string) || 1;
  const limit = parseIntParam(req.query.limit as string) || 20;

  const result = await buyerService.getPremiumRequests(req.user.id, page, limit);

  res.json({
    success: true,
    data: result.requests,
    pagination: result.pagination,
  });
});

// ============ Terms of Service ============

// Get user's terms acceptance status
export const getTermsStatus = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const termsVersion = (req.query.version as string) || '1.0';
  const status = await buyerService.getTermsStatus(req.user.id, termsVersion);

  res.json({
    success: true,
    data: status,
  });
});

// ============ Creditsafe Credit Reports ============

// Search Creditsafe for a company based on an unlocked listing
// Helper: check if user has VIP subscription
async function isVipUser(userId: string): Promise<boolean> {
  const subscription = await Subscription.findOne({ where: { userId } });
  return !!subscription && subscription.plan === SubscriptionPlan.VIP_ACCESS && subscription.status === SubscriptionStatus.ACTIVE;
}

export const getCreditsafeSearch = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { listingId } = req.params;

  // VIP users bypass unlock check
  const vip = await isVipUser(req.user.id);
  if (!vip) {
    const unlock = await UnlockedListing.findOne({
      where: { userId: req.user.id, listingId },
    });

    if (!unlock) {
      res.status(403).json({ success: false, error: 'You have not unlocked this listing' });
      return;
    }
  }

  // Get listing details
  const listing = await Listing.findByPk(listingId);
  if (!listing) {
    res.status(404).json({ success: false, error: 'Listing not found' });
    return;
  }

  const companyName = listing.legalName || listing.dbaName || listing.title;
  const state = listing.state;

  // Search Creditsafe
  const searchResults = await creditsafeService.searchCompanies({
    countries: 'US',
    name: companyName,
    state: state || undefined,
    pageSize: 10,
  });

  res.json({
    success: true,
    data: {
      companies: searchResults.companies || [],
      totalResults: searchResults.totalSize || 0,
      listing: {
        id: listing.id,
        mcNumber: listing.mcNumber,
        dotNumber: listing.dotNumber,
        legalName: listing.legalName,
        state: listing.state,
      },
    },
  });
});

// Get a full Creditsafe credit report by connectId (requires unlocked listing verification)
export const getCreditsafeReport = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { connectId } = req.params;
  const listingId = req.query.listingId as string;

  // VIP users can pull reports freely without a listingId or unlock
  const vip = await isVipUser(req.user.id);
  if (!vip) {
    if (!listingId) {
      res.status(400).json({ success: false, error: 'listingId query parameter is required' });
      return;
    }

    const unlock = await UnlockedListing.findOne({
      where: { userId: req.user.id, listingId },
    });

    if (!unlock) {
      res.status(403).json({ success: false, error: 'You have not unlocked this listing' });
      return;
    }
  }

  // Get full credit report
  const report = await creditsafeService.getCreditReport(connectId, {
    includeIndicators: true,
  });

  res.json({
    success: true,
    data: report,
  });
});

// VIP-only: Free-form Creditsafe search by company name (no listing required)
export const getCreditsafeFreeSearch = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { name, state, city, regNo } = req.query;

  if (!name && !regNo) {
    res.status(400).json({ success: false, error: 'Either name or regNo query parameter is required' });
    return;
  }

  const searchResults = await creditsafeService.searchCompanies({
    countries: 'US',
    name: name as string | undefined,
    regNo: regNo as string | undefined,
    state: state as string | undefined,
    city: city as string | undefined,
    pageSize: 20,
  });

  res.json({
    success: true,
    data: {
      companies: searchResults.companies || [],
      totalResults: searchResults.totalSize || 0,
    },
  });
});

// Accept terms of service
export const acceptTerms = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { signatureName, termsVersion } = req.body;

  if (!signatureName || signatureName.trim().length < 2) {
    res.status(400).json({
      success: false,
      error: 'Signature name is required (at least 2 characters)'
    });
    return;
  }

  // Get IP address and user agent for legal records
  const ipAddress = req.ip || req.headers['x-forwarded-for']?.toString() || undefined;
  const userAgent = req.headers['user-agent'];

  const result = await buyerService.acceptTerms(
    req.user.id,
    signatureName.trim(),
    ipAddress,
    userAgent,
    termsVersion || '1.0'
  );

  if (result.alreadyAccepted) {
    res.json({
      success: true,
      data: {
        hasAccepted: true,
        acceptedAt: result.acceptance.acceptedAt,
        signatureName: result.acceptance.signatureName,
      },
      message: 'Terms already accepted',
    });
    return;
  }

  res.status(201).json({
    success: true,
    data: {
      hasAccepted: true,
      acceptedAt: result.acceptance.acceptedAt,
      signatureName: result.acceptance.signatureName,
    },
    message: 'Terms of Service accepted successfully',
  });
});

// CarrierPulse Creditsafe: Search by company name (requires CarrierPulse access)
export const getCarrierPulseCreditsafeSearch = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  // Check CarrierPulse access — included with any active subscription
  const user = await User.findByPk(req.user.id);
  const subscription = await Subscription.findOne({ where: { userId: req.user.id } });
  const isActive = subscription?.status === SubscriptionStatus.ACTIVE;
  const hasAccess = req.user.role === UserRole.ADMIN || user?.carrierPulseAccess || isActive;

  if (!hasAccess) {
    res.status(403).json({ success: false, error: 'CarrierPulse access required' });
    return;
  }

  const { name, state } = req.query;
  if (!name) {
    res.status(400).json({ success: false, error: 'Company name is required' });
    return;
  }

  const searchResults = await creditsafeService.searchCompanies({
    countries: 'US',
    name: name as string,
    state: state as string | undefined,
    pageSize: 10,
  });

  res.json({
    success: true,
    data: {
      companies: searchResults.companies || [],
      totalResults: searchResults.totalSize || 0,
    },
  });
});

// CarrierPulse Creditsafe: Get full credit report (requires CarrierPulse access)
export const getCarrierPulseCreditsafeReport = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  // Check CarrierPulse access — included with any active subscription
  const user = await User.findByPk(req.user.id);
  const subscription = await Subscription.findOne({ where: { userId: req.user.id } });
  const isActive = subscription?.status === SubscriptionStatus.ACTIVE;
  const hasAccess = req.user.role === UserRole.ADMIN || user?.carrierPulseAccess || isActive;

  if (!hasAccess) {
    res.status(403).json({ success: false, error: 'CarrierPulse access required' });
    return;
  }

  const { connectId } = req.params;
  const report = await creditsafeService.getCreditReport(connectId, { includeIndicators: true });

  res.json({ success: true, data: report });
});

// Check if a credit report is unlocked for a given DOT number, and unlock it (costs 2 credits for Starter/Premium)
export const checkOrUnlockCreditReport = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { dotNumber } = req.params;
  const { action } = req.query; // 'check' or 'unlock'

  const subscription = await Subscription.findOne({ where: { userId: req.user.id } });
  const plan = subscription?.plan?.toUpperCase();
  const isActive = subscription?.status === SubscriptionStatus.ACTIVE;
  const isAdmin = req.user.role === UserRole.ADMIN;

  // Premium (and grandfathered Enterprise) and VIP / Deal Access Pass get credit reports free; admin always free
  const isFree = isAdmin ||
    (isActive && (plan === SubscriptionPlan.PREMIUM || plan === SubscriptionPlan.ENTERPRISE || plan === SubscriptionPlan.VIP_ACCESS));

  if (isFree) {
    res.json({ success: true, data: { unlocked: true, free: true } });
    return;
  }

  // Check if already unlocked via credit transaction reference
  const reference = `credit_report:${dotNumber}`;
  const existing = await CreditTransaction.findOne({
    where: { userId: req.user.id, reference, type: CreditTransactionType.USAGE },
  });

  if (existing) {
    res.json({ success: true, data: { unlocked: true, free: false } });
    return;
  }

  // Just checking — not unlocking yet
  if (action !== 'unlock') {
    res.json({ success: true, data: { unlocked: false, free: false, cost: 2 } });
    return;
  }

  // Unlock: deduct 2 credits
  const result = await creditService.useCredits(
    req.user.id,
    2,
    `Credit report unlock for DOT ${dotNumber}`,
    reference
  );

  res.json({ success: true, data: { unlocked: true, free: false, newBalance: result.newBalance } });
});

// Creditsafe company search — open to all authenticated buyers (search is free, report costs $35)
export const creditsafeOpenSearch = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { name, state } = req.query;
  if (!name) {
    res.status(400).json({ success: false, error: 'Company name is required' });
    return;
  }

  const searchResults = await creditsafeService.searchCompanies({
    countries: 'US',
    name: name as string,
    state: state as string | undefined,
    pageSize: 10,
  });

  res.json({
    success: true,
    data: {
      companies: searchResults.companies || [],
      totalResults: searchResults.totalSize || 0,
    },
  });
});

// Creditsafe report — for purchased reports (check purchase status first)
export const creditsafePurchasedReport = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { connectId } = req.params;
  const isAdmin = req.user.role === UserRole.ADMIN;

  if (!isAdmin) {
    // Must have a one-time purchase — no subscription bypass
    const reference = `credit_report_purchase:${connectId}`;
    const existing = await CreditTransaction.findOne({
      where: { userId: req.user.id, reference, type: CreditTransactionType.USAGE },
    });
    if (!existing) {
      res.status(403).json({ success: false, error: 'Credit report not purchased. Please purchase access first.' });
      return;
    }
  }

  const report = await creditsafeService.getCreditReport(connectId, { includeIndicators: true });
  res.json({ success: true, data: report });
});

// Create Stripe checkout session for one-time $35 credit report purchase
export const createCreditReportCheckout = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { connectId, companyName } = req.body;
  if (!connectId || !companyName) {
    res.status(400).json({ success: false, error: 'connectId and companyName are required' });
    return;
  }

  // Check if already purchased
  const reference = `credit_report_purchase:${connectId}`;
  const existing = await CreditTransaction.findOne({
    where: { userId: req.user.id, reference, type: CreditTransactionType.USAGE },
  });
  if (existing) {
    res.json({ success: false, error: 'You have already purchased this credit report' });
    return;
  }

  // Get or create Stripe customer
  const user = await User.findByPk(req.user.id);
  const customer = await stripeService.getOrCreateCustomer(
    req.user.id,
    req.user.email,
    req.user.name || req.user.email,
    user?.stripeCustomerId || undefined
  );

  if (customer.id !== user?.stripeCustomerId) {
    await User.update({ stripeCustomerId: customer.id }, { where: { id: req.user.id } });
  }

  const frontendUrl = config.frontendUrl || 'http://localhost:5173';

  const result = await stripeService.createCreditReportCheckout({
    customerId: customer.id,
    userId: req.user.id,
    connectId,
    companyName,
    successUrl: `${frontendUrl}/buyer/creditsafe?purchase=success&connectId=${connectId}`,
    cancelUrl: `${frontendUrl}/buyer/creditsafe?purchase=canceled`,
  });

  if (!result.success) {
    throw new BadRequestError(result.error || 'Failed to create checkout session');
  }

  res.json({
    success: true,
    data: { sessionId: result.sessionId, url: result.url },
  });
});

// Check if a credit report has been purchased for a given connectId
export const checkCreditReportPurchase = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { connectId } = req.params;
  const isAdmin = req.user.role === UserRole.ADMIN;

  // Admin always has access
  if (isAdmin) {
    res.json({ success: true, data: { purchased: true, free: true } });
    return;
  }

  // Check one-time purchase only — no subscription bypass
  const reference = `credit_report_purchase:${connectId}`;
  const existing = await CreditTransaction.findOne({
    where: { userId: req.user.id, reference, type: CreditTransactionType.USAGE },
  });

  res.json({ success: true, data: { purchased: !!existing, free: false, price: 35 } });
});

// ============================================
// Buyer Preferences (what I'm looking to buy)
// ============================================

export const getMyPreferences = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }
  const prefs = await buyerPreferencesService.getByUserId(req.user.id);
  res.json({ success: true, data: buyerPreferencesService.toBuyerView(prefs) });
});

export const updateMyPreferences = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }
  const prefs = await buyerPreferencesService.upsert(req.user.id, req.body || {}, 'BUYER');
  res.json({ success: true, data: buyerPreferencesService.toBuyerView(prefs) });
});

export const getMyMatches = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }
  const limit = Math.min(Math.max(parseIntParam(req.query.limit as string) ?? 10, 1), 50);
  const prefs = await buyerPreferencesService.getByUserId(req.user.id);
  if (!prefs || !hasAnyCriteria(prefs)) {
    res.json({ success: true, data: { matches: [], hasPreferences: false } });
    return;
  }

  const listings = await Listing.findAll({
    where: { status: ListingStatus.ACTIVE },
    limit: 500,
  });
  const ranked = rankListings(listings, prefs, limit);

  const unlockedRecords = await UnlockedListing.findAll({
    where: { userId: req.user.id },
    attributes: ['listingId'],
  });
  const unlockedIds = new Set(unlockedRecords.map((u: any) => u.listingId));

  res.json({
    success: true,
    data: {
      hasPreferences: true,
      matches: ranked.map((l) => {
        const raw = l.toJSON() as any;
        const isUnlocked = unlockedIds.has(raw.id);
        if (!isUnlocked) {
          raw.mcNumber = maskNumber(raw.mcNumber);
          if (raw.dotNumber) raw.dotNumber = maskNumber(raw.dotNumber);
          raw.legalName = null;
        }
        return {
          listing: raw,
          matchScore: l.matchScore,
          matchReasons: l.matchReasons,
          isUnlocked,
        };
      }),
    },
  });
});
