import { Response } from 'express';
import { body } from 'express-validator';
import { adminService } from '../services/adminService';
import { asyncHandler, NotFoundError, BadRequestError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { PremiumRequestStatus, Transaction, User, Listing, TransactionTimeline, Notification, TransactionStatus, NotificationType, BrokerOutreachStatus } from '../models';
import { parseIntParam, parseBooleanParam } from '../utils/helpers';
import { stripeService } from '../services/stripeService';
import { pricingConfigService } from '../services/pricingConfigService';
import logger from '../utils/logger';

// Validation rules
export const rejectListingValidation = [
  body('reason').trim().notEmpty().withMessage('Rejection reason is required'),
];

export const blockUserValidation = [
  body('reason').trim().notEmpty().withMessage('Block reason is required'),
];

export const createUserValidation = [
  body('email').isEmail().withMessage('Valid email is required'),
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('password').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
  body('role').isIn(['BUYER', 'SELLER', 'ADMIN']).withMessage('Valid role is required'),
];

export const updateUserValidation = [
  body('name').optional().trim().isLength({ min: 1 }).withMessage('Name cannot be empty'),
  body('email').optional().trim().isEmail().withMessage('Valid email is required'),
  body('phone').optional().trim(),
  body('companyName').optional().trim(),
];

export const updateUserRoleValidation = [
  body('role').isIn(['BUYER', 'SELLER', 'ADMIN']).withMessage('Valid role is required (BUYER, SELLER, ADMIN)'),
];

export const createListingValidation = [
  body('mcNumber').trim().notEmpty().withMessage('MC Number is required'),
  body('sellerId').trim().notEmpty().withMessage('Seller ID is required'),
];

// Get dashboard stats
export const getDashboardStats = asyncHandler(async (req: AuthRequest, res: Response) => {
  const stats = await adminService.getDashboardStats();

  res.json({
    success: true,
    data: stats,
  });
});

// Get pending listings
export const getPendingListings = asyncHandler(async (req: AuthRequest, res: Response) => {
  const page = parseIntParam(req.query.page as string) || 1;
  const limit = parseIntParam(req.query.limit as string) || 20;

  const result = await adminService.getPendingListings(page, limit);

  res.json({
    success: true,
    data: result.listings,
    pagination: result.pagination,
  });
});

// Approve listing
export const approveListing = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { notes, listingPrice, freeToUnlock } = req.body;

  const listing = await adminService.approveListing(id, req.user.id, notes, listingPrice, freeToUnlock);

  res.json({
    success: true,
    data: listing,
    message: 'Listing approved',
  });
});

// Reject listing
export const rejectListing = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { reason } = req.body;

  const listing = await adminService.rejectListing(id, req.user.id, reason);

  res.json({
    success: true,
    data: listing,
    message: 'Listing rejected',
  });
});

// Get all users
export const getUsers = asyncHandler(async (req: AuthRequest, res: Response) => {
  const result = await adminService.getUsers({
    page: parseIntParam(req.query.page as string),
    limit: parseIntParam(req.query.limit as string),
    search: req.query.search as string,
    role: req.query.role as string,
    status: req.query.status as string,
    subscriptionStatus: req.query.subscriptionStatus as string,
  });

  res.json({
    success: true,
    data: result.users,
    pagination: result.pagination,
  });
});

// Get user details
export const getUserDetails = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;

  const user = await adminService.getUserDetails(id);

  res.json({
    success: true,
    data: user,
  });
});

// Block user
export const blockUser = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { reason } = req.body;

  const user = await adminService.blockUser(id, req.user.id, reason);

  res.json({
    success: true,
    data: user,
    message: 'User blocked',
  });
});

// Unblock user
export const unblockUser = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  const user = await adminService.unblockUser(id, req.user.id);

  res.json({
    success: true,
    data: user,
    message: 'User unblocked',
  });
});

// Verify seller
export const verifySeller = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  const user = await adminService.verifySeller(id, req.user.id);

  res.json({
    success: true,
    data: user,
    message: 'Seller verified',
  });
});

// Update user profile
export const updateUser = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { name, email, phone, companyName } = req.body;

  const user = await adminService.updateUser(id, req.user.id, { name, email, phone, companyName });

  res.json({
    success: true,
    data: user,
    message: 'User profile updated',
  });
});

// Update user role
export const updateUserRole = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { role } = req.body;

  const user = await adminService.updateUserRole(id, req.user.id, role);

  res.json({
    success: true,
    data: user,
    message: 'User role updated',
  });
});

// Get premium requests
export const getPremiumRequests = asyncHandler(async (req: AuthRequest, res: Response) => {
  const status = req.query.status as PremiumRequestStatus | undefined;
  const page = parseIntParam(req.query.page as string) || 1;
  const limit = parseIntParam(req.query.limit as string) || 20;

  const result = await adminService.getPremiumRequests(status, page, limit);

  res.json({
    success: true,
    data: result.requests,
    pagination: result.pagination,
  });
});

// Update premium request
export const updatePremiumRequest = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { status, notes } = req.body;

  const request = await adminService.updatePremiumRequest(
    id,
    req.user.id,
    status as PremiumRequestStatus,
    notes
  );

  res.json({
    success: true,
    data: request,
    message: 'Premium request updated',
  });
});

