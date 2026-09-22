import { Request, Response } from 'express';
import { body, query } from 'express-validator';
import { listingService } from '../services/listingService';
import { asyncHandler } from '../middleware/errorHandler';
import { AuthRequest, ListingQueryParams } from '../types';
import { parseBooleanParam, parseIntParam } from '../utils/helpers';
import { Subscription, SubscriptionPlan, SubscriptionStatus, UserRole, UnlockedListing } from '../models';
import { buyerPreferencesService } from '../services/buyerPreferencesService';
import { scoreListing, hasAnyCriteria } from '../services/matchService';
import { recordAccess } from '../utils/accessLog';
import { recordListingAccess } from '../utils/listingAccessLog';
import { AUTHORITY_TYPE_VALUES, requiresDotNumber } from '../utils/authority';
import { sanitizeListing, redactCarrierIntel } from '../utils/listingSanitize';
import { Listing } from '../models';
import { fmcsaService } from '../services/fmcsaService';
import { carrierDataService } from '../services/carrierDataService';

/**
 * VIP listings are visible only to Premium subscribers (and grandfathered
 * Enterprise), VIP / Deal Access Pass holders, admins, and the listing owner.
 * Shared by the detail route and the carrier-intel route so the two cannot
 * drift apart and leave intel reachable on a listing the body refuses to serve.
 */
async function viewerMayAccessVip(
  req: AuthRequest,
  listing: { isVip?: boolean; sellerId?: string }
): Promise<boolean> {
  if (!listing.isVip) return true;
  // Anonymous viewers (optional auth) can never satisfy the subscription check.
  if (!req.user) return false;
  if (req.user.role === UserRole.ADMIN || listing.sellerId === req.user.id) return true;

  const subscription = await Subscription.findOne({ where: { userId: req.user.id } });
  return (
    !!subscription &&
    subscription.status === SubscriptionStatus.ACTIVE &&
    (subscription.plan === SubscriptionPlan.PREMIUM ||
      subscription.plan === SubscriptionPlan.ENTERPRISE ||
      subscription.plan === SubscriptionPlan.VIP_ACCESS)
  );
}

