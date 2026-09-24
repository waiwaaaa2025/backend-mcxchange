import type { TruckInput } from './truckService';
import { Op, WhereOptions, Order } from 'sequelize';
import sequelize from '../config/database';
import {
  Listing,
  User,
  Document,
  SavedListing,
  UnlockedListing,
  CreditTransaction,
  Subscription,
  ListingStatus,
  ListingVisibility,
  SafetyRating,
  AmazonRelayStatus,
  CreditTransactionType,
  SubscriptionStatus,
} from '../models';
import { ListingQueryParams, CreateListingData, PaginationInfo } from '../types';
import { NotFoundError, ForbiddenError } from '../middleware/errorHandler';
import { getPaginationInfo } from '../utils/helpers';
import { normalizeAuthorityType } from '../utils/authority';
import { publicListingTitle, scrubIdentity } from '../utils/listingSanitize';
import { cacheService, CacheKeys, CacheTTL } from './cacheService';
import logger from '../utils/logger';

// Helper function to normalize safety rating to valid enum value
function normalizeSafetyRating(rating: string | undefined | null): SafetyRating {
  if (!rating) return SafetyRating.NONE;

  const normalized = rating.toUpperCase().trim();

  // Map common variations to valid enum values
  if (normalized === 'SATISFACTORY' || normalized === 'SAT') {
    return SafetyRating.SATISFACTORY;
  }
  if (normalized === 'CONDITIONAL' || normalized === 'COND') {
    return SafetyRating.CONDITIONAL;
  }
  if (normalized === 'UNSATISFACTORY' || normalized === 'UNSAT') {
    return SafetyRating.UNSATISFACTORY;
  }

  // Default to NONE for any other value (including "None", "N/A", "NOT RATED", etc.)
  return SafetyRating.NONE;
}

// Helper function to normalize Amazon relay status to valid enum value
function normalizeAmazonStatus(status: string | undefined | null): AmazonRelayStatus {
  if (!status) return AmazonRelayStatus.NONE;

  const normalized = status.toUpperCase().trim();

  if (normalized === 'ACTIVE') return AmazonRelayStatus.ACTIVE;
  if (normalized === 'PENDING') return AmazonRelayStatus.PENDING;
  if (normalized === 'SUSPENDED') return AmazonRelayStatus.SUSPENDED;

  return AmazonRelayStatus.NONE;
}