// Get broker outreach requests (Pending Insurance Leads)
export const getBrokerOutreachRequests = asyncHandler(async (req: AuthRequest, res: Response) => {
  const status = req.query.status as BrokerOutreachStatus | undefined;
  const page = parseIntParam(req.query.page as string) || 1;
  const limit = parseIntParam(req.query.limit as string) || 20;

  const result = await adminService.getBrokerOutreachRequests(status, page, limit);

  res.json({
    success: true,
    data: result.requests,
    pagination: result.pagination,
  });
});

// Update broker outreach request
export const updateBrokerOutreachRequest = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { status, notes } = req.body;

  const request = await adminService.updateBrokerOutreachRequest(
    id,
    req.user.id,
    status as BrokerOutreachStatus,
    notes
  );

  res.json({
    success: true,
    data: request,
    message: 'Broker outreach request updated',
  });
});

// Get all listings
export const getAllListings = asyncHandler(async (req: AuthRequest, res: Response) => {
  const result = await adminService.getAllListings({
    page: parseIntParam(req.query.page as string),
    limit: parseIntParam(req.query.limit as string),
    search: req.query.search as string,
    status: req.query.status as string,
    isPremium: parseBooleanParam(req.query.isPremium as string),
    isVip: parseBooleanParam(req.query.isVip as string),
  });

  res.json({
    success: true,
    data: result.listings,
    pagination: result.pagination,
  });
});

// Get all transactions
export const getAllTransactions = asyncHandler(async (req: AuthRequest, res: Response) => {
  const result = await adminService.getAllTransactions({
    page: parseIntParam(req.query.page as string),
    limit: parseIntParam(req.query.limit as string),
    status: req.query.status as string,
  });

  res.json({
    success: true,
    data: result.transactions,
    pagination: result.pagination,
  });
});

export const reassignTransactionParty = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { buyerId, sellerId } = req.body || {};
  const result = await adminService.reassignTransactionParty(id, req.user!.id, { buyerId, sellerId });
  res.json({ success: true, data: result });
});

// Get admin action log
export const getActionLog = asyncHandler(async (req: AuthRequest, res: Response) => {
  const adminId = req.query.adminId as string | undefined;
  const page = parseIntParam(req.query.page as string) || 1;
  const limit = parseIntParam(req.query.limit as string) || 50;

  const result = await adminService.getAdminActionLog(adminId, page, limit);

  res.json({
    success: true,
    data: result.actions,
    pagination: result.pagination,
  });
});

// Get platform settings
export const getSettings = asyncHandler(async (req: AuthRequest, res: Response) => {
  const settings = await adminService.getSettings();

  res.json({
    success: true,
    data: settings,
  });
});

// Update platform settings
export const updateSettings = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { settings } = req.body;

  if (!settings || !Array.isArray(settings)) {
    res.status(400).json({ success: false, error: 'Settings array is required' });
    return;
  }

  await adminService.updateSettings(settings);

  res.json({
    success: true,
    message: 'Settings updated',
  });
});

// Get revenue analytics
export const getRevenueAnalytics = asyncHandler(async (req: AuthRequest, res: Response) => {
  const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
  const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

  const analytics = await adminService.getRevenueAnalytics(startDate, endDate);

  res.json({
    success: true,
    data: analytics,
  });
});

// Get user analytics
export const getUserAnalytics = asyncHandler(async (req: AuthRequest, res: Response) => {
  const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
  const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

  const analytics = await adminService.getUserAnalytics(startDate, endDate);

  res.json({
    success: true,
    data: analytics,
  });
});

// Get listing analytics
export const getListingAnalytics = asyncHandler(async (req: AuthRequest, res: Response) => {
  const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
  const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

  const analytics = await adminService.getListingAnalytics(startDate, endDate);

  res.json({
    success: true,
    data: analytics,
  });
});

// Broadcast message to users
export const broadcastMessage = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { title, message, targetRole } = req.body;

  if (!title || !message) {
    res.status(400).json({ success: false, error: 'Title and message are required' });
    return;
  }

  const result = await adminService.broadcastMessage(req.user.id, title, message, targetRole);

  res.json({
    success: true,
    data: result,
    message: `Message sent to ${result.recipientCount} users`,
  });
});

// Get single listing by ID (admin - returns any status)
export const getListingById = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;

  const listing = await adminService.getListingById(id);

  res.json({
    success: true,
    data: listing,
  });
});

// Update listing (admin - can update any field)
export const updateListing = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const data = req.body;

  const listing = await adminService.updateListing(id, req.user.id, data);

  res.json({
    success: true,
    data: listing,
    message: 'Listing updated',
  });
});

// Get all offers (admin)
export const getAllOffers = asyncHandler(async (req: AuthRequest, res: Response) => {
  const result = await adminService.getAllOffers({
    page: parseIntParam(req.query.page as string),
    limit: parseIntParam(req.query.limit as string),
    status: req.query.status as string,
  });

  res.json({
    success: true,
    data: result.offers,
    pagination: result.pagination,
  });
});

