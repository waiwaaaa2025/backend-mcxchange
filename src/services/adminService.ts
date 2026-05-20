import { Op, QueryTypes } from 'sequelize';
import sequelize from '../config/database';
import { cacheService, CacheKeys, CacheTTL } from './cacheService';
import { notifyMatchingBuyers } from './matchNotificationService';
import {
  User,
  Listing,
  Transaction,
  TransactionTimeline,
  PremiumRequest,
  AdminAction,
  Notification,
  PlatformSetting,
  RefreshToken,
  PasswordResetToken,
  Offer,
  AccountDispute,
  UnlockedListing,
  CreditTransaction,
  Payment,
  ListingStatus,
  UserStatus,
  PremiumRequestStatus,
  TransactionStatus,
  NotificationType,
  UserRole,
  OfferStatus,
  AccountDisputeStatus,
  CreditTransactionType,
  PaymentType,
  PaymentStatus,
  PaymentMethod,
  SubscriptionStatus,
  Subscription,
  BrokerOutreachRequest,
  BrokerOutreachStatus,
} from '../models';
import { NotFoundError, BadRequestError, ForbiddenError } from '../middleware/errorHandler';
import { getPaginationInfo, calculateDeposit, calculatePlatformFee } from '../utils/helpers';
import { emailService } from './emailService';
import { adminNotificationService } from './adminNotificationService';
import { config } from '../config';
import logger from '../utils/logger';
import type Stripe from 'stripe';
import { stripeService, SUBSCRIPTION_PRICE_IDS } from './stripeService';
import { buyerPreferencesService, BuyerPreferencesInput } from './buyerPreferencesService';
import { rankListings, hasAnyCriteria } from './matchService';

class AdminService {
  // Get dashboard stats (cached for 5 minutes to reduce query load)
  async getDashboardStats() {
    // Try cache first
    const cacheKey = `${CacheKeys.STATS}dashboard`;
    const cached = await cacheService.get<any>(cacheKey);
    if (cached) {
      return cached;
    }

    // OPTIMIZED: Use a single raw query instead of 14 separate COUNT queries
    // NOTE: Table names must be lowercase to match Sequelize-created tables on Linux (case-sensitive)
    const statsQuery = `
      SELECT
        (SELECT COUNT(*) FROM users) as totalUsers,
        (SELECT COUNT(*) FROM users WHERE role = 'SELLER') as totalSellers,
        (SELECT COUNT(*) FROM users WHERE role = 'BUYER') as totalBuyers,
        (SELECT COUNT(*) FROM users WHERE status = 'ACTIVE') as activeUsers,
        (SELECT COUNT(*) FROM listings) as totalListings,
        (SELECT COUNT(*) FROM listings WHERE status = 'ACTIVE') as activeListings,
        (SELECT COUNT(*) FROM listings WHERE status = 'PENDING_REVIEW') as pendingListings,
        (SELECT COUNT(*) FROM listings WHERE status = 'SOLD') as soldListings,
        (SELECT COUNT(*) FROM transactions) as totalTransactions,
        (SELECT COUNT(*) FROM transactions WHERE status != 'COMPLETED') as activeTransactions,
        (SELECT COUNT(*) FROM transactions WHERE status = 'COMPLETED') as completedTransactions,
        (SELECT COUNT(*) FROM premium_requests WHERE status = 'PENDING') as pendingPremiumRequests,
        (SELECT COUNT(*) FROM offers) as totalOffers,
        (SELECT COUNT(*) FROM offers WHERE status = 'PENDING') as pendingOffers,
        (SELECT COALESCE(SUM(platformFee), 0) FROM transactions WHERE status = 'COMPLETED') as totalRevenue
    `;

    const [result] = await sequelize.query<{
      totalUsers: string;
      totalSellers: string;
      totalBuyers: string;
      activeUsers: string;
      totalListings: string;
      activeListings: string;
      pendingListings: string;
      soldListings: string;
      totalTransactions: string;
      activeTransactions: string;
      completedTransactions: string;
      pendingPremiumRequests: string;
      totalOffers: string;
      pendingOffers: string;
      totalRevenue: string;
    }>(statsQuery, { type: QueryTypes.SELECT });

    const stats = {
      // Users
      totalUsers: parseInt(result.totalUsers || '0', 10),
      totalSellers: parseInt(result.totalSellers || '0', 10),
      totalBuyers: parseInt(result.totalBuyers || '0', 10),
      activeUsers: parseInt(result.activeUsers || '0', 10),
      // Listings
      totalListings: parseInt(result.totalListings || '0', 10),
      activeListings: parseInt(result.activeListings || '0', 10),
      pendingListings: parseInt(result.pendingListings || '0', 10),
      soldListings: parseInt(result.soldListings || '0', 10),
      // Transactions
      totalTransactions: parseInt(result.totalTransactions || '0', 10),
      activeTransactions: parseInt(result.activeTransactions || '0', 10),
      completedTransactions: parseInt(result.completedTransactions || '0', 10),
      // Offers
      totalOffers: parseInt(result.totalOffers || '0', 10),
      pendingOffers: parseInt(result.pendingOffers || '0', 10),
      // Premium
      premiumRequests: parseInt(result.pendingPremiumRequests || '0', 10),
      // Revenue
      totalRevenue: parseFloat(result.totalRevenue || '0'),
      monthlyRevenue: 0, // Would need date filtering for this
    };

    // Cache for 5 minutes
    await cacheService.set(cacheKey, stats, CacheTTL.MEDIUM);

    return stats;
  }

  // Get pending listings for review
  async getPendingListings(page: number = 1, limit: number = 20) {
    const offset = (page - 1) * limit;

    const { count: total, rows: listings } = await Listing.findAndCountAll({
      where: { status: ListingStatus.PENDING_REVIEW },
      order: [['createdAt', 'ASC']],
      offset,
      limit,
      include: [
        {
          model: User,
          as: 'seller',
          attributes: ['id', 'name', 'email', 'verified', 'trustScore'],
        },
      ],
    });

    return {
      listings,
      pagination: getPaginationInfo(page, limit, total),
    };
  }

  // Approve listing
  async approveListing(listingId: string, adminId: string, notes?: string, listingPrice?: number, freeToUnlock?: boolean) {
    const listing = await Listing.findByPk(listingId);

    if (!listing) {
      throw new NotFoundError('Listing');
    }

    // If no listingPrice provided, default to askingPrice
    const finalListingPrice = listingPrice !== undefined ? listingPrice : listing.askingPrice;

    await listing.update({
      status: ListingStatus.ACTIVE,
      listingPrice: finalListingPrice,
      freeToUnlock: freeToUnlock || false,
      reviewedBy: adminId,
      reviewedAt: new Date(),
      reviewNotes: notes,
      publishedAt: new Date(),
    });

    // Record admin action
    await AdminAction.create({
      adminId,
      action: 'APPROVE_LISTING',
      targetType: 'LISTING',
      targetId: listingId,
      reason: notes,
    });

    // Notify seller
    await Notification.create({
      userId: listing.sellerId,
      type: NotificationType.VERIFICATION,
      title: 'Listing Approved',
      message: `Your listing MC-${listing.mcNumber} has been approved and is now live.`,
      link: `/seller/listings`,
    });

    // Fan out match emails to buyers whose preferences match this listing.
    // Fire-and-forget — we don't want email failures to block the approval response.
    notifyMatchingBuyers(listingId).catch((err) => {
      console.error('notifyMatchingBuyers failed for listing', listingId, err);
    });

    return listing;
  }

  // Reject listing
  async rejectListing(listingId: string, adminId: string, reason: string) {
    const listing = await Listing.findByPk(listingId);

    if (!listing) {
      throw new NotFoundError('Listing');
    }

    await listing.update({
      status: ListingStatus.REJECTED,
      reviewedBy: adminId,
      reviewedAt: new Date(),
      rejectionReason: reason,
    });

    // Record admin action
    await AdminAction.create({
      adminId,
      action: 'REJECT_LISTING',
      targetType: 'LISTING',
      targetId: listingId,
      reason,
    });

    // Notify seller
    await Notification.create({
      userId: listing.sellerId,
      type: NotificationType.VERIFICATION,
      title: 'Listing Rejected',
      message: `Your listing MC-${listing.mcNumber} was not approved. Reason: ${reason}`,
      link: `/seller/listings`,
    });

    return listing;
  }