class ListingService {
  // Get all listings with filters and pagination
  async getListings(params: ListingQueryParams) {
    const {
      page = 1,
      limit = 20,
      search,
      minPrice,
      maxPrice,
      state,
      safetyRating,
      amazonStatus,
      authorityType,
      verified,
      premium,
      vip,
      highwaySetup,
      hasEmail,
      hasPhone,
      minYears,
      sortBy = 'newest',
      status,
      sellerId,
      allowIdentitySubstringSearch = false,
    } = params;

    const offset = (page - 1) * limit;

    // Build where clause
    const where: WhereOptions = {
      status: status ? status : ListingStatus.ACTIVE,
      visibility: ListingVisibility.PUBLIC,
    };

    // Search
    //
    // MC, DOT and legal name are masked in the response, so matching them by
    // substring hands the masked value back through the result set: probe
    // "674", then "6748", then "67484" and watch which prefix still returns the
    // listing, and the number falls out in about thirty requests. Non-admins
    // get equality on those columns instead — enough to look up a number you
    // already know, useless for discovering one you don't. Free-text columns
    // are not sensitive and keep substring matching.
    if (search) {
      const identityMatch = allowIdentitySubstringSearch
        ? { [Op.like]: `%${search}%` }
        : { [Op.eq]: search.trim() };

      (where as Record<string, unknown>)[Op.or as unknown as string] = [
        { mcNumber: identityMatch },
        { dotNumber: identityMatch },
        { legalName: identityMatch },
        { dbaName: identityMatch },
        { title: { [Op.like]: `%${search}%` } },
        { state: { [Op.like]: `%${search}%` } },
        { city: { [Op.like]: `%${search}%` } },
      ];
    }

    // Price filter
    if (minPrice !== undefined || maxPrice !== undefined) {
      const priceFilter: Record<symbol, number> = {};
      if (minPrice !== undefined) priceFilter[Op.gte] = minPrice;
      if (maxPrice !== undefined) priceFilter[Op.lte] = maxPrice;
      // Filter by listingPrice (the price shown to buyers), fallback to askingPrice
      (where as Record<string, unknown>).listingPrice = priceFilter;
    }

    // State filter
    if (state) {
      (where as Record<string, unknown>).state = state.toUpperCase();
    }

    // Safety rating filter
    if (safetyRating) {
      (where as Record<string, unknown>).safetyRating = safetyRating.toUpperCase();
    }

    // Amazon status filter
    if (amazonStatus) {
      (where as Record<string, unknown>).amazonStatus = amazonStatus.toUpperCase();
    }

    // Authority type filter (comma-separated list, e.g. "BROKER,MOTOR_CARRIER_AND_BROKER")
    if (authorityType) {
      const types = authorityType
        .split(',')
        .map((t) => t.trim().toUpperCase())
        .filter(Boolean);
      if (types.length === 1) {
        (where as Record<string, unknown>).authorityType = types[0];
      } else if (types.length > 1) {
        (where as Record<string, unknown>).authorityType = { [Op.in]: types };
      }
    }

    // Premium filter
    if (premium !== undefined) {
      (where as Record<string, unknown>).isPremium = premium;
    }

    // VIP filter — only apply when explicitly set
    if (vip !== undefined) {
      (where as Record<string, unknown>).isVip = vip;
    }

    // Highway setup filter
    if (highwaySetup !== undefined) {
      (where as Record<string, unknown>).highwaySetup = highwaySetup;
    }

    // Email filter
    if (hasEmail !== undefined) {
      (where as Record<string, unknown>).sellingWithEmail = hasEmail;
    }

    // Phone filter
    if (hasPhone !== undefined) {
      (where as Record<string, unknown>).sellingWithPhone = hasPhone;
    }

    // Minimum years filter
    if (minYears !== undefined) {
      (where as Record<string, unknown>).yearsActive = { [Op.gte]: minYears };
    }

    // Seller filter
    if (sellerId) {
      (where as Record<string, unknown>).sellerId = sellerId;
    }

    // Build orderBy
    let order: Order = [['createdAt', 'DESC']];
    switch (sortBy) {
      case 'price_asc':
        order = [['askingPrice', 'ASC']];
        break;
      case 'price_desc':
        order = [['askingPrice', 'DESC']];
        break;
      case 'newest':
        order = [['createdAt', 'DESC']];
        break;
      case 'oldest':
        order = [['createdAt', 'ASC']];
        break;
      case 'years_active':
        order = [['yearsActive', 'DESC']];
        break;
    }

    // Build cache key from query params (for search results caching)
    const cacheKey = `${CacheKeys.LISTINGS}${JSON.stringify({
      status, state, search, minPrice, maxPrice, safetyRating, amazonStatus,
      authorityType, verified, premium, vip, highwaySetup, hasEmail, hasPhone, minYears,
      sortBy, sellerId, page, limit, allowIdentitySubstringSearch,
    })}`;

    // Try to get from cache first (5 minute TTL)
    const cached = await cacheService.get<{ listings: Listing[]; pagination: any }>(cacheKey);
    if (cached) {
      logger.debug('Cache hit for listings search', { cacheKey });
      return cached;
    }

    // Execute query (cache miss)
    const { rows: listings, count: total } = await Listing.findAndCountAll({
      where,
      order,
      offset,
      limit,
      include: [
        {
          model: User,
          as: 'seller',
          attributes: ['id', 'name', 'verified', 'trustScore', 'avatar'],
          where: verified !== undefined ? { verified } : undefined,
          required: verified !== undefined,
        },
        {
          association: 'trucks',
          required: false,
          attributes: ['id'],
        },
      ],
    });

    const pagination = getPaginationInfo(page, limit, total);

    const result = { listings, pagination };

    // Cache the result for 5 minutes
    await cacheService.set(cacheKey, result, CacheTTL.LISTING);

    return result;
  }