// Approve offer (admin)
export const adminApproveOffer = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { notes } = req.body;

  const offer = await adminService.approveOffer(id, req.user.id, notes);

  res.json({
    success: true,
    data: offer,
    message: 'Offer approved. Buyer will be notified to pay deposit.',
  });
});

// Forward offer to seller (admin)
export const adminForwardOffer = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { sellerAmount, notes, messageToSeller } = req.body;

  if (!sellerAmount || sellerAmount <= 0) {
    res.status(400).json({ success: false, error: 'sellerAmount is required and must be positive' });
    return;
  }

  const offer = await adminService.forwardOfferToSeller(id, req.user.id, Number(sellerAmount), notes, messageToSeller);

  res.json({
    success: true,
    data: offer,
    message: 'Offer forwarded to seller.',
  });
});

// Reject offer (admin)
export const adminRejectOffer = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { reason } = req.body;

  const offer = await adminService.rejectOffer(id, req.user.id, reason);

  res.json({
    success: true,
    data: offer,
    message: 'Offer rejected. Buyer will be notified.',
  });
});

// Accept offer on behalf of seller (admin override)
export const adminAcceptOfferOnBehalf = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { notes } = req.body;

  const result = await adminService.acceptOfferOnBehalfOfSeller(id, req.user.id, notes);

  res.json({
    success: true,
    data: result,
    message: 'Offer accepted on behalf of seller. Buyer will be notified to pay deposit.',
  });
});

// Reject offer on behalf of seller (admin override)
export const adminRejectOfferOnBehalf = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { reason } = req.body;

  const offer = await adminService.rejectOfferOnBehalfOfSeller(id, req.user.id, reason);

  res.json({
    success: true,
    data: offer,
    message: 'Offer rejected on behalf of seller. Buyer will be notified.',
  });
});

// Delete offer (admin)
export const adminDeleteOffer = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  await adminService.deleteOffer(id, req.user.id);

  res.json({
    success: true,
    message: 'Offer deleted successfully.',
  });
});

// ============================================
// Admin User & Listing Creation
// ============================================

// Create user (admin) - with optional Stripe account for sellers
export const createUser = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { email, name, password, role, phone, companyName, createStripeAccount } = req.body;

  // Create the user
  const user = await adminService.createUser({
    email,
    name,
    password,
    role,
    phone,
    companyName,
    createdByAdminId: req.user.id,
  });

  let stripeAccountId: string | undefined;
  let stripeOnboardingUrl: string | undefined;

  // If seller and createStripeAccount is true, create Stripe connected account
  if (role === 'SELLER' && createStripeAccount && stripeService.isEnabled()) {
    const stripeResult = await stripeService.createConnectedAccount({
      userId: user.id,
      email: user.email,
      businessName: companyName || name,
    });

    if (stripeResult.success && stripeResult.accountId) {
      stripeAccountId = stripeResult.accountId;

      // Update user with Stripe account ID
      await adminService.updateUserStripeAccount(user.id, stripeAccountId);

      // Create onboarding link
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const linkResult = await stripeService.createAccountLink({
        accountId: stripeAccountId,
        refreshUrl: `${frontendUrl}/seller/stripe-refresh`,
        returnUrl: `${frontendUrl}/seller/stripe-complete`,
      });

      if (linkResult.success) {
        stripeOnboardingUrl = linkResult.url;
      }
    }
  }

  res.status(201).json({
    success: true,
    data: {
      user,
      stripeAccountId,
      stripeOnboardingUrl,
    },
    message: `User created successfully${stripeAccountId ? ' with Stripe account' : ''}`,
  });
});

// Create listing (admin) - can assign to any seller
export const createListing = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const {
    sellerId,
    mcNumber,
    dotNumber,
    legalName,
    dbaName,
    title,
    description,
    askingPrice,
    city,
    state,
    address,
    contactEmail,
    contactPhone,
    yearsActive,
    fleetSize,
    totalDrivers,
    safetyRating,
    insuranceOnFile,
    bipdCoverage,
    cargoCoverage,
    bondAmount,
    insuranceCompany,
    monthlyInsurancePremium,
    amazonStatus,
    amazonRelayScore,
    highwaySetup,
    sellingWithEmail,
    sellingWithPhone,
    cargoTypes,
    isPremium,
    isVip,
    visibility,
    hasFactoring,
    factoringCompany,
    entryAuditCompleted,
    status,
    adminNotes,
    fmcsaData,
    authorityHistory,
    insuranceHistory,
  } = req.body;

  const listing = await adminService.createListing({
    sellerId,
    mcNumber,
    dotNumber,
    legalName,
    dbaName,
    title: title || `MC Authority #${mcNumber}`,
    description,
    askingPrice: askingPrice || 0,
    city,
    state,
    address,
    contactEmail,
    contactPhone,
    yearsActive,
    fleetSize,
    totalDrivers,
    safetyRating,
    insuranceOnFile,
    bipdCoverage,
    cargoCoverage,
    bondAmount,
    insuranceCompany,
    monthlyInsurancePremium,
    amazonStatus,
    amazonRelayScore,
    highwaySetup,
    sellingWithEmail,
    sellingWithPhone,
    cargoTypes,
    isPremium,
    isVip,
    visibility,
    hasFactoring,
    factoringCompany,
    entryAuditCompleted,
    status: status || 'ACTIVE', // Admin can create active listings directly
    createdByAdminId: req.user.id,
    adminNotes,
    fmcsaData,
    authorityHistory,
    insuranceHistory,
  });

  res.status(201).json({
    success: true,
    data: listing,
    message: 'Listing created successfully',
  });
});