  // Get all users with filters
  async getUsers(params: {
    page?: number;
    limit?: number;
    search?: string;
    role?: string;
    status?: string;
    subscriptionStatus?: string;
  }) {
    const { page = 1, limit = 20, search, role, status, subscriptionStatus } = params;
    const offset = (page - 1) * limit;

    const where: any = {};

    if (search) {
      where[Op.or] = [
        { name: { [Op.like]: `%${search}%` } },
        { email: { [Op.like]: `%${search}%` } },
        { companyName: { [Op.like]: `%${search}%` } },
      ];
    }

    if (role) {
      where.role = role;
    }

    if (status) {
      where.status = status;
    }

    const subscriptionInclude: any = {
      model: Subscription,
      as: 'subscription',
      attributes: ['plan', 'status'],
      required: false,
    };
    if (subscriptionStatus) {
      subscriptionInclude.required = true;
      subscriptionInclude.where = { status: subscriptionStatus };
    }

    const { count: total, rows: users } = await User.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      offset,
      limit,
      distinct: true,
      attributes: [
        'id',
        'email',
        'name',
        'phone',
        'role',
        'status',
        'verified',
        'trustScore',
        'memberSince',
        'lastLoginAt',
        'companyName',
        'createdAt',
        'identityVerified',
        'identityVerificationStatus',
        'identityVerifiedAt',
      ],
      include: [subscriptionInclude],
    });

    // OPTIMIZED: Get counts for all users in a SINGLE query instead of N+1
    // This reduces 4*N queries to just 1 query!
    const userIds = users.map(u => u.id);

    if (userIds.length === 0) {
      return { users: [], pagination: getPaginationInfo(page, limit, total) };
    }

    // Single aggregated query for all user stats
    // NOTE: Table names must be lowercase to match Sequelize-created tables on Linux (case-sensitive)
    const statsQuery = `
      SELECT
        u.id as userId,
        COALESCE(l.cnt, 0) as listingsCount,
        COALESCE(o.cnt, 0) as sentOffersCount,
        COALESCE(tb.cnt, 0) as buyerTransactionsCount,
        COALESCE(ts.cnt, 0) as sellerTransactionsCount
      FROM users u
      LEFT JOIN (SELECT sellerId, COUNT(*) as cnt FROM listings GROUP BY sellerId) l ON u.id = l.sellerId
      LEFT JOIN (SELECT buyerId, COUNT(*) as cnt FROM offers GROUP BY buyerId) o ON u.id = o.buyerId
      LEFT JOIN (SELECT buyerId, COUNT(*) as cnt FROM transactions GROUP BY buyerId) tb ON u.id = tb.buyerId
      LEFT JOIN (SELECT sellerId, COUNT(*) as cnt FROM transactions GROUP BY sellerId) ts ON u.id = ts.sellerId
      WHERE u.id IN (:userIds)
    `;

    const stats = await sequelize.query<{
      userId: string;
      listingsCount: string;
      sentOffersCount: string;
      buyerTransactionsCount: string;
      sellerTransactionsCount: string;
    }>(statsQuery, {
      replacements: { userIds },
      type: QueryTypes.SELECT,
    });

    // Create a map for quick lookup
    const statsMap = new Map(stats.map(s => [s.userId, {
      listings: parseInt(s.listingsCount || '0', 10),
      sentOffers: parseInt(s.sentOffersCount || '0', 10),
      buyerTransactions: parseInt(s.buyerTransactionsCount || '0', 10),
      sellerTransactions: parseInt(s.sellerTransactionsCount || '0', 10),
    }]));

    const usersWithCounts = users.map(user => ({
      ...user.toJSON(),
      _count: statsMap.get(user.id) || {
        listings: 0,
        sentOffers: 0,
        buyerTransactions: 0,
        sellerTransactions: 0,
      },
    }));

    return {
      users: usersWithCounts,
      pagination: getPaginationInfo(page, limit, total),
    };
  }

  // Get user details
  async getUserDetails(userId: string) {
    const user = await User.findByPk(userId, {
      attributes: { exclude: ['password'] },
    });

    if (!user) {
      throw new NotFoundError('User');
    }

    // Get related data
    const [listings, sentOffers, receivedOffers, subscription] = await Promise.all([
      Listing.findAll({
        where: { sellerId: userId },
        limit: 10,
        order: [['createdAt', 'DESC']],
      }),
      (await import('../models')).Offer.findAll({
        where: { buyerId: userId },
        limit: 10,
        order: [['createdAt', 'DESC']],
        include: [{ model: Listing, as: 'listing', attributes: ['mcNumber', 'title'] }],
      }),
      (await import('../models')).Offer.findAll({
        where: { sellerId: userId },
        limit: 10,
        order: [['createdAt', 'DESC']],
        include: [{ model: Listing, as: 'listing', attributes: ['mcNumber', 'title'] }],
      }),
      (await import('../models')).Subscription.findOne({ where: { userId } }),
    ]);

    // Get counts
    const [listingsCount, sentOffersCount, receivedOffersCount, buyerTransactionsCount, sellerTransactionsCount] =
      await Promise.all([
        Listing.count({ where: { sellerId: userId } }),
        (await import('../models')).Offer.count({ where: { buyerId: userId } }),
        (await import('../models')).Offer.count({ where: { sellerId: userId } }),
        Transaction.count({ where: { buyerId: userId } }),
        Transaction.count({ where: { sellerId: userId } }),
      ]);

    return {
      ...user.toJSON(),
      listings,
      sentOffers,
      receivedOffers,
      subscription,
      _count: {
        listings: listingsCount,
        sentOffers: sentOffersCount,
        receivedOffers: receivedOffersCount,
        buyerTransactions: buyerTransactionsCount,
        sellerTransactions: sellerTransactionsCount,
      },
    };
  }

  // Block user
  async blockUser(userId: string, adminId: string, reason: string) {
    const user = await User.findByPk(userId);

    if (!user) {
      throw new NotFoundError('User');
    }

    await user.update({ status: UserStatus.BLOCKED });

    // Record admin action
    await AdminAction.create({
      adminId,
      action: 'BLOCK_USER',
      targetType: 'USER',
      targetId: userId,
      reason,
    });

    // Invalidate all refresh tokens
    await RefreshToken.destroy({ where: { userId } });

    return user;
  }

  // Unblock user
  async unblockUser(userId: string, adminId: string) {
    const user = await User.findByPk(userId);

    if (!user) {
      throw new NotFoundError('User');
    }

    await user.update({ status: UserStatus.ACTIVE });

    // Record admin action
    await AdminAction.create({
      adminId,
      action: 'UNBLOCK_USER',
      targetType: 'USER',
      targetId: userId,
    });

    return user;
  }

  // Update user profile
  async updateUser(userId: string, adminId: string, updates: { name?: string; email?: string; phone?: string; companyName?: string }) {
    const user = await User.findByPk(userId);

    if (!user) {
      throw new NotFoundError('User');
    }

    // If email is being changed, check for uniqueness
    if (updates.email && updates.email !== user.email) {
      const existing = await User.findOne({ where: { email: updates.email } });
      if (existing) {
        throw new BadRequestError('Email already in use by another user');
      }
    }

    // Filter out undefined values and unchanged fields
    const fieldsToUpdate: Record<string, string> = {};
    const changes: string[] = [];
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined && value !== (user as any)[key]) {
        fieldsToUpdate[key] = value;
        changes.push(`${key}: "${(user as any)[key]}" → "${value}"`);
      }
    }

    if (Object.keys(fieldsToUpdate).length === 0) {
      return user;
    }

    await user.update(fieldsToUpdate);

    // Record admin action
    await AdminAction.create({
      adminId,
      action: 'UPDATE_USER_PROFILE',
      targetType: 'USER',
      targetId: userId,
      reason: `Profile updated: ${changes.join(', ')}`,
    });

    return user;
  }

  // Update user role
  async updateUserRole(userId: string, adminId: string, newRole: string) {
    const user = await User.findByPk(userId);

    if (!user) {
      throw new NotFoundError('User');
    }

    if (userId === adminId) {
      throw new BadRequestError('Cannot change your own role');
    }

    const oldRole = user.role;
    await user.update({ role: newRole as UserRole });

    // Record admin action
    await AdminAction.create({
      adminId,
      action: 'UPDATE_USER_ROLE',
      targetType: 'USER',
      targetId: userId,
      reason: `Role changed from ${oldRole} to ${newRole}`,
    });

    return user;
  }

  // Adjust user credits (add or remove)
  async adjustUserCredits(userId: string, amount: number, reason: string, adminId: string) {
    const user = await User.findByPk(userId);

    if (!user) {
      throw new NotFoundError('User');
    }

    const currentTotal = user.totalCredits || 0;
    const currentUsed = user.usedCredits || 0;
    const currentAvailable = currentTotal - currentUsed;

    // If removing credits, ensure we don't go negative
    if (amount < 0 && Math.abs(amount) > currentAvailable) {
      throw new BadRequestError(`Cannot remove ${Math.abs(amount)} credits. User only has ${currentAvailable} available credits.`);
    }

    // Update credits
    const newTotal = currentTotal + amount;
    await user.update({ totalCredits: newTotal });

    // Record admin action
    await AdminAction.create({
      adminId,
      action: amount >= 0 ? 'ADD_CREDITS' : 'REMOVE_CREDITS',
      targetType: 'USER',
      targetId: userId,
      reason: `${amount >= 0 ? 'Added' : 'Removed'} ${Math.abs(amount)} credits. Reason: ${reason}`,
    });

    return {
      userId: user.id,
      previousTotal: currentTotal,
      adjustment: amount,
      newTotal,
      usedCredits: currentUsed,
      availableCredits: newTotal - currentUsed,
    };
  }

  // Get premium requests
  async getPremiumRequests(status?: PremiumRequestStatus, page: number = 1, limit: number = 20) {
    const offset = (page - 1) * limit;
    const where = status ? { status } : {};

    const { count: total, rows: requests } = await PremiumRequest.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      offset,
      limit,
      include: [
        {
          model: User,
          as: 'buyer',
          attributes: ['id', 'name', 'email', 'phone', 'trustScore', 'totalCredits', 'usedCredits'],
        },
        {
          model: Listing,
          as: 'listing',
          attributes: ['id', 'mcNumber', 'title', 'askingPrice', 'listingPrice'],
          include: [
            {
              model: User,
              as: 'seller',
              attributes: ['id', 'name', 'email'],
            },
          ],
        },
      ],
    });

    return {
      requests,
      pagination: getPaginationInfo(page, limit, total),
    };
  }

  // ---- Broker Outreach (Pending Insurance Leads) ----

  async getBrokerOutreachRequests(status?: BrokerOutreachStatus, page: number = 1, limit: number = 20) {
    const offset = (page - 1) * limit;
    const where = status ? { status } : {};

    const { count: total, rows: requests } = await BrokerOutreachRequest.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      offset,
      limit,
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['id', 'name', 'email', 'phone', 'trustScore'],
        },
      ],
    });

    return {
      requests,
      pagination: getPaginationInfo(page, limit, total),
    };
  }

  async updateBrokerOutreachRequest(
    requestId: string,
    adminId: string,
    status: BrokerOutreachStatus,
    notes?: string
  ) {
    const request = await BrokerOutreachRequest.findByPk(requestId);
    if (!request) {
      throw new NotFoundError('Broker outreach request');
    }

    const wasContacted = request.status !== BrokerOutreachStatus.PENDING;

    request.status = status;
    if (notes !== undefined) request.adminNotes = notes;
    if (!wasContacted && status !== BrokerOutreachStatus.PENDING) {
      request.contactedAt = new Date();
      request.contactedBy = adminId;
    }
    await request.save();

    await AdminAction.create({
      adminId,
      action: 'UPDATE_BROKER_OUTREACH',
      targetType: 'BROKER_OUTREACH_REQUEST',
      targetId: requestId,
      reason: notes,
      metadata: JSON.stringify({ status, dotNumber: request.dotNumber }),
    });

    return request;
  }

  // Update premium request
  // When status is COMPLETED, this will:
  // 1. Validate buyer has sufficient credits
  // 2. Deduct 1 credit from buyer
  // 3. Create UnlockedListing record
  // 4. Create credit transaction for audit trail
  // 5. Send notification to buyer
  async updatePremiumRequest(requestId: string, adminId: string, status: PremiumRequestStatus, notes?: string) {
    const request = await PremiumRequest.findByPk(requestId, {
      include: [
        { model: User, as: 'buyer' },
        { model: Listing, as: 'listing' },
      ],
    });

    if (!request) {
      throw new NotFoundError('Premium request');
    }

    // If approving (COMPLETED status), handle credit deduction and unlock
    if (status === PremiumRequestStatus.COMPLETED && request.status !== PremiumRequestStatus.COMPLETED) {
      const buyer = request.buyer as User;
      const listing = request.listing as Listing;

      if (!buyer || !listing) {
        throw new BadRequestError('Invalid request data');
      }

      // Check if already unlocked
      const existingUnlock = await UnlockedListing.findOne({
        where: { userId: buyer.id, listingId: listing.id },
      });

      if (existingUnlock) {
        throw new BadRequestError('Buyer already has access to this listing');
      }

      // Check buyer has sufficient credits
      const availableCredits = buyer.totalCredits - buyer.usedCredits;
      if (availableCredits < 1) {
        throw new BadRequestError(`Buyer has insufficient credits (${availableCredits} available). Cannot approve request.`);
      }

      // Use transaction for atomicity
      const t = await sequelize.transaction();

      try {
        // 1. Create UnlockedListing record
        await UnlockedListing.create(
          {
            userId: buyer.id,
            listingId: listing.id,
            creditsUsed: 1,
          },
          { transaction: t }
        );

        // 2. Deduct credit from buyer
        await buyer.update(
          { usedCredits: buyer.usedCredits + 1 },
          { transaction: t }
        );

        // 3. Record credit transaction for audit trail
        await CreditTransaction.create(
          {
            userId: buyer.id,
            type: CreditTransactionType.USAGE,
            amount: -1,
            balance: availableCredits - 1,
            description: `Premium listing unlocked: MC-${listing.mcNumber}`,
            reference: listing.id,
          },
          { transaction: t }
        );

        // 4. Update the premium request status
        await request.update(
          {
            status: PremiumRequestStatus.COMPLETED,
            adminNotes: notes,
            contactedAt: new Date(),
            contactedBy: adminId,
          },
          { transaction: t }
        );

        // 5. Create notification for buyer
        await Notification.create(
          {
            type: NotificationType.SYSTEM,
            title: 'Premium Access Granted',
            message: `Your request for premium listing MC-${listing.mcNumber} has been approved. You can now view the full listing details.`,
            userId: buyer.id,
          },
          { transaction: t }
        );

        await t.commit();

        logger.info('Premium request approved', {
          requestId,
          buyerId: buyer.id,
          listingId: listing.id,
          adminId,
          creditsDeducted: 1,
          newBalance: availableCredits - 1,
        });

        // Reload request with associations for response
        await request.reload({
          include: [
            { model: User, as: 'buyer', attributes: ['id', 'name', 'email', 'totalCredits', 'usedCredits'] },
            { model: Listing, as: 'listing', attributes: ['id', 'mcNumber', 'title', 'askingPrice', 'listingPrice'] },
          ],
        });

        return request;
      } catch (error) {
        await t.rollback();
        logger.error('Failed to approve premium request', { requestId, error });
        throw error;
      }
    }

    // For other status updates (CONTACTED, IN_PROGRESS, CANCELLED), just update the status
    await request.update({
      status,
      adminNotes: notes,
      contactedAt: status === PremiumRequestStatus.CONTACTED ? new Date() : request.contactedAt,
      contactedBy: status === PremiumRequestStatus.CONTACTED ? adminId : request.contactedBy,
    });

    // If cancelled, notify buyer
    if (status === PremiumRequestStatus.CANCELLED) {
      const listing = await Listing.findByPk(request.listingId, { attributes: ['mcNumber'] });
      await Notification.create({
        type: NotificationType.SYSTEM,
        title: 'Premium Request Cancelled',
        message: `Your request for premium listing MC-${listing?.mcNumber || 'Unknown'} has been cancelled.${notes ? ` Reason: ${notes}` : ''}`,
        userId: request.buyerId,
      });
    }

    return request;
  }

  // Get all listings (admin view)
  async getAllListings(params: {
    page?: number;
    limit?: number;
    search?: string;
    status?: string;
    isPremium?: boolean;
    isVip?: boolean;
  }) {
    const { page = 1, limit = 20, search, status, isPremium, isVip } = params;
    const offset = (page - 1) * limit;

    const where: any = {};

    if (search) {
      where[Op.or] = [
        { mcNumber: { [Op.like]: `%${search}%` } },
        { dotNumber: { [Op.like]: `%${search}%` } },
        { title: { [Op.like]: `%${search}%` } },
        { legalName: { [Op.like]: `%${search}%` } },
      ];
    }

    if (status) {
      where.status = status;
    }

    if (isPremium !== undefined) {
      where.isPremium = isPremium;
    }

    if (isVip !== undefined) {
      where.isVip = isVip;
    }

    const { count: total, rows: listings } = await Listing.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      offset,
      limit,
      include: [
        {
          model: User,
          as: 'seller',
          attributes: ['id', 'name', 'email', 'verified', 'trustScore'],
        },
      ],
    });

    return {
      listings,
      pagination: getPaginationInfo(page, limit, total),
    };
  }

  // Get single listing by ID (admin view - returns any status)
  async getListingById(listingId: string) {
    const listing = await Listing.findByPk(listingId, {
      include: [
        {
          model: User,
          as: 'seller',
          attributes: ['id', 'name', 'email', 'verified', 'trustScore', 'createdAt', 'phone', 'companyName'],
        },
      ],
    });

    if (!listing) {
      throw new NotFoundError('Listing');
    }

    return listing;
  }

  // Admin update listing (can update any field including status)
  async updateListing(listingId: string, adminId: string, data: {
    sellerId?: string;
    mcNumber?: string;
    dotNumber?: string;
    legalName?: string;
    dbaName?: string;
    title?: string;
    description?: string;
    askingPrice?: number;
    listingPrice?: number | null;
    city?: string;
    state?: string;
    address?: string;
    yearsActive?: number;
    fleetSize?: number;
    totalDrivers?: number;
    safetyRating?: string;
    saferScore?: string;
    insuranceOnFile?: boolean;
    bipdCoverage?: number;
    cargoCoverage?: number;
    bondAmount?: number;
    insuranceCompany?: string;
    monthlyInsurancePremium?: number;
    amazonStatus?: string;
    amazonRelayScore?: string;
    highwaySetup?: boolean;
    sellingWithEmail?: boolean;
    sellingWithPhone?: boolean;
    contactEmail?: string;
    contactPhone?: string;
    cargoTypes?: string[];
    fmcsaData?: string;
    authorityHistory?: string;
    insuranceHistory?: string;
    reviewNotes?: string;
    status?: string;
    visibility?: string;
    isPremium?: boolean;
    isVip?: boolean;
    freeToUnlock?: boolean;
  }) {
    const listing = await Listing.findByPk(listingId);

    if (!listing) {
      throw new NotFoundError('Listing');
    }

    // Build update object
    const updateData: any = {};

    // Handle seller reassignment
    if (data.sellerId !== undefined && data.sellerId !== listing.sellerId) {
      const newSeller = await User.findByPk(data.sellerId);
      if (!newSeller) {
        throw new NotFoundError('New seller');
      }
      updateData.sellerId = data.sellerId;

      // Log seller reassignment separately for audit trail
      await AdminAction.create({
        adminId,
        action: 'REASSIGN_LISTING_SELLER',
        targetType: 'LISTING',
        targetId: listingId,
        metadata: JSON.stringify({
          previousSellerId: listing.sellerId,
          newSellerId: data.sellerId,
        }),
      });
    }

    if (data.mcNumber !== undefined) updateData.mcNumber = data.mcNumber;
    if (data.dotNumber !== undefined) updateData.dotNumber = data.dotNumber;
    if (data.legalName !== undefined) updateData.legalName = data.legalName;
    if (data.dbaName !== undefined) updateData.dbaName = data.dbaName;
    if (data.title !== undefined) updateData.title = data.title;
    if (data.description !== undefined) updateData.description = data.description;
    if (data.askingPrice !== undefined) updateData.askingPrice = data.askingPrice;
    if (data.listingPrice !== undefined) updateData.listingPrice = data.listingPrice;
    if (data.city !== undefined) updateData.city = data.city;
    if (data.state !== undefined) updateData.state = data.state.toUpperCase();
    if (data.address !== undefined) updateData.address = data.address;
    if (data.yearsActive !== undefined) updateData.yearsActive = data.yearsActive;
    if (data.fleetSize !== undefined) updateData.fleetSize = data.fleetSize;
    if (data.totalDrivers !== undefined) updateData.totalDrivers = data.totalDrivers;
    if (data.safetyRating !== undefined) updateData.safetyRating = data.safetyRating.toUpperCase();
    if (data.saferScore !== undefined) updateData.saferScore = data.saferScore;
    if (data.insuranceOnFile !== undefined) updateData.insuranceOnFile = data.insuranceOnFile;
    if (data.bipdCoverage !== undefined) updateData.bipdCoverage = data.bipdCoverage;
    if (data.cargoCoverage !== undefined) updateData.cargoCoverage = data.cargoCoverage;
    if (data.bondAmount !== undefined) updateData.bondAmount = data.bondAmount;
    if (data.insuranceCompany !== undefined) updateData.insuranceCompany = data.insuranceCompany;
    if (data.monthlyInsurancePremium !== undefined) updateData.monthlyInsurancePremium = data.monthlyInsurancePremium;
    if (data.amazonStatus !== undefined) updateData.amazonStatus = data.amazonStatus.toUpperCase();
    if (data.amazonRelayScore !== undefined) updateData.amazonRelayScore = data.amazonRelayScore;
    if (data.highwaySetup !== undefined) updateData.highwaySetup = data.highwaySetup;
    if (data.sellingWithEmail !== undefined) updateData.sellingWithEmail = data.sellingWithEmail;
    if (data.sellingWithPhone !== undefined) updateData.sellingWithPhone = data.sellingWithPhone;
    if (data.contactEmail !== undefined) updateData.contactEmail = data.contactEmail;
    if (data.contactPhone !== undefined) updateData.contactPhone = data.contactPhone;
    if (data.cargoTypes !== undefined) updateData.cargoTypes = JSON.stringify(data.cargoTypes);
    if (data.fmcsaData !== undefined) updateData.fmcsaData = data.fmcsaData;
    if (data.authorityHistory !== undefined) updateData.authorityHistory = data.authorityHistory;
    if (data.insuranceHistory !== undefined) updateData.insuranceHistory = data.insuranceHistory;
    if (data.reviewNotes !== undefined) updateData.reviewNotes = data.reviewNotes;
    if (data.status !== undefined) updateData.status = data.status.toUpperCase();
    if (data.visibility !== undefined) updateData.visibility = data.visibility.toUpperCase();
    if (data.isPremium !== undefined) updateData.isPremium = data.isPremium;
    if (data.isVip !== undefined) updateData.isVip = data.isVip;
    if (data.freeToUnlock !== undefined) updateData.freeToUnlock = data.freeToUnlock;

    await listing.update(updateData);

    // Record admin action
    await AdminAction.create({
      adminId,
      action: 'UPDATE_LISTING',
      targetType: 'LISTING',
      targetId: listingId,
      metadata: JSON.stringify(data),
    });

    // Get updated listing with seller info
    const updatedListing = await Listing.findByPk(listingId, {
      include: [
        {
          model: User,
          as: 'seller',
          attributes: ['id', 'name', 'email', 'verified', 'trustScore', 'createdAt', 'phone', 'companyName'],
        },
      ],
    });

    return updatedListing;
  }

  // Get all transactions (admin view)
  async getAllTransactions(params: {
    page?: number;
    limit?: number;
    status?: string;
  }) {
    const { page = 1, limit = 20, status } = params;
    const offset = (page - 1) * limit;

    const where: any = {};

    if (status) {
      where.status = status;
    }

    const { count: total, rows: transactions } = await Transaction.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      offset,
      limit,
      include: [
        {
          model: Listing,
          as: 'listing',
          attributes: ['id', 'mcNumber', 'title'],
        },
        {
          model: User,
          as: 'buyer',
          attributes: ['id', 'name', 'email'],
        },
        {
          model: User,
          as: 'seller',
          attributes: ['id', 'name', 'email'],
        },
      ],
    });

    return {
      transactions,
      pagination: getPaginationInfo(page, limit, total),
    };
  }

  // Reassign the buyer and/or seller on a transaction (admin override)
  async reassignTransactionParty(
    transactionId: string,
    adminId: string,
    data: { buyerId?: string; sellerId?: string }
  ) {
    if (!data.buyerId && !data.sellerId) {
      throw new BadRequestError('Must provide buyerId or sellerId');
    }

    const transaction = await Transaction.findByPk(transactionId);
    if (!transaction) {
      throw new NotFoundError('Transaction');
    }

    const updates: { buyerId?: string; sellerId?: string } = {};
    const timelineLines: string[] = [];
    const auditMeta: Record<string, string | undefined> = {};

    const newBuyerId = data.buyerId && data.buyerId !== transaction.buyerId ? data.buyerId : undefined;
    const newSellerId = data.sellerId && data.sellerId !== transaction.sellerId ? data.sellerId : undefined;

    if (!newBuyerId && !newSellerId) {
      throw new BadRequestError('No changes — provided ids match current parties');
    }

    // Validate the resulting buyer and seller are not the same person
    const resultingBuyerId = newBuyerId ?? transaction.buyerId;
    const resultingSellerId = newSellerId ?? transaction.sellerId;
    if (resultingBuyerId === resultingSellerId) {
      throw new BadRequestError('Buyer and seller cannot be the same user');
    }

    if (newBuyerId) {
      const buyer = await User.findByPk(newBuyerId);
      if (!buyer) throw new NotFoundError('New buyer');
      if (buyer.role !== UserRole.BUYER && buyer.role !== UserRole.ADMIN) {
        throw new BadRequestError('New buyer must have BUYER role');
      }
      if (buyer.status === UserStatus.BLOCKED || buyer.status === UserStatus.SUSPENDED) {
        throw new BadRequestError('New buyer account is suspended or blocked');
      }
      updates.buyerId = newBuyerId;
      auditMeta.previousBuyerId = transaction.buyerId;
      auditMeta.newBuyerId = newBuyerId;
      timelineLines.push(`Buyer reassigned from ${transaction.buyerId} to ${newBuyerId}`);
    }

    if (newSellerId) {
      const seller = await User.findByPk(newSellerId);
      if (!seller) throw new NotFoundError('New seller');
      if (seller.role !== UserRole.SELLER && seller.role !== UserRole.ADMIN) {
        throw new BadRequestError('New seller must have SELLER role');
      }
      if (seller.status === UserStatus.BLOCKED || seller.status === UserStatus.SUSPENDED) {
        throw new BadRequestError('New seller account is suspended or blocked');
      }
      updates.sellerId = newSellerId;
      auditMeta.previousSellerId = transaction.sellerId;
      auditMeta.newSellerId = newSellerId;
      timelineLines.push(`Seller reassigned from ${transaction.sellerId} to ${newSellerId}`);
    }

    await transaction.update(updates);

    await AdminAction.create({
      adminId,
      action: 'REASSIGN_TRANSACTION_PARTY',
      targetType: 'TRANSACTION',
      targetId: transactionId,
      metadata: JSON.stringify(auditMeta),
    });

    await TransactionTimeline.create({
      transactionId,
      status: transaction.status,
      title: 'Transaction parties reassigned',
      description: timelineLines.join('\n'),
      actorId: adminId,
      actorRole: UserRole.ADMIN,
    });

    return Transaction.findByPk(transactionId, {
      include: [
        { model: User, as: 'buyer', attributes: ['id', 'name', 'email'] },
        { model: User, as: 'seller', attributes: ['id', 'name', 'email'] },
      ],
    });
  }

  // Get admin action log
  async getAdminActionLog(adminId?: string, page: number = 1, limit: number = 50) {
    const offset = (page - 1) * limit;
    const where = adminId ? { adminId } : {};

    const { count: total, rows: actions } = await AdminAction.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      offset,
      limit,
      include: [
        {
          model: User,
          as: 'admin',
          attributes: ['id', 'name', 'email'],
        },
      ],
    });

    return {
      actions,
      pagination: getPaginationInfo(page, limit, total),
    };
  }

  // Verify seller
  async verifySeller(userId: string, adminId: string) {
    const user = await User.findByPk(userId);

    if (!user) {
      throw new NotFoundError('User');
    }

    await user.update({
      sellerVerified: true,
      sellerVerifiedAt: new Date(),
      verified: true,
      verifiedAt: new Date(),
      // Boost trust score for verified sellers
      trustScore: Math.min(100, user.trustScore + 20),
    });

    // Record admin action
    await AdminAction.create({
      adminId,
      action: 'VERIFY_SELLER',
      targetType: 'USER',
      targetId: userId,
    });

    // Notify seller
    await Notification.create({
      userId,
      type: NotificationType.VERIFICATION,
      title: 'Seller Verification Complete',
      message: 'Congratulations! Your seller account has been verified.',
      link: '/seller/dashboard',
    });

    return user;
  }

  // ==================== PLATFORM SETTINGS ====================

  // Get all platform settings
  async getSettings() {
    const settings = await PlatformSetting.findAll();

    // Convert to key-value object
    const result: Record<string, unknown> = {};
    for (const setting of settings) {
      let value: unknown = setting.value;
      if (setting.type === 'number') {
        value = parseFloat(setting.value);
      } else if (setting.type === 'boolean') {
        value = setting.value === 'true';
      } else if (setting.type === 'json') {
        try {
          value = JSON.parse(setting.value);
        } catch {
          value = setting.value;
        }
      }
      result[setting.key] = value;
    }

    return result;
  }

  // Get a single setting
  async getSetting(key: string) {
    const setting = await PlatformSetting.findOne({ where: { key } });

    if (!setting) {
      return null;
    }

    let value: unknown = setting.value;
    if (setting.type === 'number') {
      value = parseFloat(setting.value);
    } else if (setting.type === 'boolean') {
      value = setting.value === 'true';
    } else if (setting.type === 'json') {
      try {
        value = JSON.parse(setting.value);
      } catch {
        value = setting.value;
      }
    }

    return { key: setting.key, value, type: setting.type };
  }

  // Update a setting
  async updateSetting(key: string, value: string, type: string = 'string') {
    const [setting, created] = await PlatformSetting.upsert({
      key,
      value,
      type,
    });
    return setting;
  }

  // Update multiple settings
  async updateSettings(settings: Array<{ key: string; value: string; type?: string }>) {
    const results = await Promise.all(
      settings.map((s) => this.updateSetting(s.key, s.value, s.type || 'string'))
    );
    return results;
  }

  // Check if listing payment is required (admin-configurable)
  async isListingPaymentRequired(): Promise<boolean> {
    const setting = await this.getSetting('listing_payment_required');
    // Default to true (payment required) if setting doesn't exist
    return setting?.value !== false;
  }

  // ==================== ANALYTICS ====================

  // Get revenue analytics
  async getRevenueAnalytics(startDate?: Date, endDate?: Date) {
    const where: any = { status: TransactionStatus.COMPLETED };
    if (startDate || endDate) {
      where.completedAt = {};
      if (startDate) where.completedAt[Op.gte] = startDate;
      if (endDate) where.completedAt[Op.lte] = endDate;
    }

    const transactions = await Transaction.findAll({
      where,
      attributes: ['agreedPrice', 'platformFee', 'completedAt'],
    });

    const totalRevenue = transactions.reduce((sum, t) => sum + Number(t.platformFee || 0), 0);
    const totalVolume = transactions.reduce((sum, t) => sum + Number(t.agreedPrice), 0);

    return {
      totalRevenue,
      totalVolume,
      transactionCount: transactions.length,
      averageTransactionValue: transactions.length > 0 ? totalVolume / transactions.length : 0,
    };
  }

  // Get user analytics
  async getUserAnalytics(startDate?: Date, endDate?: Date) {
    const where: any = {};
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt[Op.gte] = startDate;
      if (endDate) where.createdAt[Op.lte] = endDate;
    }

    const [totalUsers, buyerCount, sellerCount, adminCount, verifiedCount] = await Promise.all([
      User.count({ where }),
      User.count({ where: { ...where, role: UserRole.BUYER } }),
      User.count({ where: { ...where, role: UserRole.SELLER } }),
      User.count({ where: { ...where, role: UserRole.ADMIN } }),
      User.count({ where: { ...where, verified: true } }),
    ]);

    return {
      totalUsers,
      byRole: {
        buyers: buyerCount,
        sellers: sellerCount,
        admins: adminCount,
      },
      verifiedCount,
      verificationRate: totalUsers > 0 ? ((verifiedCount / totalUsers) * 100).toFixed(2) : 0,
    };
  }

  // Get listing analytics
  async getListingAnalytics(startDate?: Date, endDate?: Date) {
    const where: any = {};
    if (startDate || endDate) {
      where.createdAt = {};
      if (startDate) where.createdAt[Op.gte] = startDate;
      if (endDate) where.createdAt[Op.lte] = endDate;
    }

    const [totalListings, activeCount, pendingCount, soldCount, premiumCount, totalViews, totalSaves] =
      await Promise.all([
        Listing.count({ where }),
        Listing.count({ where: { ...where, status: ListingStatus.ACTIVE } }),
        Listing.count({ where: { ...where, status: ListingStatus.PENDING_REVIEW } }),
        Listing.count({ where: { ...where, status: ListingStatus.SOLD } }),
        Listing.count({ where: { ...where, isPremium: true } }),
        Listing.sum('views', { where }),
        Listing.sum('saves', { where }),
      ]);

    // Average price
    const avgPrice = await Listing.findOne({
      where: { ...where, status: ListingStatus.ACTIVE },
      attributes: [[Listing.sequelize!.fn('AVG', Listing.sequelize!.col('askingPrice')), 'avgPrice']],
      raw: true,
    });

    return {
      totalListings,
      byStatus: {
        active: activeCount,
        pending: pendingCount,
        sold: soldCount,
      },
      premiumCount,
      premiumRate: totalListings > 0 ? ((premiumCount / totalListings) * 100).toFixed(2) : 0,
      totalViews: totalViews || 0,
      totalSaves: totalSaves || 0,
      averagePrice: (avgPrice as any)?.avgPrice || 0,
      conversionRate: totalListings > 0 ? ((soldCount / totalListings) * 100).toFixed(2) : 0,
    };
  }

  // Send admin message to all users or specific group
  async broadcastMessage(
    adminId: string,
    title: string,
    message: string,
    targetRole?: 'BUYER' | 'SELLER' | 'ALL'
  ) {
    const where = targetRole && targetRole !== 'ALL' ? { role: targetRole } : {};

    const users = await User.findAll({
      where,
      attributes: ['id'],
    });

    const notifications = users.map((u) => ({
      userId: u.id,
      type: NotificationType.SYSTEM,
      title,
      message,
    }));

    await Notification.bulkCreate(notifications);

    // Record admin action
    await AdminAction.create({
      adminId,
      action: 'BROADCAST_MESSAGE',
      targetType: 'NOTIFICATION',
      targetId: 'broadcast',
      metadata: JSON.stringify({ title, targetRole, recipientCount: users.length }),
    });

    return { success: true, recipientCount: users.length };
  }

  // ==================== OFFER MANAGEMENT ====================

  // Get all offers (admin view)
  async getAllOffers(params: {
    page?: number;
    limit?: number;
    status?: string;
  }) {
    const { page = 1, limit = 20, status } = params;
    const offset = (page - 1) * limit;

    const where: any = {};

    if (status) {
      where.status = status;
    }

    const { count: total, rows: offers } = await Offer.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      offset,
      limit,
      include: [
        {
          model: Listing,
          as: 'listing',
          attributes: ['id', 'mcNumber', 'title', 'askingPrice', 'listingPrice', 'legalName', 'status'],
        },
        {
          model: User,
          as: 'buyer',
          attributes: ['id', 'name', 'email', 'phone', 'verified', 'trustScore'],
        },
        {
          model: User,
          as: 'seller',
          attributes: ['id', 'name', 'email', 'phone', 'verified'],
        },
      ],
    });

    return {
      offers,
      pagination: getPaginationInfo(page, limit, total),
    };
  }

  // Approve offer (admin) - Creates transaction for Buy Now offers
  async approveOffer(offerId: string, adminId: string, notes?: string) {
    const offer = await Offer.findByPk(offerId, {
      include: [
        {
          model: Listing,
          as: 'listing',
        },
        {
          model: User,
          as: 'buyer',
          attributes: ['id', 'name', 'email'],
        },
      ],
    });

    if (!offer) {
      throw new NotFoundError('Offer');
    }

    const listing = (offer as any).listing;

    // For Buy Now offers, create a transaction (the "round table" begins!)
    if (offer.isBuyNow) {
      // Calculate amounts - use listing price for Buy Now
      const agreedPrice = Number(offer.amount);
      const depositAmount = calculateDeposit(agreedPrice);
      const platformFee = calculatePlatformFee(agreedPrice);

      const t = await sequelize.transaction();

      try {
        // Update offer status to ACCEPTED (same as seller accepting)
        await offer.update(
          {
            status: OfferStatus.ACCEPTED,
            adminReviewedBy: adminId,
            adminReviewedAt: new Date(),
            adminNotes: notes,
            respondedAt: new Date(),
          },
          { transaction: t }
        );

        // Create the transaction - this starts the round table!
        const sellerPayout = Number(offer.sellerAmount || listing?.askingPrice || agreedPrice);
        const transaction = await Transaction.create(
          {
            offerId,
            listingId: offer.listingId,
            buyerId: offer.buyerId,
            sellerId: offer.sellerId,
            agreedPrice,
            sellerPayout,
            depositAmount,
            platformFee,
            status: TransactionStatus.AWAITING_DEPOSIT,
          },
          { transaction: t }
        );

        // Update listing status to RESERVED
        await Listing.update(
          { status: ListingStatus.RESERVED },
          { where: { id: offer.listingId }, transaction: t }
        );

        // Reject other pending offers on this listing
        await Offer.update(
          { status: OfferStatus.REJECTED, respondedAt: new Date() },
          {
            where: {
              listingId: offer.listingId,
              id: { [Op.ne]: offerId },
              status: { [Op.in]: [OfferStatus.PENDING_ADMIN, OfferStatus.FORWARDED, OfferStatus.PENDING, OfferStatus.COUNTERED] },
            },
            transaction: t,
          }
        );

        await t.commit();

        // Record admin action
        await AdminAction.create({
          adminId,
          action: 'APPROVE_BUY_NOW',
          targetType: 'OFFER',
          targetId: offerId,
          reason: notes,
          metadata: JSON.stringify({ transactionId: transaction.id }),
        });

        // Create timeline entry
        await TransactionTimeline.create({
          transactionId: transaction.id,
          status: TransactionStatus.AWAITING_DEPOSIT,
          title: 'Buy Now Approved',
          description: 'Admin approved the Buy Now request. Awaiting deposit from buyer.',
          actorId: adminId,
          actorRole: 'ADMIN',
        });

        // Notify buyer - transaction created, go to round table
        await Notification.create({
          userId: offer.buyerId,
          type: NotificationType.OFFER,
          title: 'Buy Now Approved!',
          message: `Your Buy Now request for MC-${listing?.mcNumber || 'N/A'} has been approved. Go to the Round Table to proceed with the transaction.`,
          link: `/transaction/${transaction.id}`,
          metadata: JSON.stringify({ transactionId: transaction.id }),
        });

        // Notify seller - their listing has a buyer
        if (listing?.sellerId) {
          await Notification.create({
            userId: listing.sellerId,
            type: NotificationType.OFFER,
            title: 'Buy Now Approved - Transaction Started',
            message: `A Buy Now request for your listing MC-${listing?.mcNumber || 'N/A'} has been approved. The buyer will pay the deposit soon.`,
            link: `/seller/transactions`,
          });
        }

        return { offer, transaction };
      } catch (error) {
        await t.rollback();
        throw error;
      }
    } else {
      // Regular offer approval (not Buy Now) - also create transaction
      // Calculate amounts - use counter amount if exists, otherwise offer amount
      const agreedPrice = Number(offer.counterAmount || offer.amount);
      const depositAmount = calculateDeposit(agreedPrice);
      const platformFee = calculatePlatformFee(agreedPrice);

      const t = await sequelize.transaction();

      try {
        // Update offer status to ACCEPTED
        await offer.update(
          {
            status: OfferStatus.ACCEPTED,
            adminReviewedBy: adminId,
            adminReviewedAt: new Date(),
            adminNotes: notes,
            respondedAt: new Date(),
          },
          { transaction: t }
        );

        // Create the transaction
        const sellerPayout = Number(offer.sellerAmount || listing?.askingPrice || agreedPrice);
        const transaction = await Transaction.create(
          {
            offerId,
            listingId: offer.listingId,
            buyerId: offer.buyerId,
            sellerId: offer.sellerId,
            agreedPrice,
            sellerPayout,
            depositAmount,
            platformFee,
            status: TransactionStatus.AWAITING_DEPOSIT,
          },
          { transaction: t }
        );

        // Update listing status to RESERVED
        await Listing.update(
          { status: ListingStatus.RESERVED },
          { where: { id: offer.listingId }, transaction: t }
        );

        // Reject other pending offers on this listing
        await Offer.update(
          { status: OfferStatus.REJECTED, respondedAt: new Date() },
          {
            where: {
              listingId: offer.listingId,
              id: { [Op.ne]: offerId },
              status: { [Op.in]: [OfferStatus.PENDING_ADMIN, OfferStatus.FORWARDED, OfferStatus.PENDING, OfferStatus.COUNTERED] },
            },
            transaction: t,
          }
        );

        await t.commit();

        // Record admin action
        await AdminAction.create({
          adminId,
          action: 'APPROVE_OFFER',
          targetType: 'OFFER',
          targetId: offerId,
          reason: notes,
          metadata: JSON.stringify({ transactionId: transaction.id }),
        });

        // Create timeline entry
        await TransactionTimeline.create({
          transactionId: transaction.id,
          status: TransactionStatus.AWAITING_DEPOSIT,
          title: 'Offer Approved',
          description: 'Admin approved the offer. Awaiting deposit from buyer.',
          actorId: adminId,
          actorRole: 'ADMIN',
        });

        // Notify buyer that their offer was approved
        await Notification.create({
          userId: offer.buyerId,
          type: NotificationType.OFFER,
          title: 'Offer Approved!',
          message: `Your offer for MC-${listing?.mcNumber || 'N/A'} has been approved. Go to the Round Table to proceed with the transaction.`,
          link: `/transaction/${transaction.id}`,
          metadata: JSON.stringify({ transactionId: transaction.id }),
        });

        // Also notify the seller
        if (listing?.sellerId) {
          await Notification.create({
            userId: listing.sellerId,
            type: NotificationType.OFFER,
            title: 'Offer Approved by Admin',
            message: `An offer for your listing MC-${listing?.mcNumber || 'N/A'} has been approved. The buyer will pay the deposit soon.`,
            link: `/seller/transactions`,
          });
        }

        return { offer, transaction };
      } catch (error) {
        await t.rollback();
        throw error;
      }
    }
  }

  // Forward offer to seller (admin) — sets sellerAmount and notifies seller
  async forwardOfferToSeller(offerId: string, adminId: string, sellerAmount: number, notes?: string, messageToSeller?: string) {
    const offer = await Offer.findByPk(offerId, {
      include: [
        {
          model: Listing,
          as: 'listing',
        },
        {
          model: User,
          as: 'buyer',
          attributes: ['id', 'name', 'email'],
        },
        {
          model: User,
          as: 'seller',
          attributes: ['id', 'name', 'email'],
        },
      ],
    });

    if (!offer) {
      throw new NotFoundError('Offer');
    }

    if (offer.status !== OfferStatus.PENDING_ADMIN) {
      throw new ForbiddenError('Only offers pending admin review can be forwarded');
    }

    const listing = (offer as any).listing;

    // Update offer — set sellerAmount and change status to FORWARDED
    await offer.update({
      sellerAmount,
      status: OfferStatus.FORWARDED,
      adminReviewedBy: adminId,
      adminReviewedAt: new Date(),
      adminNotes: notes,
      adminMessageToSeller: messageToSeller,
    });

    // Record admin action
    await AdminAction.create({
      adminId,
      action: 'FORWARD_OFFER',
      targetType: 'OFFER',
      targetId: offerId,
      reason: notes,
      metadata: JSON.stringify({
        buyerAmount: Number(offer.amount),
        sellerAmount,
        margin: Number(offer.amount) - sellerAmount,
      }),
    });

    // Notify seller — show sellerAmount, NOT buyer's amount
    const notificationMessage = messageToSeller
      ? `You received a $${sellerAmount.toLocaleString()} offer on MC-${listing?.mcNumber || 'N/A'}. Message: ${messageToSeller}`
      : `You received a $${sellerAmount.toLocaleString()} offer on MC-${listing?.mcNumber || 'N/A'}`;
    await Notification.create({
      userId: offer.sellerId,
      type: NotificationType.OFFER,
      title: 'New Offer Received',
      message: notificationMessage,
      link: `/seller/offers`,
      metadata: JSON.stringify({ offerId: offer.id, listingId: listing?.id }),
    });

    // Send email to seller (best effort — don't fail the operation if SMTP fails)
    const seller = (offer as any).seller;
    const buyer = (offer as any).buyer;
    if (seller?.email) {
      try {
        await emailService.sendOfferNotification(seller.email, {
          sellerName: seller.name || 'Seller',
          buyerName: buyer?.name || 'Buyer',
          mcNumber: listing?.mcNumber || 'N/A',
          listingTitle: listing?.title || '',
          offerAmount: sellerAmount,
          message: messageToSeller,
          offerUrl: `${config.frontendUrl}/seller/offers`,
        });
      } catch (err) {
        logger.error('Failed to send offer notification email to seller', { offerId, err });
      }
    }

    return offer;
  }

  // Reject offer (admin)
  async rejectOffer(offerId: string, adminId: string, reason?: string) {
    const offer = await Offer.findByPk(offerId, {
      include: [
        {
          model: Listing,
          as: 'listing',
          attributes: ['id', 'mcNumber', 'title'],
        },
      ],
    });

    if (!offer) {
      throw new NotFoundError('Offer');
    }

    // Update offer status to rejected
    await offer.update({
      status: OfferStatus.REJECTED,
      adminReviewedBy: adminId,
      adminReviewedAt: new Date(),
      adminNotes: reason,
    });

    // Record admin action
    await AdminAction.create({
      adminId,
      action: 'REJECT_OFFER',
      targetType: 'OFFER',
      targetId: offerId,
      reason,
    });

    // Notify buyer that their offer was rejected
    await Notification.create({
      userId: offer.buyerId,
      type: NotificationType.OFFER,
      title: 'Offer Rejected',
      message: `Your ${offer.isBuyNow ? 'buy now request' : 'offer'} for MC-${(offer as any).listing?.mcNumber || 'N/A'} was not approved.${reason ? ` Reason: ${reason}` : ''}`,
      link: `/buyer/offers`,
    });

    return offer;
  }

  // Accept offer on behalf of seller (admin override when seller hasn't logged in)
  // Mirrors offerService.acceptOffer but bypasses sellerId ownership check and logs AdminAction.
  async acceptOfferOnBehalfOfSeller(offerId: string, adminId: string, notes?: string) {
    const offer = await Offer.findByPk(offerId, {
      include: [
        { model: Listing, as: 'listing' },
        { model: User, as: 'buyer', attributes: ['id', 'name', 'email'] },
        { model: User, as: 'seller', attributes: ['id', 'name', 'email'] },
      ],
    });

    if (!offer) {
      throw new NotFoundError('Offer');
    }

    if (
      offer.status !== OfferStatus.FORWARDED &&
      offer.status !== OfferStatus.PENDING &&
      offer.status !== OfferStatus.COUNTERED
    ) {
      throw new ForbiddenError('Only offers awaiting seller response can be accepted on their behalf');
    }

    const listing = (offer as any).listing;
    const buyer = (offer as any).buyer;
    const seller = (offer as any).seller;

    // Calculate amounts — buyer pays counter or original; seller gets sellerAmount if set
    const buyerPrice = Number(offer.counterAmount || offer.amount);
    const sellerPrice = Number(offer.sellerAmount || buyerPrice);
    const depositAmount = calculateDeposit(buyerPrice);
    const platformFee = calculatePlatformFee(buyerPrice);

    const t = await sequelize.transaction();

    try {
      await offer.update(
        {
          status: OfferStatus.ACCEPTED,
          adminReviewedBy: adminId,
          adminReviewedAt: new Date(),
          adminNotes: notes,
          respondedAt: new Date(),
        },
        { transaction: t }
      );

      const transaction = await Transaction.create(
        {
          offerId,
          listingId: offer.listingId,
          buyerId: offer.buyerId,
          sellerId: offer.sellerId,
          agreedPrice: buyerPrice,
          sellerPayout: sellerPrice,
          depositAmount,
          platformFee,
          status: TransactionStatus.AWAITING_DEPOSIT,
        },
        { transaction: t }
      );

      await Listing.update(
        { status: ListingStatus.RESERVED },
        { where: { id: offer.listingId }, transaction: t }
      );

      // Auto-reject sibling offers
      await Offer.update(
        { status: OfferStatus.REJECTED, respondedAt: new Date() },
        {
          where: {
            listingId: offer.listingId,
            id: { [Op.ne]: offerId },
            status: { [Op.in]: [OfferStatus.PENDING_ADMIN, OfferStatus.FORWARDED, OfferStatus.PENDING, OfferStatus.COUNTERED] },
          },
          transaction: t,
        }
      );

      await t.commit();

      await AdminAction.create({
        adminId,
        action: 'ACCEPT_OFFER_ON_BEHALF',
        targetType: 'OFFER',
        targetId: offerId,
        reason: notes,
        metadata: JSON.stringify({ transactionId: transaction.id, buyerPrice, sellerPrice }),
      });

      await TransactionTimeline.create({
        transactionId: transaction.id,
        status: TransactionStatus.AWAITING_DEPOSIT,
        title: 'Offer Accepted by Admin',
        description: 'Admin accepted the offer on behalf of the seller. Awaiting deposit from buyer.',
        actorId: adminId,
        actorRole: 'ADMIN',
      });

      // Notify buyer (same as seller-driven accept)
      await Notification.create({
        userId: offer.buyerId,
        type: NotificationType.OFFER,
        title: 'Offer Accepted!',
        message: `Your offer on MC-${listing?.mcNumber || 'N/A'} has been accepted. Please proceed with the deposit.`,
        link: `/transaction/${transaction.id}`,
        metadata: JSON.stringify({ transactionId: transaction.id }),
      });

      // Notify seller — admin acted on their behalf
      await Notification.create({
        userId: offer.sellerId,
        type: NotificationType.OFFER,
        title: 'Offer Accepted on Your Behalf',
        message: `An admin accepted the $${sellerPrice.toLocaleString()} offer on MC-${listing?.mcNumber || 'N/A'} on your behalf. The buyer is now paying the deposit.`,
        link: `/seller/transactions`,
        metadata: JSON.stringify({ transactionId: transaction.id, offerId }),
      });

      // Send "offer accepted" emails to both parties (best effort)
      try {
        const mcNumber = listing?.mcNumber || 'N/A';
        const listingTitle = listing?.title || '';
        const buyerName = buyer?.name || 'Buyer';
        const sellerName = seller?.name || 'Seller';

        if (buyer?.email) {
          await emailService.sendOfferAccepted(buyer.email, {
            buyerName,
            sellerName,
            mcNumber,
            listingTitle,
            offerAmount: buyerPrice,
            status: 'accepted',
            actionUrl: `${config.frontendUrl}/transaction/${transaction.id}`,
          });
        }
        if (seller?.email) {
          await emailService.sendOfferAccepted(seller.email, {
            buyerName,
            sellerName,
            mcNumber,
            listingTitle,
            offerAmount: sellerPrice,
            status: 'accepted',
            actionUrl: `${config.frontendUrl}/transaction/${transaction.id}`,
          });
        }
      } catch (err) {
        logger.error('Failed to send offer accepted emails (admin on-behalf)', { offerId, err });
      }

      // Notify admins of new transaction
      adminNotificationService.notifyTransaction({
        transactionId: transaction.id,
        mcNumber: listing?.mcNumber || 'Unknown',
        buyerName: buyer?.name || 'Unknown',
        sellerName: seller?.name || 'Unknown',
        amount: buyerPrice,
        status: 'created',
      }).catch(err => {
        logger.error('Failed to send admin notification for transaction (on-behalf)', err);
      });

      return { offer, transaction };
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }

  // Reject offer on behalf of seller (admin override)
  async rejectOfferOnBehalfOfSeller(offerId: string, adminId: string, reason?: string) {
    const offer = await Offer.findByPk(offerId, {
      include: [{ model: Listing, as: 'listing', attributes: ['id', 'mcNumber', 'title'] }],
    });

    if (!offer) {
      throw new NotFoundError('Offer');
    }

    if (
      offer.status !== OfferStatus.FORWARDED &&
      offer.status !== OfferStatus.PENDING &&
      offer.status !== OfferStatus.COUNTERED
    ) {
      throw new ForbiddenError('Only offers awaiting seller response can be rejected on their behalf');
    }

    await offer.update({
      status: OfferStatus.REJECTED,
      adminReviewedBy: adminId,
      adminReviewedAt: new Date(),
      adminNotes: reason,
      respondedAt: new Date(),
    });

    await AdminAction.create({
      adminId,
      action: 'REJECT_OFFER_ON_BEHALF',
      targetType: 'OFFER',
      targetId: offerId,
      reason,
    });

    // Notify buyer (same wording as seller-driven decline; reason hidden from buyer)
    await Notification.create({
      userId: offer.buyerId,
      type: NotificationType.OFFER,
      title: 'Offer Declined',
      message: `Your offer on MC-${(offer as any).listing?.mcNumber || 'N/A'} has been declined.`,
      link: `/buyer/offers`,
    });

    // Notify seller — admin acted on their behalf
    await Notification.create({
      userId: offer.sellerId,
      type: NotificationType.OFFER,
      title: 'Offer Rejected on Your Behalf',
      message: `An admin rejected the offer on MC-${(offer as any).listing?.mcNumber || 'N/A'} on your behalf.${reason ? ` Reason: ${reason}` : ''}`,
      link: `/seller/offers`,
    });

    return offer;
  }

  // Delete offer (admin)
  async deleteOffer(offerId: string, adminId: string) {
    const offer = await Offer.findByPk(offerId);

    if (!offer) {
      throw new Error('Offer not found');
    }

    const offerData = offer.toJSON();
    await offer.destroy();

    // Log the action
    await AdminAction.create({
      adminId,
      action: 'DELETE_OFFER',
      targetType: 'OFFER',
      targetId: offerId,
      details: `Deleted offer of $${offerData.amount} for listing ${offerData.listingId}`,
    });

    return offerData;
  }

  // ============================================
  // Admin User & Listing Creation
  // ============================================

  // Create a new user (admin)
  async createUser(data: {
    email: string;
    name: string;
    password: string;
    role: string;
    phone?: string;
    companyName?: string;
    createdByAdminId: string;
  }) {
    const bcrypt = require('bcryptjs');

    // Check if user already exists
    const existingUser = await User.findOne({ where: { email: data.email } });
    if (existingUser) {
      throw new Error('User with this email already exists');
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(data.password, 12);

    // Create user
    const user = await User.create({
      email: data.email,
      name: data.name,
      password: hashedPassword,
      role: data.role as UserRole,
      phone: data.phone,
      companyName: data.companyName,
      status: UserStatus.ACTIVE,
      emailVerified: true, // Admin-created users are pre-verified
      verified: data.role === 'SELLER', // Auto-verify sellers created by admin
    });

    // Record admin action
    await AdminAction.create({
      adminId: data.createdByAdminId,
      action: 'CREATE_USER',
      targetType: 'USER',
      targetId: user.id,
      details: {
        email: data.email,
        role: data.role,
      },
    });

    return user;
  }

  // Update user's Stripe account ID (stored in metadata for now)
  async updateUserStripeAccount(userId: string, stripeAccountId: string) {
    const user = await User.findByPk(userId);
    if (!user) {
      throw new NotFoundError('User');
    }

    // Store stripe account ID on user
    await user.update({ stripeAccountId });
    return user;
  }

  // Create a listing (admin)
  async createListing(data: {
    sellerId: string;
    mcNumber: string;
    dotNumber?: string;
    legalName?: string;
    dbaName?: string;
    title: string;
    description?: string;
    askingPrice: number;
    city?: string;
    state?: string;
    address?: string;
    contactEmail?: string;
    contactPhone?: string;
    yearsActive?: number;
    fleetSize?: number;
    totalDrivers?: number;
    safetyRating?: string;
    insuranceOnFile?: boolean;
    bipdCoverage?: number;
    cargoCoverage?: number;
    bondAmount?: number;
    insuranceCompany?: string;
    monthlyInsurancePremium?: number;
    amazonStatus?: string;
    amazonRelayScore?: string;
    highwaySetup?: boolean;
    sellingWithEmail?: boolean;
    sellingWithPhone?: boolean;
    cargoTypes?: string[];
    isPremium?: boolean;
    isVip?: boolean;
    visibility?: string;
    hasFactoring?: string;
    factoringCompany?: string;
    entryAuditCompleted?: string;
    status?: string;
    createdByAdminId: string;
    adminNotes?: string;
    fmcsaData?: string;
    authorityHistory?: string;
    insuranceHistory?: string;
  }) {
    // Verify seller exists
    const seller = await User.findByPk(data.sellerId);
    if (!seller) {
      throw new NotFoundError('Seller');
    }

    // Check if MC number already exists
    const existingListing = await Listing.findOne({
      where: { mcNumber: data.mcNumber },
    });
    if (existingListing) {
      throw new Error('A listing with this MC number already exists');
    }

    // Create listing
    const listing = await Listing.create({
      sellerId: data.sellerId,
      mcNumber: data.mcNumber,
      dotNumber: data.dotNumber || '',
      legalName: data.legalName || '',
      dbaName: data.dbaName || '',
      title: data.title,
      description: data.description || '',
      askingPrice: data.askingPrice,
      city: data.city || 'Unknown',
      state: data.state || '',
      address: data.address || '',
      contactEmail: data.contactEmail || '',
      contactPhone: data.contactPhone || '',
      yearsActive: data.yearsActive || 0,
      fleetSize: data.fleetSize || 0,
      totalDrivers: data.totalDrivers || 0,
      safetyRating: data.safetyRating || 'satisfactory',
      insuranceOnFile: data.insuranceOnFile || false,
      bipdCoverage: data.bipdCoverage || 0,
      cargoCoverage: data.cargoCoverage || 0,
      bondAmount: data.bondAmount || 0,
      insuranceCompany: data.insuranceCompany || '',
      monthlyInsurancePremium: data.monthlyInsurancePremium || 0,
      amazonStatus: data.amazonStatus || 'NONE',
      amazonRelayScore: data.amazonRelayScore || '',
      highwaySetup: data.highwaySetup || false,
      sellingWithEmail: data.sellingWithEmail || false,
      sellingWithPhone: data.sellingWithPhone || false,
      cargoTypes: data.cargoTypes ? JSON.stringify(data.cargoTypes) : '[]',
      isPremium: data.isPremium || false,
      isVip: data.isVip || false,
      visibility: data.visibility || 'public',
      status: (data.status as ListingStatus) || ListingStatus.ACTIVE,
      adminNotes: data.adminNotes || '',
      fmcsaData: data.fmcsaData || null,
      authorityHistory: data.authorityHistory || null,
      insuranceHistory: data.insuranceHistory || null,
    });

    // Record admin action
    await AdminAction.create({
      adminId: data.createdByAdminId,
      action: 'CREATE_LISTING',
      targetType: 'LISTING',
      targetId: listing.id,
      details: {
        mcNumber: data.mcNumber,
        sellerId: data.sellerId,
        status: data.status,
      },
    });

    // Notify seller
    await Notification.create({
      userId: data.sellerId,
      type: NotificationType.SYSTEM,
      title: 'New Listing Created',
      message: `A listing for MC-${data.mcNumber} has been created for your account.`,
      link: `/seller/listings`,
    });

    // Fan out match emails if this admin-created listing is already ACTIVE.
    if (listing.status === ListingStatus.ACTIVE) {
      notifyMatchingBuyers(listing.id).catch((err) => {
        console.error('notifyMatchingBuyers failed for listing', listing.id, err);
      });
    }

    return listing;
  }

  // ============================================
  // Account Dispute Management
  // ============================================

  // Block user for cardholder name mismatch and create dispute record
  async blockUserForMismatch(data: {
    userId: string;
    stripeTransactionId: string;
    cardholderName: string;
    userName: string;
    adminId?: string;
  }) {
    const user = await User.findByPk(data.userId);
    if (!user) {
      throw new NotFoundError('User');
    }

    // Check if there's already a pending dispute for this user
    const existingDispute = await AccountDispute.findOne({
      where: {
        userId: data.userId,
        status: { [Op.in]: [AccountDisputeStatus.PENDING, AccountDisputeStatus.SUBMITTED] },
      },
    });

    if (existingDispute) {
      // Already has a pending dispute, don't create another
      return { user, dispute: existingDispute, alreadyExists: true };
    }

    // Block the user
    await user.update({ status: UserStatus.BLOCKED });

    // Invalidate all refresh tokens
    await RefreshToken.destroy({ where: { userId: data.userId } });

    // Create dispute record
    const dispute = await AccountDispute.create({
      userId: data.userId,
      stripeTransactionId: data.stripeTransactionId,
      cardholderName: data.cardholderName,
      userName: data.userName,
      status: AccountDisputeStatus.PENDING,
    });

    // Record admin action if admin triggered it
    if (data.adminId) {
      await AdminAction.create({
        adminId: data.adminId,
        action: 'BLOCK_USER_MISMATCH',
        targetType: 'USER',
        targetId: data.userId,
        reason: `Cardholder name mismatch: "${data.cardholderName}" vs "${data.userName}"`,
        metadata: JSON.stringify({ disputeId: dispute.id, stripeTransactionId: data.stripeTransactionId }),
      });
    }

    // Send email notification with dispute link
    const frontendUrl = config.frontendUrl || 'http://localhost:5173';
    const disputeUrl = `${frontendUrl}/dispute/${dispute.id}`;

    await emailService.sendAccountBlockedEmail(user.email, {
      userName: user.name,
      cardholderName: data.cardholderName,
      accountName: data.userName,
      disputeUrl,
    });

    // Also create in-app notification
    await Notification.create({
      userId: data.userId,
      type: NotificationType.SYSTEM,
      title: 'Account Blocked',
      message: 'Your account has been blocked due to a payment verification issue. Please check your email for instructions.',
      link: `/dispute/${dispute.id}`,
    });

    // Notify admins of the block (async, don't wait)
    adminNotificationService.notifyDispute({
      userName: data.userName,
      userEmail: user.email,
      cardholderName: data.cardholderName,
      accountName: data.userName,
      disputeType: 'blocked',
    }).catch(err => {
      logger.error('Failed to send admin notification for user block', err);
    });

    return { user, dispute, alreadyExists: false };
  }

  // Get dispute by ID (public - no auth required)
  async getDispute(disputeId: string) {
    const dispute = await AccountDispute.findByPk(disputeId, {
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['id', 'name', 'email'],
        },
      ],
    });

    if (!dispute) {
      throw new NotFoundError('Dispute');
    }

    return dispute;
  }

  // Submit dispute form (public - user fills in their info)
  async submitDispute(disputeId: string, data: {
    disputeEmail: string;
    disputeInfo: string;
    disputeReason: string;
  }) {
    const dispute = await AccountDispute.findByPk(disputeId);

    if (!dispute) {
      throw new NotFoundError('Dispute');
    }

    if (dispute.status !== AccountDisputeStatus.PENDING) {
      throw new BadRequestError('Dispute has already been submitted or resolved');
    }

    // Calculate auto-unblock time (24 hours from now)
    const autoUnblockAt = new Date();
    autoUnblockAt.setHours(autoUnblockAt.getHours() + 24);

    await dispute.update({
      disputeEmail: data.disputeEmail,
      disputeInfo: data.disputeInfo,
      disputeReason: data.disputeReason,
      submittedAt: new Date(),
      autoUnblockAt,
      status: AccountDisputeStatus.SUBMITTED,
    });

    // Notify admins of the dispute submission (async, don't wait)
    adminNotificationService.notifyDispute({
      userName: dispute.userName,
      userEmail: data.disputeEmail,
      cardholderName: dispute.cardholderName,
      accountName: dispute.userName,
      disputeType: 'submitted',
      disputeReason: data.disputeReason,
    }).catch(err => {
      logger.error('Failed to send admin notification for dispute submission', err);
    });

    return dispute;
  }

  // Get all disputes (admin)
  async getAllDisputes(params: {
    page?: number;
    limit?: number;
    status?: string;
  }) {
    const { page = 1, limit = 20, status } = params;
    const offset = (page - 1) * limit;

    const where: any = {};
    if (status) {
      where.status = status;
    }

    const { count: total, rows: disputes } = await AccountDispute.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      offset,
      limit,
      include: [
        {
          model: User,
          as: 'user',
          attributes: ['id', 'name', 'email', 'status'],
        },
        {
          model: User,
          as: 'resolver',
          attributes: ['id', 'name', 'email'],
        },
      ],
    });

    return {
      disputes,
      pagination: getPaginationInfo(page, limit, total),
    };
  }

  // Resolve dispute (admin) - unblocks user
  async resolveDispute(disputeId: string, adminId: string, notes?: string) {
    const dispute = await AccountDispute.findByPk(disputeId, {
      include: [{ model: User, as: 'user' }],
    });

    if (!dispute) {
      throw new NotFoundError('Dispute');
    }

    if (dispute.status === AccountDisputeStatus.RESOLVED) {
      throw new BadRequestError('Dispute is already resolved');
    }

    const user = (dispute as any).user;
    if (!user) {
      throw new NotFoundError('User associated with dispute');
    }

    // Unblock the user
    await user.update({ status: UserStatus.ACTIVE });

    // Update dispute
    await dispute.update({
      status: AccountDisputeStatus.RESOLVED,
      resolvedAt: new Date(),
      resolvedBy: adminId,
      adminNotes: notes,
    });

    // Record admin action
    await AdminAction.create({
      adminId,
      action: 'RESOLVE_DISPUTE',
      targetType: 'DISPUTE',
      targetId: disputeId,
      reason: notes || 'Dispute resolved - user unblocked',
      metadata: JSON.stringify({ userId: user.id }),
    });

    // Notify user
    await Notification.create({
      userId: user.id,
      type: NotificationType.SYSTEM,
      title: 'Account Restored',
      message: 'Your account has been restored. Thank you for verifying your information.',
      link: '/dashboard',
    });

    return { dispute, user };
  }

  // Reject dispute (admin)
  async rejectDispute(disputeId: string, adminId: string, reason?: string) {
    const dispute = await AccountDispute.findByPk(disputeId, {
      include: [{ model: User, as: 'user' }],
    });

    if (!dispute) {
      throw new NotFoundError('Dispute');
    }

    // Update dispute
    await dispute.update({
      status: AccountDisputeStatus.REJECTED,
      resolvedAt: new Date(),
      resolvedBy: adminId,
      adminNotes: reason || 'Dispute rejected',
    });

    // Record admin action
    await AdminAction.create({
      adminId,
      action: 'REJECT_DISPUTE',
      targetType: 'DISPUTE',
      targetId: disputeId,
      reason: reason || 'Dispute rejected - account remains blocked',
    });

    return dispute;
  }

  // Process auto-unblock for submitted disputes (called by cron job or admin)
  async processAutoUnblock() {
    const now = new Date();

    // Find all submitted disputes where autoUnblockAt has passed
    const disputes = await AccountDispute.findAll({
      where: {
        status: AccountDisputeStatus.SUBMITTED,
        autoUnblockAt: { [Op.lte]: now },
      },
      include: [{ model: User, as: 'user' }],
    });

    const results: Array<{ disputeId: string; userId: string; success: boolean; error?: string }> = [];

    for (const dispute of disputes) {
      try {
        const user = (dispute as any).user;
        if (user) {
          // Unblock the user
          await user.update({ status: UserStatus.ACTIVE });

          // Update dispute
          await dispute.update({
            status: AccountDisputeStatus.RESOLVED,
            resolvedAt: now,
            adminNotes: 'Auto-resolved after 24 hours',
          });

          // Notify user
          await Notification.create({
            userId: user.id,
            type: NotificationType.SYSTEM,
            title: 'Account Restored',
            message: 'Your account has been automatically restored after review. Thank you for your patience.',
            link: '/dashboard',
          });

          results.push({ disputeId: dispute.id, userId: user.id, success: true });
        }
      } catch (error: any) {
        results.push({ disputeId: dispute.id, userId: dispute.userId, success: false, error: error.message });
      }
    }

    return results;
  }

  // Get user activity log (unlocked MCs with view counts and credit transactions)
  async getUserActivityLog(userId: string) {
    const user = await User.findByPk(userId);
    if (!user) {
      throw new NotFoundError('User');
    }

    // Get all unlocked listings for this user with listing details
    const unlockedListings = await UnlockedListing.findAll({
      where: { userId },
      order: [['createdAt', 'DESC']],
      include: [
        {
          model: Listing,
          as: 'listing',
          attributes: ['id', 'mcNumber', 'title', 'legalName', 'city', 'state', 'askingPrice', 'status', 'views'],
        },
      ],
    });

    // Get view counts for each unlocked MC from ListingView model if it exists,
    // otherwise use the views from the listing
    const unlockedMCs = await Promise.all(
      unlockedListings.map(async (unlock) => {
        const listing = (unlock as any).listing;

        // Try to get user-specific view count from listing_views table
        let viewCount = 0;
        try {
          const viewQuery = `
            SELECT COUNT(*) as viewCount
            FROM listing_views
            WHERE userId = :userId AND listingId = :listingId
          `;
          const [result] = await sequelize.query<{ viewCount: string }>(viewQuery, {
            replacements: { userId, listingId: unlock.listingId },
            type: QueryTypes.SELECT,
          });
          viewCount = parseInt(result?.viewCount || '0', 10);
        } catch {
          // If listing_views table doesn't exist, default to 0
          viewCount = 0;
        }

        return {
          id: unlock.id,
          listingId: unlock.listingId,
          mcNumber: listing?.mcNumber || 'N/A',
          title: listing?.title || 'Unknown',
          legalName: listing?.legalName || '',
          location: listing ? `${listing.city || ''}, ${listing.state || ''}`.trim().replace(/^,\s*|,\s*$/g, '') : '',
          askingPrice: listing?.askingPrice || 0,
          status: listing?.status || 'UNKNOWN',
          creditsUsed: unlock.creditsUsed,
          unlockedAt: unlock.createdAt,
          viewCount,
        };
      })
    );

    // Get all credit transactions for this user
    const creditTransactions = await CreditTransaction.findAll({
      where: { userId },
      order: [['createdAt', 'DESC']],
    });

    // Batch query: get all referenced listings in one query instead of N+1
    const listingRefs = creditTransactions
      .map(tx => tx.reference)
      .filter((ref): ref is string => !!ref);

    const referencedListings = listingRefs.length > 0 ? await Listing.findAll({
      where: { id: { [Op.in]: listingRefs } },
      attributes: ['id', 'mcNumber', 'title'],
      raw: true,
    }) : [];

    const listingMap = new Map<string, { mcNumber: string; title: string }>();
    for (const listing of referencedListings) {
      listingMap.set(listing.id, { mcNumber: listing.mcNumber, title: listing.title });
    }

    const formattedTransactions = creditTransactions.map((tx) => {
      const listing = tx.reference ? listingMap.get(tx.reference) : null;
      return {
        id: tx.id,
        type: tx.type,
        amount: tx.amount,
        balance: tx.balance,
        description: tx.description || '',
        mcNumber: listing?.mcNumber || null,
        listingTitle: listing?.title || null,
        createdAt: tx.createdAt,
      };
    });

    return {
      userId: user.id,
      userName: user.name,
      userEmail: user.email,
      totalCredits: user.totalCredits || 0,
      usedCredits: user.usedCredits || 0,
      availableCredits: (user.totalCredits || 0) - (user.usedCredits || 0),
      unlockedMCs,
      creditTransactions: formattedTransactions,
    };
  }

  // Get comprehensive activity log with filters
  // OPTIMIZED: Uses batch queries instead of N+1, limits data fetched
  async getActivityLog(filters: {
    type?: string; // 'all' | 'unlocks' | 'credits' | 'admin_actions'
    userId?: string;
    mcNumber?: string;
    actionType?: string;
    dateFrom?: string;
    dateTo?: string;
    page?: number;
    limit?: number;
  }) {
    const {
      type = 'all',
      userId,
      mcNumber,
      actionType,
      dateFrom,
      dateTo,
      page = 1,
      limit = 50,
    } = filters;

    const offset = (page - 1) * limit;
    const results: any[] = [];

    // Cap the max records to fetch from each table to prevent memory issues
    const maxRecordsPerType = 500;

    // Build date filter
    const dateFilter: any = {};
    if (dateFrom) {
      dateFilter[Op.gte] = new Date(dateFrom);
    }
    if (dateTo) {
      dateFilter[Op.lte] = new Date(dateTo + 'T23:59:59.999Z');
    }

    // Get unlocked listings - already optimized with includes
    if (type === 'all' || type === 'unlocks') {
      const unlockWhere: any = {};
      if (userId) unlockWhere.userId = userId;
      if (dateFrom || dateTo) unlockWhere.createdAt = dateFilter;

      const unlockInclude: any[] = [
        {
          model: Listing,
          as: 'listing',
          attributes: ['id', 'mcNumber', 'title', 'legalName', 'city', 'state'],
          ...(mcNumber ? { where: { mcNumber: { [Op.like]: `%${mcNumber}%` } } } : {}),
        },
        {
          model: User,
          as: 'user',
          attributes: ['id', 'name', 'email'],
        },
      ];

      const unlocks = await UnlockedListing.findAll({
        where: unlockWhere,
        include: unlockInclude,
        order: [['createdAt', 'DESC']],
        limit: maxRecordsPerType,
      });

      for (const unlock of unlocks) {
        const listing = (unlock as any).listing;
        const user = (unlock as any).user;
        if (mcNumber && !listing) continue;

        results.push({
          id: unlock.id,
          activityType: 'UNLOCK',
          timestamp: unlock.createdAt,
          userId: unlock.userId,
          userName: user?.name || 'Unknown',
          userEmail: user?.email || '',
          listingId: unlock.listingId,
          mcNumber: listing?.mcNumber || 'N/A',
          listingTitle: listing?.title || 'Unknown',
          location: listing ? `${listing.city || ''}, ${listing.state || ''}`.trim().replace(/^,\s*|,\s*$/g, '') : '',
          creditsUsed: unlock.creditsUsed,
          description: `Unlocked MC #${listing?.mcNumber || 'N/A'}`,
        });
      }
    }

    // Get credit transactions - OPTIMIZED: batch fetch listings
    if (type === 'all' || type === 'credits') {
      const creditWhere: any = {};
      if (userId) creditWhere.userId = userId;
      if (dateFrom || dateTo) creditWhere.createdAt = dateFilter;
      if (actionType && ['PURCHASE', 'USAGE', 'REFUND', 'BONUS', 'EXPIRED', 'SUBSCRIPTION'].includes(actionType)) {
        creditWhere.type = actionType;
      }

      const credits = await CreditTransaction.findAll({
        where: creditWhere,
        include: [
          {
            model: User,
            as: 'user',
            attributes: ['id', 'name', 'email'],
          },
        ],
        order: [['createdAt', 'DESC']],
        limit: maxRecordsPerType,
      });

      // Batch fetch all referenced listings at once instead of N+1 queries
      const listingIds = credits
        .filter(c => c.reference)
        .map(c => c.reference as string);

      const listingsMap = new Map<string, { mcNumber: string; title: string }>();
      if (listingIds.length > 0) {
        const listings = await Listing.findAll({
          where: { id: { [Op.in]: listingIds } },
          attributes: ['id', 'mcNumber', 'title'],
        });
        listings.forEach(l => listingsMap.set(l.id, { mcNumber: l.mcNumber, title: l.title }));
      }

      for (const credit of credits) {
        const user = (credit as any).user;
        const listingData = credit.reference ? listingsMap.get(credit.reference) : null;
        const mcNumberFromRef = listingData?.mcNumber || null;
        const listingTitle = listingData?.title || null;

        // Skip if filtering by MC number and this transaction doesn't match
        if (mcNumber && mcNumberFromRef && !mcNumberFromRef.includes(mcNumber)) continue;
        if (mcNumber && !mcNumberFromRef) continue;

        results.push({
          id: credit.id,
          activityType: 'CREDIT',
          creditType: credit.type,
          timestamp: credit.createdAt,
          userId: credit.userId,
          userName: user?.name || 'Unknown',
          userEmail: user?.email || '',
          mcNumber: mcNumberFromRef,
          listingTitle,
          amount: credit.amount,
          balance: credit.balance,
          description: credit.description || `Credit ${credit.type.toLowerCase()}`,
        });
      }
    }

    // Get admin actions - OPTIMIZED: batch fetch users and listings
    if (type === 'all' || type === 'admin_actions') {
      const actionWhere: any = {};
      if (dateFrom || dateTo) actionWhere.createdAt = dateFilter;
      if (actionType && !['PURCHASE', 'USAGE', 'REFUND', 'BONUS', 'EXPIRED', 'SUBSCRIPTION'].includes(actionType)) {
        actionWhere.action = actionType;
      }

      const actions = await AdminAction.findAll({
        where: actionWhere,
        include: [
          {
            model: User,
            as: 'admin',
            attributes: ['id', 'name', 'email'],
          },
        ],
        order: [['createdAt', 'DESC']],
        limit: maxRecordsPerType,
      });

      // Batch fetch target users and listings
      const targetUserIds = actions
        .filter(a => a.targetType === 'USER')
        .map(a => a.targetId);
      const targetListingIds = actions
        .filter(a => a.targetType === 'LISTING')
        .map(a => a.targetId);

      const usersMap = new Map<string, { name: string; email: string }>();
      const listingsMap = new Map<string, string>();

      if (targetUserIds.length > 0) {
        const users = await User.findAll({
          where: { id: { [Op.in]: targetUserIds } },
          attributes: ['id', 'name', 'email'],
        });
        users.forEach(u => usersMap.set(u.id, { name: u.name, email: u.email }));
      }

      if (targetListingIds.length > 0) {
        const listings = await Listing.findAll({
          where: { id: { [Op.in]: targetListingIds } },
          attributes: ['id', 'mcNumber'],
        });
        listings.forEach(l => listingsMap.set(l.id, l.mcNumber));
      }

      for (const action of actions) {
        const admin = (action as any).admin;
        const targetUserData = action.targetType === 'USER' ? usersMap.get(action.targetId) : null;
        const mcNumberFromAction = action.targetType === 'LISTING' ? listingsMap.get(action.targetId) || null : null;

        // Skip if filtering by MC number and this action doesn't match
        if (mcNumber && mcNumberFromAction && !mcNumberFromAction.includes(mcNumber)) continue;
        if (mcNumber && !mcNumberFromAction && action.targetType === 'LISTING') continue;

        // Skip if filtering by userId and this action doesn't involve that user
        if (userId && action.targetType === 'USER' && action.targetId !== userId) continue;

        results.push({
          id: action.id,
          activityType: 'ADMIN_ACTION',
          actionType: action.action,
          targetType: action.targetType,
          targetId: action.targetId,
          timestamp: action.createdAt,
          adminId: action.adminId,
          adminName: admin?.name || 'Unknown',
          adminEmail: admin?.email || '',
          targetUserName: targetUserData?.name || null,
          targetUserEmail: targetUserData?.email || null,
          mcNumber: mcNumberFromAction,
          reason: action.reason,
          description: `${action.action.replace(/_/g, ' ')} - ${action.targetType}`,
          metadata: action.metadata ? JSON.parse(action.metadata) : null,
        });
      }
    }

    // Sort all results by timestamp descending
    results.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Apply pagination
    const total = results.length;
    const paginatedResults = results.slice(offset, offset + limit);

    // Get summary stats
    const stats = {
      totalUnlocks: results.filter(r => r.activityType === 'UNLOCK').length,
      totalCredits: results.filter(r => r.activityType === 'CREDIT').length,
      totalAdminActions: results.filter(r => r.activityType === 'ADMIN_ACTION').length,
    };

    return {
      activities: paginatedResults,
      stats,
      pagination: getPaginationInfo(page, limit, total),
    };
  }
  // Cancel a user's subscription (admin action)
  async cancelUserSubscription(userId: string, adminId: string) {
    const subscription = await Subscription.findOne({
      where: { userId },
    });

    if (!subscription) {
      throw new NotFoundError('No subscription found for this user');
    }

    if (subscription.status !== 'ACTIVE') {
      throw new BadRequestError('Subscription is not active');
    }

    // Cancel in Stripe immediately (admin cancellation = immediate, not at period end)
    let stripeCancelled = false;
    if (subscription.stripeSubId) {
      stripeCancelled = await stripeService.cancelSubscription(subscription.stripeSubId, true);
      if (!stripeCancelled) {
        // Stripe cancel failed (sub may already be cancelled or not exist in Stripe)
        // Log warning but proceed — admin explicitly wants this cancelled in our DB
        logger.warn('Stripe cancel failed or subscription not found in Stripe, proceeding with DB update', {
          userId,
          stripeSubId: subscription.stripeSubId,
        });
      }
    } else {
      logger.warn('No stripeSubId on subscription record, skipping Stripe cancellation', {
        userId,
        subscriptionId: subscription.id,
      });
    }

    // Update subscription status in DB
    await subscription.update({
      status: 'CANCELLED',
      cancelledAt: new Date(),
    });

    // Record admin action
    await AdminAction.create({
      adminId,
      action: 'CANCEL_SUBSCRIPTION',
      targetType: 'USER',
      targetId: userId,
      reason: 'Subscription cancelled by admin',
    });

    return {
      message: stripeCancelled
        ? 'Subscription cancelled immediately in Stripe and database'
        : 'Subscription marked as cancelled in database (Stripe cancellation failed — subscription may not exist in Stripe or was already cancelled)',
      stripeCancelled,
      subscription,
    };
  }

  async deleteUser(userId: string, adminId: string) {
    const user = await User.findByPk(userId);
    if (!user) {
      throw new NotFoundError('User');
    }

    if (user.role === UserRole.ADMIN) {
      throw new ForbiddenError('Admin accounts cannot be deleted from the users panel');
    }

    if (userId === adminId) {
      throw new ForbiddenError('You cannot delete your own account');
    }

    // Cancel any active subscription first (keeps Stripe + DB in sync per CLAUDE.md)
    const subscription = await Subscription.findOne({ where: { userId } });
    if (subscription && subscription.status === SubscriptionStatus.ACTIVE) {
      try {
        await this.cancelUserSubscription(userId, adminId);
      } catch (err) {
        logger.warn('Failed to cancel subscription during user delete; proceeding with anonymization', {
          userId,
          error: (err as Error).message,
        });
      }
    }

    // Anonymize PII so business records (offers, transactions, listings) stay intact
    const anonEmail = `deleted-${user.id.slice(0, 8)}-${Date.now()}@deleted.local`;
    await user.update({
      email: anonEmail,
      name: 'Deleted User',
      phone: null,
      avatar: null,
      companyName: null,
      companyAddress: null,
      city: null,
      state: null,
      zipCode: null,
      ein: null,
      mcNumber: null,
      dotNumber: null,
      status: UserStatus.SUSPENDED,
      verified: false,
      sellerVerified: false,
      emailVerified: false,
      identityVerified: false,
    } as any);

    await RefreshToken.destroy({ where: { userId } });
    await PasswordResetToken.destroy({ where: { userId } });

    await AdminAction.create({
      adminId,
      action: 'DELETE_USER',
      targetType: 'USER',
      targetId: userId,
      reason: 'User deleted by admin (soft-delete: PII anonymized, business records retained)',
    });

    logger.info('User deleted (soft) by admin', { userId, adminId });

    return { message: 'User deleted. PII anonymized and account suspended; historical records retained.' };
  }

  async resetUserPassword(userId: string, newPassword: string, adminId: string) {
    const user = await User.findByPk(userId);
    if (!user) {
      throw new NotFoundError('User');
    }

    if (typeof newPassword !== 'string' || newPassword.length < config.security.passwordMinLength) {
      throw new BadRequestError(`Password must be at least ${config.security.passwordMinLength} characters`);
    }

    const bcrypt = require('bcryptjs');
    const hashedPassword = await bcrypt.hash(newPassword, config.security.bcryptRounds);

    await user.update({ password: hashedPassword });

    await RefreshToken.destroy({ where: { userId } });
    await PasswordResetToken.update(
      { usedAt: new Date() },
      { where: { userId, usedAt: null } }
    );

    await AdminAction.create({
      adminId,
      action: 'RESET_USER_PASSWORD',
      targetType: 'USER',
      targetId: userId,
      reason: 'Password reset by admin',
    });

    return { message: 'Password reset successfully. User has been logged out of all devices.' };
  }

  /**
   * Subscription analytics pulled live from Stripe (source of truth for billing).
   * Groups subscriptions by plan + billing interval + status so admins can see
   * which plans are actually popular and compute MRR.
   */
  async getSubscriptionAnalytics() {
    // Build a reverse map: priceId -> { plan, interval }
    // Some plans have onetime + monthly/yearly variants (e.g. VIP legacy subs);
    // register every defined price ID, not just the first kind found.
    const priceIdToPlan = new Map<string, { plan: string; interval: 'monthly' | 'yearly' }>();
    for (const [plan, prices] of Object.entries(SUBSCRIPTION_PRICE_IDS)) {
      const p = prices as { onetime?: string; monthly?: string; yearly?: string };
      if (p.onetime) priceIdToPlan.set(p.onetime, { plan, interval: 'monthly' });
      if (p.monthly) priceIdToPlan.set(p.monthly, { plan, interval: 'monthly' });
      if (p.yearly) priceIdToPlan.set(p.yearly, { plan, interval: 'yearly' });
    }

    const subs = await stripeService.listAllSubscriptions('all');

    type Bucket = {
      plan: string;
      interval: 'monthly' | 'yearly' | 'unknown';
      status: string;
      count: number;
      mrr: number; // in cents, normalized to monthly
    };
    const bucketMap = new Map<string, Bucket>();
    const totals: Record<string, number> = {};
    let mrrTotalCents = 0;
    const unmappedPriceIds = new Map<string, number>();

    for (const sub of subs) {
      totals[sub.status] = (totals[sub.status] || 0) + 1;

      const item = sub.items?.data?.[0];
      const priceId = item?.price?.id;
      if (!priceId) continue;

      const mapped = priceIdToPlan.get(priceId);
      const plan = mapped?.plan || 'unknown';
      const interval = mapped?.interval || 'unknown';

      if (!mapped) {
        unmappedPriceIds.set(priceId, (unmappedPriceIds.get(priceId) || 0) + 1);
      }

      // Normalize amount to monthly cents (yearly -> /12). Multiply by quantity.
      const unitAmount = item?.price?.unit_amount ?? 0;
      const quantity = item?.quantity ?? 1;
      const rawMonthly = interval === 'yearly' ? unitAmount / 12 : unitAmount;
      const itemMrr = Math.round(rawMonthly * quantity);

      const key = `${plan}|${interval}|${sub.status}`;
      const existing = bucketMap.get(key);
      if (existing) {
        existing.count += 1;
        if (sub.status === 'active' || sub.status === 'trialing') existing.mrr += itemMrr;
      } else {
        bucketMap.set(key, {
          plan,
          interval,
          status: sub.status,
          count: 1,
          mrr: sub.status === 'active' || sub.status === 'trialing' ? itemMrr : 0,
        });
      }

      if (sub.status === 'active' || sub.status === 'trialing') {
        mrrTotalCents += itemMrr;
      }
    }

    const byPlan = Array.from(bucketMap.values()).sort((a, b) => {
      if (a.plan !== b.plan) return a.plan.localeCompare(b.plan);
      if (a.interval !== b.interval) return a.interval.localeCompare(b.interval);
      return a.status.localeCompare(b.status);
    });

    // Enrich unmapped price IDs with Stripe product details so admins can
    // identify what each legacy price actually is (name, amount, interval).
    const unmappedEntries = await Promise.all(
      Array.from(unmappedPriceIds.entries()).map(async ([priceId, count]) => {
        const price = await stripeService.retrievePrice(priceId);
        const product = price?.product as Stripe.Product | undefined;
        return {
          priceId,
          count,
          productName: typeof product === 'object' ? product?.name ?? null : null,
          nickname: price?.nickname ?? null,
          unitAmount: price?.unit_amount ?? null,
          currency: price?.currency ?? null,
          interval: price?.recurring?.interval ?? null,
        };
      })
    );

    return {
      byPlan,
      totals,
      totalSubscriptions: subs.length,
      mrrCents: mrrTotalCents,
      mrrDollars: mrrTotalCents / 100,
      unmappedPriceIds: unmappedEntries,
    };
  }

  /** Admin view of a buyer's preferences — includes adminNotes. */
  async getUserPreferences(userId: string) {
    const prefs = await buyerPreferencesService.getByUserId(userId);
    return prefs ? prefs.toJSON() : null;
  }

  async updateUserPreferences(userId: string, data: BuyerPreferencesInput) {
    const prefs = await buyerPreferencesService.upsert(userId, data, 'ADMIN');
    return prefs.toJSON();
  }

  async getUserMatches(userId: string, limit = 10) {
    const prefs = await buyerPreferencesService.getByUserId(userId);
    if (!prefs || !hasAnyCriteria(prefs)) {
      return { hasPreferences: false, matches: [] };
    }
    const listings = await Listing.findAll({
      where: { status: ListingStatus.ACTIVE },
      limit: 500,
    });
    const ranked = rankListings(listings, prefs, limit);
    return {
      hasPreferences: true,
      matches: ranked.map((l) => ({
        listing: l.toJSON(),
        matchScore: l.matchScore,
        matchReasons: l.matchReasons,
      })),
    };
  }

  // List the buyer's transactions that are awaiting deposit — used to populate the manual-deposit MC dropdown
  async getUserListingsForDeposit(userId: string) {
    const user = await User.findByPk(userId);
    if (!user) {
      throw new NotFoundError('User');
    }

    const transactions = await Transaction.findAll({
      where: {
        buyerId: userId,
        status: TransactionStatus.AWAITING_DEPOSIT,
      },
      include: [
        {
          model: Listing,
          as: 'listing',
          attributes: ['id', 'mcNumber', 'dotNumber', 'legalName', 'title', 'askingPrice', 'city', 'state'],
        },
      ],
      order: [['createdAt', 'DESC']],
    });

    return transactions.map((t) => ({
      transactionId: t.id,
      listingId: t.listingId,
      depositAmount: t.depositAmount,
      agreedPrice: t.agreedPrice,
      status: t.status,
      createdAt: t.createdAt,
      mc: t.listing
        ? {
            mcNumber: t.listing.mcNumber,
            dotNumber: t.listing.dotNumber,
            legalName: t.listing.legalName,
            title: t.listing.title,
            askingPrice: t.listing.askingPrice,
            location: `${t.listing.city || ''}${t.listing.city && t.listing.state ? ', ' : ''}${t.listing.state || ''}`,
          }
        : null,
    }));
  }

  // Record a deposit the admin received OUTSIDE the platform (bank transfer, cash, etc.).
  // If transactionId is provided, advances that transaction to DEPOSIT_RECEIVED — mirrors verifyDeposit flow.
  // If no transactionId (MC not yet listed on the platform), saves a standalone Payment tied to the user with freeform notes.
  async recordManualDeposit(
    userId: string,
    adminId: string,
    input: {
      amount: number;
      paymentMethod: PaymentMethod;
      reference?: string;
      transactionId?: string;
      notes?: string;
    }
  ) {
    const { amount, paymentMethod, reference, transactionId, notes } = input;

    const user = await User.findByPk(userId, {
      include: [{ model: Subscription, as: 'subscription' }],
    });
    if (!user) {
      throw new NotFoundError('User');
    }

    const isSubscribed = user.subscription?.status === SubscriptionStatus.ACTIVE;
    if (!isSubscribed) {
      throw new BadRequestError('Manual deposit recording is only available for paid (subscribed) users');
    }

    if (!Number.isFinite(amount) || amount <= 0) {
      throw new BadRequestError('Amount must be a positive number');
    }

    if (!transactionId && !notes?.trim()) {
      throw new BadRequestError('Notes are required when no MC listing is selected');
    }

    // Case 1: linked to an existing transaction — advance it like verifyDeposit does
    if (transactionId) {
      const transaction = await Transaction.findByPk(transactionId, {
        include: [{ model: Listing, as: 'listing' }],
      });

      if (!transaction) {
        throw new NotFoundError('Transaction');
      }

      if (transaction.buyerId !== userId) {
        throw new BadRequestError('Selected transaction does not belong to this user');
      }

      if (transaction.status !== TransactionStatus.AWAITING_DEPOSIT) {
        throw new BadRequestError(`Transaction is in status ${transaction.status}, cannot record deposit`);
      }

      const now = new Date();
      const t = await sequelize.transaction();
      let payment: Payment;
      try {
        payment = await Payment.create(
          {
            transactionId,
            userId,
            type: PaymentType.DEPOSIT,
            amount,
            method: paymentMethod,
            reference: reference || null,
            status: PaymentStatus.COMPLETED,
            description: notes?.trim() || `Off-platform deposit recorded by admin`,
            verifiedBy: adminId,
            verifiedAt: now,
            completedAt: now,
          },
          { transaction: t }
        );

        await transaction.update(
          {
            status: TransactionStatus.DEPOSIT_RECEIVED,
            depositPaidAt: now,
            depositPaymentMethod: paymentMethod,
            depositPaymentRef: reference || null,
            adminId,
          },
          { transaction: t }
        );

        await TransactionTimeline.create(
          {
            transactionId,
            status: TransactionStatus.DEPOSIT_RECEIVED,
            title: 'Deposit Recorded by Admin',
            description: `Admin recorded an off-platform ${paymentMethod} deposit of $${amount}${reference ? ` (ref: ${reference})` : ''}${notes?.trim() ? ` — Notes: ${notes.trim()}` : ''}`,
            actorId: adminId,
            actorRole: UserRole.ADMIN,
          },
          { transaction: t }
        );

        await AdminAction.create(
          {
            adminId,
            action: 'RECORD_MANUAL_DEPOSIT',
            targetType: 'TRANSACTION',
            targetId: transactionId,
            reason: `Recorded $${amount} ${paymentMethod} deposit for user ${user.email}${reference ? ` (ref: ${reference})` : ''}${notes?.trim() ? ` — ${notes.trim()}` : ''}`,
          },
          { transaction: t }
        );

        await t.commit();
      } catch (error) {
        await t.rollback();
        throw error;
      }

      // Notify buyer + seller outside the transaction
      await Notification.create({
        userId: transaction.buyerId,
        type: NotificationType.PAYMENT,
        title: 'Deposit Confirmed',
        message: `Your deposit of $${amount} has been recorded. The transaction is moving forward.`,
      });
      await Notification.create({
        userId: transaction.sellerId,
        type: NotificationType.PAYMENT,
        title: 'Deposit Received',
        message: `The buyer's deposit has been confirmed. The transaction is now in review.`,
      });

      return {
        mode: 'linked' as const,
        paymentId: payment.id,
        transactionId,
        listingId: transaction.listingId,
        amount,
        paymentMethod,
        reference: reference || null,
        notes: notes?.trim() || null,
      };
    }

    // Case 2: no transaction — MC not yet on the platform. Save standalone Payment + admin action.
    const payment = await Payment.create({
      userId,
      type: PaymentType.DEPOSIT,
      amount,
      method: paymentMethod,
      reference: reference || null,
      status: PaymentStatus.COMPLETED,
      description: `Off-platform deposit (MC not on platform). Notes: ${notes!.trim()}`,
      metadata: JSON.stringify({ offPlatform: true, notes: notes!.trim() }),
      verifiedBy: adminId,
      verifiedAt: new Date(),
      completedAt: new Date(),
    });

    await AdminAction.create({
      adminId,
      action: 'RECORD_MANUAL_DEPOSIT',
      targetType: 'USER',
      targetId: userId,
      reason: `Recorded $${amount} ${paymentMethod} off-platform deposit (MC not on platform)${reference ? ` (ref: ${reference})` : ''} — ${notes!.trim()}`,
    });

    await Notification.create({
      userId,
      type: NotificationType.PAYMENT,
      title: 'Deposit Recorded',
      message: `A deposit of $${amount} has been recorded on your account.`,
    });

    return {
      mode: 'standalone' as const,
      paymentId: payment.id,
      transactionId: null,
      listingId: null,
      amount,
      paymentMethod,
      reference: reference || null,
      notes: notes!.trim(),
    };
  }
}

export const adminService = new AdminService();
export default adminService;