  // Get single listing by ID
  async getListingById(id: string, userId?: string) {
    const listing = await Listing.findByPk(id, {
      include: [
        {
          model: User,
          as: 'seller',
          attributes: ['id', 'name', 'email', 'phone', 'verified', 'trustScore', 'avatar', 'memberSince', 'companyName'],
        },
        {
          model: Document,
          as: 'documents',
          where: { status: 'VERIFIED' },
          required: false,
          attributes: ['id', 'type', 'name', 'status'],
        },
        {
          association: 'trucks',
          required: false,
          include: [{ association: 'photos' }],
        },
      ],
    });

    if (!listing) {
      throw new NotFoundError('Listing');
    }

    // Atomic increment views
    await listing.increment('views');

    // Check if user has unlocked this listing
    let isUnlocked = false;
    let isSaved = false;
    if (userId) {
      const [unlocked, saved] = await Promise.all([
        UnlockedListing.findOne({ where: { userId, listingId: id } }),
        SavedListing.findOne({ where: { userId, listingId: id } }),
      ]);
      isUnlocked = !!unlocked;
      isSaved = !!saved;
    }

    // Check if user is the seller
    const isOwner = userId === listing.sellerId;

    const listingData = listing.toJSON();

    return {
      ...listingData,
      isUnlocked,
      isSaved,
      isOwner,
      // Hide sensitive info if not unlocked and not owner
      seller: !isUnlocked && !isOwner
        ? {
            ...listingData.seller,
            email: null,
            phone: null,
          }
        : listingData.seller,
    };
  }

  // Create new listing
  async createListing(sellerId: string, data: CreateListingData & { submitForReview?: boolean }) {
    // If payment was made (submitForReview flag), set status to PENDING_REVIEW
    const initialStatus = data.submitForReview ? ListingStatus.PENDING_REVIEW : ListingStatus.DRAFT;

    const listing = await Listing.create({
      sellerId,
      mcNumber: data.mcNumber,
      // Broker/freight-forwarder dockets often have no USDOT — store '' (the
      // column is NOT NULL and every reader falsy-checks it).
      dotNumber: data.dotNumber || '',
      legalName: data.legalName,
      dbaName: data.dbaName,
      // Stored scrubbed so the carrier's identity can't be read back through
      // the title/description, or probed via the LIKE search on them.
      title: publicListingTitle({ ...data, state: data.state?.toUpperCase() }),
      description: data.description ? scrubIdentity(data.description, data) : data.description,
      askingPrice: data.askingPrice,
      city: data.city,
      state: data.state.toUpperCase(),
      address: data.address,
      yearsActive: data.yearsActive || 0,
      fleetSize: data.fleetSize || 0,
      totalDrivers: data.totalDrivers || 0,
      safetyRating: normalizeSafetyRating(data.safetyRating),
      insuranceOnFile: data.insuranceOnFile || false,
      bipdCoverage: data.bipdCoverage,
      cargoCoverage: data.cargoCoverage,
      bondAmount: data.bondAmount,
      amazonStatus: normalizeAmazonStatus(data.amazonStatus),
      amazonRelayScore: data.amazonRelayScore,
      authorityType: normalizeAuthorityType(data.authorityType),
      highwaySetup: data.highwaySetup || false,
      rmisSetup: data.rmisSetup || false,
      sellingWithEmail: data.sellingWithEmail || false,
      sellingWithPhone: data.sellingWithPhone || false,
      contactEmail: data.contactEmail,
      contactPhone: data.contactPhone,
      cargoTypes: data.cargoTypes ? JSON.stringify(data.cargoTypes) : null,
      visibility: (data.visibility?.toUpperCase() as ListingVisibility) || ListingVisibility.PUBLIC,
      isPremium: data.isPremium || false,
      isVip: data.isVip || false,
      fmcsaData: data.fmcsaData || null,
      authorityHistory: data.authorityHistory || null,
      insuranceHistory: data.insuranceHistory || null,
      insuranceCompany: data.insuranceCompany || null,
      monthlyInsurancePremium: data.monthlyInsurancePremium || null,
      status: initialStatus,
    });

    // Optionally create equipment (trucks/trailers) sold with the listing.
    // Entries are cleaned in truckService; ones without a make are skipped.
    const equipmentInput = (data as any).trucks as TruckInput[] | undefined;
    if (Array.isArray(equipmentInput) && equipmentInput.length > 0) {
      const { truckService } = await import('./truckService');
      await truckService.createMany(listing.id, equipmentInput);
    }

    const listingWithSeller = await Listing.findByPk(listing.id, {
      include: [
        {
          model: User,
          as: 'seller',
          attributes: ['id', 'name', 'verified', 'trustScore'],
        },
        { association: 'trucks', required: false, include: [{ association: 'photos' }] },
      ],
    });

    // Invalidate listings cache (new listing added)
    await cacheService.delPattern(`${CacheKeys.LISTINGS}*`);

    return listingWithSeller;
  }