// Create user with listing (admin) - combined operation
export const createUserWithListing = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { user: userData, listing: listingData, createStripeAccount } = req.body;

  if (!userData || !userData.email || !userData.name || !userData.password) {
    res.status(400).json({ success: false, error: 'User data is required (email, name, password)' });
    return;
  }

  // 1. Create the user (always as SELLER for this combined operation)
  const user = await adminService.createUser({
    email: userData.email,
    name: userData.name,
    password: userData.password,
    role: 'SELLER',
    phone: userData.phone,
    companyName: userData.companyName,
    createdByAdminId: req.user.id,
  });

  let stripeAccountId: string | undefined;
  let stripeOnboardingUrl: string | undefined;

  // 2. Create Stripe connected account if requested
  if (createStripeAccount && stripeService.isEnabled()) {
    const stripeResult = await stripeService.createConnectedAccount({
      userId: user.id,
      email: user.email,
      businessName: userData.companyName || userData.name,
    });

    if (stripeResult.success && stripeResult.accountId) {
      stripeAccountId = stripeResult.accountId;
      await adminService.updateUserStripeAccount(user.id, stripeAccountId);

      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:5173';
      const linkResult = await stripeService.createAccountLink({
        accountId: stripeAccountId,
        refreshUrl: `${frontendUrl}/seller/stripe-refresh`,
        returnUrl: `${frontendUrl}/seller/stripe-complete`,
      });

      if (linkResult.success) {
        stripeOnboardingUrl = linkResult.url;
      }
    }
  }

  // 3. Create the listing if provided
  let listing = null;
  if (listingData && listingData.mcNumber) {
    listing = await adminService.createListing({
      sellerId: user.id,
      mcNumber: listingData.mcNumber,
      dotNumber: listingData.dotNumber,
      legalName: listingData.legalName || userData.companyName || userData.name,
      dbaName: listingData.dbaName,
      title: listingData.title || `MC Authority #${listingData.mcNumber}`,
      description: listingData.description,
      askingPrice: listingData.askingPrice || 0,
      city: listingData.city,
      state: listingData.state,
      yearsActive: listingData.yearsActive,
      fleetSize: listingData.fleetSize,
      totalDrivers: listingData.totalDrivers,
      safetyRating: listingData.safetyRating,
      insuranceOnFile: listingData.insuranceOnFile,
      bipdCoverage: listingData.bipdCoverage,
      cargoCoverage: listingData.cargoCoverage,
      amazonStatus: listingData.amazonStatus,
      amazonRelayScore: listingData.amazonRelayScore,
      highwaySetup: listingData.highwaySetup,
      sellingWithEmail: listingData.sellingWithEmail,
      sellingWithPhone: listingData.sellingWithPhone,
      cargoTypes: listingData.cargoTypes,
      isPremium: listingData.isPremium,
      status: listingData.status || 'ACTIVE',
      createdByAdminId: req.user.id,
      adminNotes: listingData.adminNotes,
    });
  }

  res.status(201).json({
    success: true,
    data: {
      user,
      listing,
      stripeAccountId,
      stripeOnboardingUrl,
    },
    message: `Seller created${listing ? ' with listing' : ''}${stripeAccountId ? ' and Stripe account' : ''}`,
  });
});

// ============================================
// Pricing Configuration
// ============================================

// Get pricing configuration
export const getPricingConfig = asyncHandler(async (req: AuthRequest, res: Response) => {
  const config = await pricingConfigService.getPricingConfig();

  res.json({
    success: true,
    data: config,
  });
});

// Update pricing configuration
export const updatePricingConfig = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const updates = req.body;

  if (!updates || typeof updates !== 'object') {
    res.status(400).json({ success: false, error: 'Invalid pricing configuration' });
    return;
  }

  const config = await pricingConfigService.updatePricingConfig(updates);

  res.json({
    success: true,
    data: config,
    message: 'Pricing configuration updated',
  });
});

// ============================================
// Stripe Transactions
// ============================================

// Get all Stripe transactions with full customer details
export const getStripeTransactions = asyncHandler(async (req: AuthRequest, res: Response) => {
  const limit = parseIntParam(req.query.limit as string) || 50;
  const status = req.query.status as 'succeeded' | 'pending' | 'failed' | undefined;
  const type = req.query.type as 'all' | 'payment_intent' | 'checkout_session' | 'charge' | undefined;
  const startingAfter = req.query.startingAfter as string | undefined;

  const result = await stripeService.getAllTransactions({
    limit,
    status,
    type,
    startingAfter,
  });

  if (!result.success) {
    res.status(500).json({
      success: false,
      error: result.error || 'Failed to fetch Stripe transactions',
    });
    return;
  }

  res.json({
    success: true,
    data: result.transactions,
    hasMore: result.hasMore,
  });
});