// Validation rules
export const createListingValidation = [
  body('mcNumber').trim().notEmpty().withMessage('MC number is required'),
  body('authorityType')
    .optional({ values: 'falsy' })
    // Match normalizeAuthorityType's case-insensitivity so a client sending
    // "broker" isn't rejected by a rule the service layer would have accepted
    .customSanitizer((value) => String(value).toUpperCase().trim())
    .isIn(AUTHORITY_TYPE_VALUES)
    .withMessage('Invalid authority type'),
  // DOT is required for motor carrier authorities only. Brokers and freight
  // forwarders commonly hold a docket (MC) number with no USDOT. Read the raw
  // body rather than using .if() — validate() runs chains through Promise.all,
  // so cross-field predicates on sanitized values are order-sensitive.
  body('dotNumber')
    .trim()
    .custom((value, { req }) => {
      if (!requiresDotNumber(req.body?.authorityType)) return true;
      if (!value) throw new Error('DOT number is required for motor carrier authority');
      return true;
    }),
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

// Largest page a caller may ask for. `?limit=10000` used to be honoured
// verbatim, so one anonymous request could pull the whole table; searchValidation
// said 100 but was never wired to a route. Clamp rather than reject, so a client
// asking for too much gets a page instead of a 400.
const MAX_PAGE_SIZE = 100;

// Get all listings with filters
export const getListings = asyncHandler(async (req: AuthRequest, res: Response) => {
  const params: ListingQueryParams = {
    page: Math.max(1, parseIntParam(req.query.page as string) || 1),
    limit: Math.min(MAX_PAGE_SIZE, Math.max(1, parseIntParam(req.query.limit as string) || 20)),
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
    // Only admins may match MC/DOT/legal name by substring — for anyone else
    // that turns the search box into a way to read back the masked number.
    allowIdentitySubstringSearch: req.user?.role === UserRole.ADMIN,
  };

  const result = await listingService.getListings(params);
  const userId = req.user?.id;
  const isAdmin = req.user?.role === UserRole.ADMIN;
  const isSeller = req.user?.role === UserRole.SELLER;

  // Withhold carrier identity from anyone who hasn't unlocked the listing.
  // Note the predicate is ownership, not the SELLER role: holding a seller
  // account entitles you to your own listings, not to every other seller's.
  let listings = result.listings;
  if (!isAdmin) {
    const unlockedIds = userId
      ? new Set(
          (
            await UnlockedListing.findAll({
              where: { userId },
              attributes: ['listingId'],
            })
          ).map((u: any) => u.listingId)
        )
      : new Set<string>();

    listings = result.listings.map((l: any) => {
      const listing = l.toJSON ? l.toJSON() : { ...l };
      const entitled = !!userId && (listing.sellerId === userId || unlockedIds.has(listing.id));
      return entitled ? listing : sanitizeListing(listing);
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

  // Record the read so catalogue scraping is visible afterwards, not only when
  // it trips a rate limit. A search term is worth keeping — repeated identity
  // lookups from one IP are the signal we care about.
  recordListingAccess(req, params.search ? 'SEARCH' : 'BROWSE', {
    userId,
    detail: params.search
      ? `q=${params.search} n=${result.pagination?.total ?? listings.length}`
      : `page=${params.page} limit=${params.limit} n=${result.pagination?.total ?? listings.length}`,
  });

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

  if (!(await viewerMayAccessVip(req, listing))) {
    res.status(403).json({ success: false, error: 'Premium subscription required to view VIP listings.', code: 'PREMIUM_REQUIRED' });
    return;
  }

  // Mask MC/DOT for display. The real DOT stays on the server — the detail page
  // reaches carrier intelligence through /listings/:id/carrier-intel instead.
  const entitled = listing.isUnlocked || isOwner || isAdmin;
  const responseData = entitled ? { ...listing } : sanitizeListing(listing);

  recordListingAccess(req, 'DETAIL', { userId, listingId: id });

  res.json({
    success: true,
    data: responseData,
  });
});

// Carrier intelligence for one listing, resolved server-side.
//
// The detail page shows FMCSA safety history for listings the viewer has not
// unlocked. It used to do that by asking for the listing's real DOT and calling
// the public /api/fmcsa/* routes itself, which handed every anonymous visitor
// the identity the masking exists to withhold. The DOT never leaves the server
// now; the client asks by listing id and gets back only the intelligence.
export const getListingCarrierIntel = asyncHandler(async (req: AuthRequest, res: Response) => {
  const { id } = req.params;

  // Deliberately not listingService.getListingById — that increments `views`,
  // and this fires alongside every detail render.
  const listing = await Listing.findByPk(id, {
    attributes: ['id', 'mcNumber', 'dotNumber', 'legalName', 'isVip', 'sellerId'],
  });
  if (!listing) {
    res.status(404).json({ success: false, error: 'Listing not found' });
    return;
  }

  if (!(await viewerMayAccessVip(req, listing))) {
    res.status(403).json({ success: false, error: 'Premium subscription required to view VIP listings.', code: 'PREMIUM_REQUIRED' });
    return;
  }

  const dot = (listing.dotNumber || '').replace(/\D/g, '');
  if (!dot) {
    res.json({ success: true, data: { carrierReport: null, sms: null, cargoTypes: [], authority: null, insurance: null } });
    return;
  }

  // One slow or failing upstream shouldn't blank the whole panel.
  const [carrierReport, sms, cargoTypes, authority, insurance] = await Promise.all([
    carrierDataService.getFullReport(dot).catch(() => null),
    fmcsaService.getSMSData(dot).catch(() => null),
    fmcsaService.getCargoCarried(dot).catch(() => [] as string[]),
    fmcsaService.getAuthorityHistory(dot).catch(() => null),
    fmcsaService.getInsuranceHistory(dot).catch(() => null),
  ]);

  // The upstream report repeats the carrier's name, DOT, phone and email — the
  // very fields the listing masks. Unlocking is what buys them.
  const isAdmin = req.user?.role === UserRole.ADMIN;
  const isOwner = !!req.user && listing.sellerId === req.user.id;
  let entitled = isAdmin || isOwner;
  if (!entitled && req.user) {
    entitled = !!(await UnlockedListing.findOne({ where: { userId: req.user.id, listingId: id } }));
  }

  const bundle = { carrierReport, sms, cargoTypes, authority, insurance };

  res.json({
    success: true,
    data: entitled
      ? bundle
      : redactCarrierIntel(bundle, {
          mcNumber: listing.mcNumber,
          dotNumber: listing.dotNumber,
          legalName: listing.legalName,
        }),
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

  // Access log: record the listing access with IP for dispute evidence.
  recordAccess(req.user.id, 'UNLOCK', req, `listing ${id}${result.alreadyUnlocked ? ' (re-access)' : ''}`);

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