  // Update listing
  async updateListing(id: string, userId: string, data: Partial<CreateListingData>) {
    const listing = await Listing.findByPk(id);

    if (!listing) {
      throw new NotFoundError('Listing');
    }

    if (listing.sellerId !== userId) {
      throw new ForbiddenError('You can only update your own listings');
    }

    // Can't update sold or reserved listings
    if (listing.status === ListingStatus.SOLD || listing.status === ListingStatus.RESERVED) {
      throw new ForbiddenError('Cannot update sold or reserved listings');
    }

    await listing.update({
      ...(data.title && { title: publicListingTitle({ ...listing.toJSON(), title: data.title }) }),
      ...(data.description !== undefined && {
        description: data.description ? scrubIdentity(data.description, listing.toJSON()) : data.description,
      }),
      ...(data.askingPrice && { askingPrice: data.askingPrice }),
      ...(data.listingPrice !== undefined && { listingPrice: data.listingPrice }),
      ...(data.city && { city: data.city }),
      ...(data.state && { state: data.state.toUpperCase() }),
      ...(data.yearsActive !== undefined && { yearsActive: data.yearsActive }),
      ...(data.fleetSize !== undefined && { fleetSize: data.fleetSize }),
      ...(data.totalDrivers !== undefined && { totalDrivers: data.totalDrivers }),
      ...(data.safetyRating && { safetyRating: normalizeSafetyRating(data.safetyRating) }),
      ...(data.insuranceOnFile !== undefined && { insuranceOnFile: data.insuranceOnFile }),
      ...(data.bipdCoverage !== undefined && { bipdCoverage: data.bipdCoverage }),
      ...(data.cargoCoverage !== undefined && { cargoCoverage: data.cargoCoverage }),
      ...(data.amazonStatus && { amazonStatus: normalizeAmazonStatus(data.amazonStatus) }),
      ...(data.amazonRelayScore !== undefined && { amazonRelayScore: data.amazonRelayScore }),
      ...(data.authorityType && { authorityType: normalizeAuthorityType(data.authorityType) }),
      ...(data.highwaySetup !== undefined && { highwaySetup: data.highwaySetup }),
      ...(data.sellingWithEmail !== undefined && { sellingWithEmail: data.sellingWithEmail }),
      ...(data.sellingWithPhone !== undefined && { sellingWithPhone: data.sellingWithPhone }),
      ...(data.rmisSetup !== undefined && { rmisSetup: data.rmisSetup }),
      ...(data.setupWithBrokers !== undefined && { setupWithBrokers: data.setupWithBrokers }),
      ...(data.contactEmail !== undefined && { contactEmail: data.contactEmail }),
      ...(data.contactPhone !== undefined && { contactPhone: data.contactPhone }),
      ...(data.bondAmount !== undefined && { bondAmount: data.bondAmount }),
      ...(data.insuranceCompany !== undefined && { insuranceCompany: data.insuranceCompany }),
      ...(data.monthlyInsurancePremium !== undefined && { monthlyInsurancePremium: data.monthlyInsurancePremium }),
      ...(data.cargoTypes && { cargoTypes: JSON.stringify(data.cargoTypes) }),
      ...(data.visibility && { visibility: data.visibility.toUpperCase() }),
      ...(data.isPremium !== undefined && { isPremium: data.isPremium }),
      ...(data.isVip !== undefined && { isVip: data.isVip }),
    });

    const updated = await Listing.findByPk(id, {
      include: [{
        model: User,
        as: 'seller',
        attributes: ['id', 'name', 'verified', 'trustScore'],
      }],
    });

    // Invalidate caches for this listing and search results
    await cacheService.invalidateListing(id);

    return updated;
  }