// Get Stripe account balance
export const getStripeBalance = asyncHandler(async (req: AuthRequest, res: Response) => {
  const result = await stripeService.getAccountBalance();

  if (!result.success) {
    res.status(500).json({
      success: false,
      error: result.error || 'Failed to fetch Stripe balance',
    });
    return;
  }

  res.json({
    success: true,
    data: result.balance,
  });
});

// Get Stripe balance transactions (money movement history)
export const getStripeBalanceTransactions = asyncHandler(async (req: AuthRequest, res: Response) => {
  const limit = parseIntParam(req.query.limit as string) || 50;
  const startingAfter = req.query.startingAfter as string | undefined;

  const result = await stripeService.getBalanceTransactions({
    limit,
    startingAfter,
  });

  if (!result.success) {
    res.status(500).json({
      success: false,
      error: result.error || 'Failed to fetch balance transactions',
    });
    return;
  }

  res.json({
    success: true,
    data: result.data,
    hasMore: result.hasMore,
  });
});

// ============================================
// User Credits Management
// ============================================

// Validation for credits adjustment
export const adjustCreditsValidation = [
  body('amount').isInt().withMessage('Amount must be an integer'),
  body('reason').trim().notEmpty().withMessage('Reason is required'),
];

// Adjust user credits (add or remove)
export const adjustUserCredits = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id: userId } = req.params;
  const { amount, reason } = req.body;

  const result = await adminService.adjustUserCredits(userId, amount, reason, req.user.id);

  res.json({
    success: true,
    data: result,
    message: `Credits ${amount >= 0 ? 'added' : 'removed'} successfully`,
  });
});

// ============================================
// Manual Deposit Recording (off-platform)
// ============================================

export const recordManualDepositValidation = [
  body('amount').isFloat({ gt: 0 }).withMessage('Amount must be a positive number'),
  body('paymentMethod').isIn(['ZELLE', 'WIRE', 'CHECK', 'STRIPE']).withMessage('Invalid payment method'),
  body('transactionId').optional({ nullable: true, checkFalsy: true }).isUUID().withMessage('Transaction ID must be a valid UUID'),
  body('reference').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 255 }),
  body('notes').optional({ nullable: true, checkFalsy: true }).trim().isLength({ max: 2000 }),
];

export const recordManualDeposit = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id: userId } = req.params;
  const { amount, paymentMethod, transactionId, reference, notes } = req.body;

  const result = await adminService.recordManualDeposit(userId, req.user.id, {
    amount: Number(amount),
    paymentMethod,
    transactionId: transactionId || undefined,
    reference: reference || undefined,
    notes: notes || undefined,
  });

  res.json({
    success: true,
    data: result,
    message: result.mode === 'linked'
      ? 'Deposit recorded and transaction advanced to DEPOSIT_RECEIVED'
      : 'Deposit recorded (MC not on platform)',
  });
});

export const getUserListingsForDeposit = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id: userId } = req.params;
  const data = await adminService.getUserListingsForDeposit(userId);
  res.json({ success: true, data });
});

// ============================================
// Cancel User Subscription
// ============================================

export const cancelUserSubscription = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id: userId } = req.params;

  const result = await adminService.cancelUserSubscription(userId, req.user.id);

  res.json({
    success: true,
    data: result,
    message: 'Subscription cancelled successfully',
  });
});

// ============================================
// Delete User (soft delete)
// ============================================

export const deleteUser = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id: userId } = req.params;

  const result = await adminService.deleteUser(userId, req.user.id);

  res.json({
    success: true,
    data: result,
    message: result.message,
  });
});

// ============================================
// Reset User Password
// ============================================

export const resetUserPasswordValidation = [
  body('newPassword').isLength({ min: 8 }).withMessage('Password must be at least 8 characters'),
];

export const resetUserPassword = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id: userId } = req.params;
  const { newPassword } = req.body;

  const result = await adminService.resetUserPassword(userId, newPassword, req.user.id);

  res.json({
    success: true,
    data: result,
    message: result.message,
  });
});

// ============================================
// Subscription Analytics (live from Stripe)
// ============================================

export const getSubscriptionAnalytics = asyncHandler(async (_req: AuthRequest, res: Response) => {
  const data = await adminService.getSubscriptionAnalytics();
  res.json({ success: true, data });
});

// ============================================
// Buyer Preferences (admin view)
// ============================================

export const getAdminUserPreferences = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id: userId } = req.params;
  const data = await adminService.getUserPreferences(userId);
  res.json({ success: true, data });
});

export const updateAdminUserPreferences = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id: userId } = req.params;
  const data = await adminService.updateUserPreferences(userId, req.body || {});
  res.json({ success: true, data });
});

export const getAdminUserMatches = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id: userId } = req.params;
  const limit = Math.min(Math.max(parseIntParam(req.query.limit as string) ?? 10, 1), 50);
  const data = await adminService.getUserMatches(userId, limit);
  res.json({ success: true, data });
});

// ============================================
// Account Dispute Management
// ============================================

// Block user for cardholder mismatch
export const blockUserMismatchValidation = [
  body('userId').isUUID().withMessage('User ID must be a valid UUID'),
  body('stripeTransactionId').notEmpty().withMessage('Stripe transaction ID is required'),
  body('cardholderName').notEmpty().withMessage('Cardholder name is required'),
  body('userName').notEmpty().withMessage('User name is required'),
];

