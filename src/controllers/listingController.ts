import { Request, Response } from 'express';
import { body, query } from 'express-validator';
import { listingService } from '../services/listingService';
import { asyncHandler } from '../middleware/errorHandler';
import { AuthRequest, ListingQueryParams } from '../types';
import { parseBooleanParam, parseIntParam } from '../utils/helpers';
import { Subscription, SubscriptionPlan, SubscriptionStatus, UserRole, UnlockedListing } from '../models';
import { buyerPreferencesService } from '../services/buyerPreferencesService';
import { scoreListing, hasAnyCriteria } from '../services/matchService';

// Mask an MC/DOT number: show first half, replace rest with bullets
function maskNumber(num: string): string {
  if (!num) return num;
  const half = Math.ceil(num.length / 2);
  return num.substring(0, half) + '•'.repeat(num.length - half);
}

// Validation rules
export const createListingValidation = [
  body('mcNumber').trim().notEmpty().withMessage('MC number is required'),
  body('dotNumber').trim().notEmpty().withMessage('DOT number is required'),
  body('legalName').trim().notEmpty().withMessage('Legal name is required'),
  body('title').trim().notEmpty().withMessage('Title is required'),
  body('askingPrice').isNumeric().withMessage('Asking price must be a number'),
  body('city').trim().notEmpty().withMessage('City is required'),
  body('state').trim().isLength({ min: 2, max: 2 }).withMessage('State must be 2 characters'),
];

export const searchValidation = [
  query('page').optional().isInt({ min: 1 }).withMessage('Page must be a positive integer'),
  query('limit').optional().isInt({ min: 1, max: 100 }).withMessage('Limit must be between 1 and 100'),
];

// Get all listings with filters
export const getListings = asyncHandler(async (req: AuthRequest, res: Response) => {
  const params: ListingQueryParams = {
    page: parseIntParam(req.query.page as string) || 1,
    limit: parseIntParam(req.query.limit as string) || 20,
    search: req.query.search as string,
    minPrice: parseIntParam(req.query.minPrice as string),
    maxPrice: parseIntParam(req.query.maxPrice as string),
    state: req.query.state as string,
    safetyRating: req.query.safetyRating as string,
    amazonStatus: req.query.amazonStatus as string,
    authorityType: req.query.authorityType as string,
    verified: parseBooleanParam(req.query.verified as string),
    premium: parseBooleanParam(req.query.premium as string),
    vip: parseBooleanParam(req.query.vip as string),
    highwaySetup: parseBooleanParam(req.query.highwaySetup as string),
    hasEmail: parseBooleanParam(req.query.hasEmail as string),
    hasPhone: parseBooleanParam(req.query.hasPhone as string),
    minYears: parseIntParam(req.query.minYears as string),
    sortBy: req.query.sortBy as ListingQueryParams['sortBy'],
    status: req.query.status as string,
  };

  const result = await listingService.getListings(params);
  const userId = req.user?.id;
  const isAdmin = req.user?.role === UserRole.ADMIN;
  const isSeller = req.user?.role === UserRole.SELLER;

  // Mask MC/DOT numbers for buyers who haven't unlocked
  let listings = result.listings;
  if (!isAdmin && !isSeller && userId) {
    // Get all listing IDs this user has unlocked
    const unlockedRecords = await UnlockedListing.findAll({
      where: { userId },
      attributes: ['listingId'],
    });
    const unlockedIds = new Set(unlockedRecords.map((u: any) => u.listingId));

    listings = result.listings.map((l: any) => {
      const listing = l.toJSON ? l.toJSON() : { ...l };
      if (!unlockedIds.has(listing.id)) {
        listing.mcNumber = maskNumber(listing.mcNumber);
        if (listing.dotNumber) listing.dotNumber = maskNumber(listing.dotNumber);
      }
      return listing;
    });
  } else if (!isAdmin && !isSeller && !userId) {
    // Unauthenticated — mask everything
    listings = result.listings.map((l: any) => {
      const listing = l.toJSON ? l.toJSON() : { ...l };
      listing.mcNumber = maskNumber(listing.mcNumber);
      if (listing.dotNumber) listing.dotNumber = maskNumber(listing.dotNumber);
      return listing;
    });
  }

  // Attach match score for authenticated buyers with preferences
  if (userId && !isAdmin && !isSeller) {
    const prefs = await buyerPreferencesService.getByUserId(userId);
    if (prefs && hasAnyCriteria(prefs)) {
      const sourceListings = result.listings;
      listings = listings.map((masked: any, i: number) => {
        const src = sourceListings[i];
        if (!src) return masked;
        const { score, reasons } = scoreListing(src, prefs);
        return { ...masked, matchScore: score, matchReasons: reasons };
      });
    }
  }

  res.json({
    success: true,
    data: listings,
    pagination: result.pagination,
  });
});