  // Submit listing for review
  async submitForReview(id: string, userId: string) {
    const listing = await Listing.findByPk(id);

    if (!listing) {
      throw new NotFoundError('Listing');
    }

    if (listing.sellerId !== userId) {
      throw new ForbiddenError('You can only submit your own listings');
    }

    if (listing.status !== ListingStatus.DRAFT && listing.status !== ListingStatus.REJECTED) {
      throw new ForbiddenError('Only draft or rejected listings can be submitted for review');
    }

    // Check if listing payment is required (admin-configurable setting)
    const { adminService } = await import('./adminService');
    const paymentRequired = await adminService.isListingPaymentRequired();

    if (paymentRequired && !listing.listingFeePaid) {
      throw new ForbiddenError('Listing fee payment is required before submission. Please complete the payment first.');
    }

    await listing.update({ status: ListingStatus.PENDING_REVIEW });

    // Invalidate caches (status changed)
    await cacheService.invalidateListing(id);

    return listing;
  }

  // Delete listing
  async deleteListing(id: string, userId: string) {
    const listing = await Listing.findByPk(id);

    if (!listing) {
      throw new NotFoundError('Listing');
    }

    if (listing.sellerId !== userId) {
      throw new ForbiddenError('You can only delete your own listings');
    }

    if (listing.status === ListingStatus.SOLD || listing.status === ListingStatus.RESERVED) {
      throw new ForbiddenError('Cannot delete sold or reserved listings');
    }

    await listing.destroy();

    // Invalidate caches
    await cacheService.invalidateListing(id);

    return { success: true };
  }

  // Save listing
  async saveListing(listingId: string, userId: string) {
    const listing = await Listing.findByPk(listingId);

    if (!listing) {
      throw new NotFoundError('Listing');
    }

    await SavedListing.findOrCreate({
      where: { userId, listingId },
      defaults: { userId, listingId },
    });

    // Atomic increment saves count
    await listing.increment('saves');

    return { success: true };
  }

  // Unsave listing
  async unsaveListing(listingId: string, userId: string) {
    const listing = await Listing.findByPk(listingId);

    if (!listing) {
      throw new NotFoundError('Listing');
    }

    await SavedListing.destroy({ where: { userId, listingId } });

    // Atomic decrement saves count (floor at 0)
    if (listing.saves > 0) {
      await listing.decrement('saves');
    }

    return { success: true };
  }