export const blockUserForMismatch = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { userId, stripeTransactionId, cardholderName, userName } = req.body;

  const result = await adminService.blockUserForMismatch({
    userId,
    stripeTransactionId,
    cardholderName,
    userName,
    adminId: req.user.id,
  });

  res.json({
    success: true,
    data: result,
    message: result.alreadyExists
      ? 'User already has a pending dispute'
      : 'User blocked for cardholder name mismatch. Dispute created.',
  });
});

// Get all disputes (admin)
export const getAllDisputes = asyncHandler(async (req: AuthRequest, res: Response) => {
  const page = parseIntParam(req.query.page as string) || 1;
  const limit = parseIntParam(req.query.limit as string) || 20;
  const status = req.query.status as string | undefined;

  const result = await adminService.getAllDisputes({ page, limit, status });

  res.json({
    success: true,
    data: result.disputes,
    pagination: result.pagination,
  });
});

// Resolve dispute (admin)
export const resolveDispute = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { notes } = req.body;

  const result = await adminService.resolveDispute(id, req.user.id, notes);

  res.json({
    success: true,
    data: result,
    message: 'Dispute resolved. User has been unblocked.',
  });
});

// Reject dispute (admin)
export const rejectDispute = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { reason } = req.body;

  const result = await adminService.rejectDispute(id, req.user.id, reason);

  res.json({
    success: true,
    data: result,
    message: 'Dispute rejected. User remains blocked.',
  });
});

// Process auto-unblock (can be called by cron or manually)
export const processAutoUnblock = asyncHandler(async (req: AuthRequest, res: Response) => {
  const results = await adminService.processAutoUnblock();

  res.json({
    success: true,
    data: results,
    message: `Processed ${results.length} disputes for auto-unblock`,
  });
});

// ============================================
// Notification Settings
// ============================================

const NOTIFICATION_SETTING_KEYS = [
  'admin_notification_emails',
  'notify_new_users',
  'notify_new_inquiries',
  'notify_new_transactions',
  'notify_disputes',
  'notify_consultations',
];

// Get notification settings
export const getNotificationSettings = asyncHandler(async (req: AuthRequest, res: Response) => {
  const allSettings = await adminService.getSettings();

  // Extract only notification-related settings
  const notificationSettings: Record<string, string> = {};
  for (const key of NOTIFICATION_SETTING_KEYS) {
    notificationSettings[key] = allSettings[key]?.toString() || (key === 'admin_notification_emails' ? '' : 'true');
  }

  res.json({
    success: true,
    data: notificationSettings,
  });
});

// Update notification settings
export const updateNotificationSettings = asyncHandler(async (req: AuthRequest, res: Response) => {
  const updates = req.body;

  // Validate and filter only notification-related settings
  const settingsToUpdate: Array<{ key: string; value: string; type: string }> = [];

  for (const key of NOTIFICATION_SETTING_KEYS) {
    if (updates[key] !== undefined) {
      settingsToUpdate.push({
        key,
        value: updates[key].toString(),
        type: key === 'admin_notification_emails' ? 'string' : 'string', // Store as strings
      });
    }
  }

  if (settingsToUpdate.length === 0) {
    res.status(400).json({ success: false, error: 'No valid notification settings provided' });
    return;
  }

  await adminService.updateSettings(settingsToUpdate);

  res.json({
    success: true,
    message: 'Notification settings updated successfully',
  });
});

// ============================================
// User Activity Log
// ============================================

// Get user activity log (unlocked MCs with view counts and credit transactions)
export const getUserActivityLog = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;

  const activityLog = await adminService.getUserActivityLog(id);

  res.json({
    success: true,
    data: activityLog,
  });
});

// Get comprehensive activity log with filters
export const getActivityLog = asyncHandler(async (req: AuthRequest, res: Response) => {
  const {
    type,
    userId,
    mcNumber,
    actionType,
    dateFrom,
    dateTo,
    page,
    limit,
  } = req.query;

  const activityLog = await adminService.getActivityLog({
    type: type as string,
    userId: userId as string,
    mcNumber: mcNumber as string,
    actionType: actionType as string,
    dateFrom: dateFrom as string,
    dateTo: dateTo as string,
    page: page ? parseInt(page as string) : undefined,
    limit: limit ? parseInt(limit as string) : undefined,
  });

  res.json({
    success: true,
    data: activityLog,
  });
});

// ============================================
// Invoice Management
// ============================================

export const createInvoiceValidation = [
  body('userId').notEmpty().withMessage('User ID is required'),
  body('lineItems').isArray({ min: 1 }).withMessage('At least one line item is required'),
  body('lineItems.*.description').notEmpty().withMessage('Line item description is required'),
  body('lineItems.*.quantity').isInt({ min: 1 }).withMessage('Quantity must be at least 1'),
  body('lineItems.*.unitPrice').isFloat({ min: 0.01 }).withMessage('Unit price must be positive'),
];