// Get single listing
export const getListing = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;
  const userId = req.user?.id;

  const listing = await listingService.getListingById(id, userId);

  const isOwner = req.user && listing.sellerId === req.user.id;
  const isAdmin = req.user?.role === UserRole.ADMIN;

  // VIP listings are only accessible to Premium subscribers (and grandfathered Enterprise),
  // VIP / Deal Access Pass holders, admins, and the listing owner.
  if (listing.isVip && !isOwner && !isAdmin) {
    const subscription = await Subscription.findOne({ where: { userId: req.user!.id } });
    if (
      !subscription ||
      subscription.status !== SubscriptionStatus.ACTIVE ||
      (subscription.plan !== SubscriptionPlan.PREMIUM &&
        subscription.plan !== SubscriptionPlan.ENTERPRISE &&
        subscription.plan !== SubscriptionPlan.VIP_ACCESS)
    ) {
      res.status(403).json({ success: false, error: 'Premium subscription required to view VIP listings.', code: 'PREMIUM_REQUIRED' });
      return;
    }
  }

  // Mask MC/DOT for display, but always include real DOT for carrier data fetching
  const responseData = { ...listing };
  if (!listing.isUnlocked && !isOwner && !isAdmin) {
    // Keep real DOT in a separate field so frontend can fetch carrier intelligence
    responseData._realDotNumber = responseData.dotNumber;
    responseData.mcNumber = maskNumber(responseData.mcNumber);
    if (responseData.dotNumber) responseData.dotNumber = maskNumber(responseData.dotNumber);
  }

  res.json({
    success: true,
    data: responseData,
  });
});

// Create listing (seller only)
export const createListing = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const listing = await listingService.createListing(req.user.id, req.body);

  res.status(201).json({
    success: true,
    data: listing,
    message: 'Listing created successfully',
  });
});

// Update listing
export const updateListing = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  const listing = await listingService.updateListing(id, req.user.id, req.body);

  res.json({
    success: true,
    data: listing,
    message: 'Listing updated successfully',
  });
});

// Submit listing for review
export const submitForReview = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  const listing = await listingService.submitForReview(id, req.user.id);

  res.json({
    success: true,
    data: listing,
    message: 'Listing submitted for review',
  });
});

// Delete listing
export const deleteListing = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  await listingService.deleteListing(id, req.user.id);

  res.json({
    success: true,
    message: 'Listing deleted successfully',
  });
});

// Save listing
export const saveListing = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  await listingService.saveListing(id, req.user.id);

  res.json({
    success: true,
    message: 'Listing saved',
  });
});

// Unsave listing
export const unsaveListing = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  await listingService.unsaveListing(id, req.user.id);

  res.json({
    success: true,
    message: 'Listing unsaved',
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

  const result = await listingService.getSavedListings(req.user.id, page, limit);

  res.json({
    success: true,
    data: result.listings,
    pagination: result.pagination,
  });
});

// Get seller's listings
export const getMyListings = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const listings = await listingService.getSellerListings(req.user.id);

  res.json({
    success: true,
    data: listings,
  });
});

// Unlock listing (use credit)
export const unlockListing = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  const result = await listingService.unlockListing(id, req.user.id);

  res.json({
    success: true,
    data: result,
    message: result.alreadyUnlocked ? 'Already unlocked' : 'Listing unlocked successfully',
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

  const result = await listingService.getUnlockedListings(req.user.id, page, limit);

  res.json({
    success: true,
    data: result.listings,
    pagination: result.pagination,
  });
});