  // Get saved listings
  async getSavedListings(userId: string, page: number = 1, limit: number = 20) {
    const offset = (page - 1) * limit;

    const { rows: savedListings, count: total } = await SavedListing.findAndCountAll({
      where: { userId },
      offset,
      limit,
      order: [['createdAt', 'DESC']],
      include: [{
        model: Listing,
        as: 'listing',
        include: [{
          model: User,
          as: 'seller',
          attributes: ['id', 'name', 'verified', 'trustScore'],
        }],
      }],
    });

    const pagination = getPaginationInfo(page, limit, total);

    return {
      listings: savedListings.map((sl) => sl.listing),
      pagination,
    };
  }

  // Get seller's listings
  async getSellerListings(sellerId: string, status?: ListingStatus) {
    const where: WhereOptions = { sellerId };
    if (status) {
      (where as Record<string, unknown>).status = status;
    }

    const listings = await Listing.findAll({
      where,
      order: [['createdAt', 'DESC']],
    });

    return listings;
  }

  // Unlock listing (use credit)
  async unlockListing(listingId: string, userId: string) {
    const listing = await Listing.findByPk(listingId);

    if (!listing) {
      throw new NotFoundError('Listing');
    }

    // Check if already unlocked
    const existing = await UnlockedListing.findOne({ where: { userId, listingId } });

    if (existing) {
      return { success: true, alreadyUnlocked: true };
    }

    // Check user
    const user = await User.findByPk(userId);

    if (!user) {
      throw new NotFoundError('User');
    }

    // Free-to-unlock listings: require active subscription but no credit
    if (listing.freeToUnlock) {
      const subscription = await Subscription.findOne({
        where: { userId, status: SubscriptionStatus.ACTIVE },
      });

      if (!subscription) {
        throw new ForbiddenError('An active subscription is required to unlock free listings.');
      }

      const t = await sequelize.transaction();
      try {
        await UnlockedListing.create(
          { userId, listingId, creditsUsed: 0 },
          { transaction: t }
        );

        await CreditTransaction.create(
          {
            userId,
            type: CreditTransactionType.USAGE,
            amount: 0,
            balance: user.totalCredits - user.usedCredits,
            description: `Free unlock - listing MC-${listing.mcNumber}`,
            reference: listingId,
          },
          { transaction: t }
        );

        await t.commit();
      } catch (error) {
        await t.rollback();
        throw error;
      }

      return { success: true, alreadyUnlocked: false };
    }

    // Standard unlock: deduct 1 credit
    const availableCredits = user.totalCredits - user.usedCredits;
    if (availableCredits < 1) {
      throw new ForbiddenError('Insufficient credits. Please purchase more credits.');
    }

    const t = await sequelize.transaction();

    try {
      await UnlockedListing.create(
        { userId, listingId, creditsUsed: 1 },
        { transaction: t }
      );

      await user.update(
        { usedCredits: user.usedCredits + 1 },
        { transaction: t }
      );

      await CreditTransaction.create(
        {
          userId,
          type: CreditTransactionType.USAGE,
          amount: -1,
          balance: availableCredits - 1,
          description: `Unlocked listing MC-${listing.mcNumber}`,
          reference: listingId,
        },
        { transaction: t }
      );

      await t.commit();
    } catch (error) {
      await t.rollback();
      throw error;
    }

    return { success: true, alreadyUnlocked: false };
  }

  // Get unlocked listings
  async getUnlockedListings(userId: string, page: number = 1, limit: number = 20) {
    const offset = (page - 1) * limit;

    const { rows: unlockedListings, count: total } = await UnlockedListing.findAndCountAll({
      where: { userId },
      offset,
      limit,
      order: [['createdAt', 'DESC']],
      include: [{
        model: Listing,
        as: 'listing',
        include: [{
          model: User,
          as: 'seller',
          attributes: ['id', 'name', 'email', 'phone', 'verified', 'trustScore'],
        }],
      }],
    });

    const pagination = getPaginationInfo(page, limit, total);

    return {
      listings: unlockedListings.map((ul) => ({
        ...(ul.listing as Listing).toJSON(),
        unlockedAt: ul.createdAt,
      })),
      pagination,
    };
  }
}

export const listingService = new ListingService();
export default listingService;