// Create and send a Stripe invoice
export const createAndSendInvoice = asyncHandler(async (req: AuthRequest, res: Response) => {
  const {
    userId,
    lineItems,
    dueDate,
    notes,
    invoiceType,
    mcNumber,
    paymentMethods,
    autoSend,
  } = req.body;

  // Get user and ensure they have a Stripe customer
  const { User } = require('../models');
  const user = await User.findByPk(userId);
  if (!user) {
    res.status(404).json({ success: false, error: 'User not found' });
    return;
  }

  const customer = await stripeService.getOrCreateCustomer(
    user.id.toString(),
    user.email,
    user.name,
    user.stripeCustomerId || undefined
  );

  // Save stripeCustomerId back to user if not set
  if (!user.stripeCustomerId) {
    await user.update({ stripeCustomerId: customer.id });
  }

  // Convert line items to cents
  const stripeLineItems = lineItems.map((item: any) => ({
    description: item.description,
    quantity: item.quantity,
    unitAmountCents: Math.round(item.unitPrice * 100),
  }));

  // Build metadata
  const metadata: Record<string, string> = {
    invoiceType: invoiceType || 'custom',
    createdBy: req.user?.id?.toString() || 'admin',
  };
  if (mcNumber) metadata.mcNumber = mcNumber;

  const result = await stripeService.createAndSendInvoice({
    customerId: customer.id,
    lineItems: stripeLineItems,
    dueDate: dueDate ? Math.floor(new Date(dueDate).getTime() / 1000) : undefined,
    memo: notes || undefined,
    metadata,
    paymentMethodTypes: paymentMethods || ['us_bank_account'],
    autoSend: autoSend !== false,
  });

  if (!result.success) {
    res.status(500).json({ success: false, error: result.error });
    return;
  }

  res.json({
    success: true,
    data: {
      invoice: result.invoice,
      hostedUrl: result.hostedUrl,
    },
  });
});

// List all Stripe invoices
export const getAdminInvoices = asyncHandler(async (req: AuthRequest, res: Response) => {
  const limit = parseIntParam(req.query.limit as string) || 20;
  const startingAfter = req.query.startingAfter as string | undefined;
  const status = req.query.status as string | undefined;

  const result = await stripeService.listAllInvoices({
    limit,
    startingAfter,
    status,
  });

  res.json({
    success: true,
    data: result.invoices,
    hasMore: result.hasMore,
  });
});

// Get a single invoice
export const getAdminInvoice = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const invoice = await stripeService.getInvoice(id);

  if (!invoice) {
    res.status(404).json({ success: false, error: 'Invoice not found' });
    return;
  }

  res.json({ success: true, data: invoice });
});

// Send a draft invoice
export const sendAdminInvoice = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const result = await stripeService.sendInvoice(id);

  if (!result.success) {
    res.status(500).json({ success: false, error: result.error });
    return;
  }

  res.json({ success: true, data: result.invoice });
});

// Void an invoice
export const voidAdminInvoice = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const result = await stripeService.voidInvoice(id);

  if (!result.success) {
    res.status(500).json({ success: false, error: result.error });
    return;
  }

  res.json({ success: true });
});

// Check if seller is eligible for instant payout
export const checkSellerInstantPayoutEligibility = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;

  const transaction = await Transaction.findByPk(id, {
    include: [{ model: User, as: 'seller' }],
  });

  if (!transaction) {
    throw new NotFoundError('Transaction not found');
  }

  const seller = (transaction as any).seller as User;
  if (!seller?.stripeAccountId) {
    res.json({ success: true, data: { eligible: false, hasDebitCard: false, reason: 'No Stripe Connect account' } });
    return;
  }

  const result = await stripeService.checkInstantPayoutEligibility(seller.stripeAccountId);

  res.json({
    success: true,
    data: {
      eligible: result.eligible,
      hasDebitCard: result.hasDebitCard,
      reason: !result.hasDebitCard ? 'Seller needs to add a debit card to their Stripe account' : undefined,
    },
  });
});

// Release payout to seller via Stripe Transfer (standard or instant)
export const releasePayoutToSeller = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const { payoutMethod } = req.body; // 'standard' or 'instant'

  const transaction = await Transaction.findByPk(id, {
    include: [
      { model: User, as: 'seller' },
      { model: User, as: 'buyer' },
      { model: Listing, as: 'listing' },
    ],
  });

  if (!transaction) {
    throw new NotFoundError('Transaction not found');
  }

  if (transaction.status !== 'COMPLETED') {
    throw new BadRequestError('Transaction must be completed before releasing payout');
  }

  if (transaction.payoutStatus === 'RELEASED') {
    throw new BadRequestError('Payout has already been released for this transaction');
  }

  const seller = (transaction as any).seller as User;
  if (!seller) {
    throw new NotFoundError('Seller not found');
  }

  if (!seller.stripeAccountId) {
    throw new BadRequestError('Seller does not have a Stripe Connect account set up');
  }

  // Verify seller account is fully onboarded
  const isOnboarded = await stripeService.isAccountOnboarded(seller.stripeAccountId);
  if (!isOnboarded) {
    throw new BadRequestError('Seller Stripe Connect account is not fully onboarded');
  }

  // Calculate payout amount — use sellerPayout if set, otherwise use agreedPrice minus platformFee
  const listing = (transaction as any).listing;
  const payoutAmount = transaction.sellerPayout
    || (listing?.askingPrice || transaction.agreedPrice);

  if (!payoutAmount || payoutAmount <= 0) {
    throw new BadRequestError('Invalid payout amount');
  }

  const amountInCents = Math.round(Number(payoutAmount) * 100);
  const mcNumber = listing?.mcNumber || 'N/A';
  const isInstant = payoutMethod === 'instant';

  // For instant payout, verify eligibility first
  if (isInstant) {
    const eligibility = await stripeService.checkInstantPayoutEligibility(seller.stripeAccountId);
    if (!eligibility.eligible) {
      throw new BadRequestError(
        eligibility.hasDebitCard
          ? 'Seller account is not eligible for instant payouts'
          : 'Seller needs to add a debit card to their Stripe account for instant payouts'
      );
    }
  }

  // Step 1: Transfer funds from platform to seller's Connect account balance
  const transferResult = await stripeService.createTransfer({
    amount: amountInCents,
    destinationAccountId: seller.stripeAccountId,
    description: `Payout for MC #${mcNumber} sale - Transaction ${transaction.id}`,
    metadata: {
      transactionId: transaction.id,
      sellerId: seller.id,
      mcNumber: mcNumber,
      type: 'seller_payout',
      payoutMethod: isInstant ? 'instant' : 'standard',
    },
  });

  if (!transferResult.success) {
    logger.error('Failed to release payout to seller', {
      transactionId: transaction.id,
      sellerId: seller.id,
      error: transferResult.error,
    });
    throw new BadRequestError(`Failed to create transfer: ${transferResult.error}`);
  }

  let instantPayoutResult = null;
  let payoutStatusValue = 'RELEASED';

  // Step 2: If instant, create an instant payout from seller's Connect balance to their debit card
  if (isInstant) {
    instantPayoutResult = await stripeService.createInstantPayout({
      amount: amountInCents,
      connectedAccountId: seller.stripeAccountId,
      description: `Instant payout for MC #${mcNumber} sale`,
      metadata: {
        transactionId: transaction.id,
        transferId: transferResult.transferId || '',
      },
    });

    if (!instantPayoutResult.success) {
      // Transfer succeeded but instant payout failed — funds are in seller's Stripe balance
      // They'll get it via standard payout schedule (2 days)
      logger.warn('Instant payout failed after transfer succeeded, falling back to standard', {
        transactionId: transaction.id,
        sellerId: seller.id,
        error: instantPayoutResult.error,
      });
      payoutStatusValue = 'RELEASED'; // Still released, just not instant
    } else {
      payoutStatusValue = 'INSTANT_RELEASED';
    }
  }

  // Update transaction with payout info
  await transaction.update({
    payoutStatus: payoutStatusValue,
    payoutReleasedAt: new Date(),
    payoutTransferId: transferResult.transferId,
  });

  // Add timeline entry
  const timelineDesc = isInstant && instantPayoutResult?.success
    ? `Instant payout of $${Number(payoutAmount).toLocaleString()} released to seller's debit card (Transfer: ${transferResult.transferId}, Payout: ${instantPayoutResult.payoutId})`
    : `Payout of $${Number(payoutAmount).toLocaleString()} released to seller via Stripe Transfer (${transferResult.transferId})`;

  await TransactionTimeline.create({
    transactionId: transaction.id,
    status: TransactionStatus.COMPLETED,
    title: isInstant && instantPayoutResult?.success ? 'Instant Payout Released' : 'Payout Released',
    description: timelineDesc,
    actorId: req.user!.id,
    actorRole: 'ADMIN',
  });

  // Notify seller
  const notifMessage = isInstant && instantPayoutResult?.success
    ? `Your instant payout of $${Number(payoutAmount).toLocaleString()} for MC #${mcNumber} has been sent to your debit card. It should arrive within minutes.`
    : `Your payout of $${Number(payoutAmount).toLocaleString()} for MC #${mcNumber} has been released to your connected bank account. It typically arrives within 2 business days.`;

  await Notification.create({
    userId: seller.id,
    title: isInstant && instantPayoutResult?.success ? 'Instant Payout Sent!' : 'Payout Released!',
    message: notifMessage,
    type: NotificationType.PAYMENT,
    link: `/transaction/${transaction.id}`,
  });

  logger.info('Payout released to seller', {
    transactionId: transaction.id,
    sellerId: seller.id,
    amount: payoutAmount,
    transferId: transferResult.transferId,
    payoutMethod: isInstant ? 'instant' : 'standard',
    instantPayoutId: instantPayoutResult?.payoutId,
  });

  res.json({
    success: true,
    message: isInstant && instantPayoutResult?.success
      ? `Instant payout of $${Number(payoutAmount).toLocaleString()} sent to seller's debit card`
      : `Payout of $${Number(payoutAmount).toLocaleString()} released to seller`,
    data: {
      transferId: transferResult.transferId,
      amount: payoutAmount,
      payoutStatus: payoutStatusValue,
      payoutReleasedAt: new Date(),
      payoutMethod: isInstant && instantPayoutResult?.success ? 'instant' : 'standard',
      instantPayoutId: instantPayoutResult?.payoutId || null,
      instantPayoutFee: instantPayoutResult?.fee || null,
    },
  });
});
