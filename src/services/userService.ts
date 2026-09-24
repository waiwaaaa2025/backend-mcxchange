import { sanitizeListing } from '../utils/listingSanitize';
import { Op, fn, col, QueryTypes } from 'sequelize';
import sequelize from '../config/database';
import {
  User,
  Listing,
  Offer,
  Transaction,
  Review,
  SavedListing,
  UnlockedListing,
  RefreshToken,
  UserRole,
  UserStatus,
} from '../models';
import { NotFoundError, ForbiddenError } from '../middleware/errorHandler';
import { getPaginationInfo } from '../utils/helpers';
import { cacheService, CacheKeys, CacheTTL } from './cacheService';
import logger from '../utils/logger';

interface UpdateProfileData {
  name?: string;
  phone?: string;
  avatar?: string;
  companyName?: string;
  companyAddress?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  ein?: string;
  mcNumber?: string;
  dotNumber?: string;
}

class UserService {
  // Get user profile
  async getProfile(userId: string) {
    const user = await User.findByPk(userId, {
      attributes: [
        'id', 'email', 'name', 'phone', 'avatar', 'role', 'status',
        'verified', 'verifiedAt', 'trustScore', 'memberSince', 'lastLoginAt',
        'companyName', 'companyAddress', 'city', 'state', 'zipCode', 'ein',
        'sellerVerified', 'sellerVerifiedAt', 'totalCredits', 'usedCredits',
        'identityVerified', 'identityVerifiedAt', 'identityVerificationStatus',
      ],
    });

    if (!user) {
      throw new NotFoundError('User');
    }

    // Try to get cached stats first (avoids 6 COUNT queries)
    const cacheKey = `${CacheKeys.USER}${userId}:stats`;
    let stats = await cacheService.get<{
      listingsCount: number;
      sentOffersCount: number;
      receivedOffersCount: number;
      buyerTransactionsCount: number;
      sellerTransactionsCount: number;
      reviewsReceivedCount: number;
    }>(cacheKey);

    if (!stats) {
      // Cache miss - use single aggregation query instead of 6 separate queries
      // NOTE: Table names must be lowercase to match Sequelize-created tables on Linux (case-sensitive)
      const [result] = await sequelize.query<{
        listingsCount: string;
        sentOffersCount: string;
        receivedOffersCount: string;
        buyerTransactionsCount: string;
        sellerTransactionsCount: string;
        reviewsReceivedCount: string;
      }>(`
        SELECT
          (SELECT COUNT(*) FROM listings WHERE sellerId = :userId) as listingsCount,
          (SELECT COUNT(*) FROM offers WHERE buyerId = :userId) as sentOffersCount,
          (SELECT COUNT(*) FROM offers WHERE sellerId = :userId) as receivedOffersCount,
          (SELECT COUNT(*) FROM transactions WHERE buyerId = :userId) as buyerTransactionsCount,
          (SELECT COUNT(*) FROM transactions WHERE sellerId = :userId) as sellerTransactionsCount,
          (SELECT COUNT(*) FROM reviews WHERE toUserId = :userId) as reviewsReceivedCount
      `, {
        replacements: { userId },
        type: QueryTypes.SELECT,
      });

      stats = {
        listingsCount: parseInt(result.listingsCount || '0', 10),
        sentOffersCount: parseInt(result.sentOffersCount || '0', 10),
        receivedOffersCount: parseInt(result.receivedOffersCount || '0', 10),
        buyerTransactionsCount: parseInt(result.buyerTransactionsCount || '0', 10),
        sellerTransactionsCount: parseInt(result.sellerTransactionsCount || '0', 10),
        reviewsReceivedCount: parseInt(result.reviewsReceivedCount || '0', 10),
      };

      // Cache for 10 minutes
      await cacheService.set(cacheKey, stats, CacheTTL.USER);
      logger.debug('Cached user stats', { userId, cacheKey });
    } else {
      logger.debug('Cache hit for user stats', { userId, cacheKey });
    }

    return {
      ...user.toJSON(),
      _count: {
        listings: stats.listingsCount,
        sentOffers: stats.sentOffersCount,
        receivedOffers: stats.receivedOffersCount,
        buyerTransactions: stats.buyerTransactionsCount,
        sellerTransactions: stats.sellerTransactionsCount,
        reviewsReceived: stats.reviewsReceivedCount,
      },
    };
  }

  // Update user profile
  async updateProfile(userId: string, data: UpdateProfileData) {
    const user = await User.findByPk(userId);

    if (!user) {
      throw new NotFoundError('User');
    }

    await user.update({
      name: data.name,
      phone: data.phone,
      avatar: data.avatar,
      companyName: data.companyName,
      companyAddress: data.companyAddress,
      city: data.city,
      state: data.state,
      zipCode: data.zipCode,
      ein: data.ein,
      mcNumber: data.mcNumber,
      dotNumber: data.dotNumber,
    });

    // Invalidate user stats cache
    await cacheService.invalidateUser(userId);

    return user;
  }

  // Get public user profile
  async getPublicProfile(userId: string) {
    const user = await User.findByPk(userId, {
      attributes: [
        'id', 'name', 'avatar', 'role', 'verified', 'trustScore',
        'memberSince', 'companyName', 'city', 'state', 'sellerVerified',
      ],
    });

    if (!user) {
      throw new NotFoundError('User');
    }

    // Get counts
    const [activeListings, reviewsCount] = await Promise.all([
      Listing.count({ where: { sellerId: userId, status: 'ACTIVE' } }),
      Review.count({ where: { toUserId: userId } }),
    ]);

    // Calculate average rating
    const ratings = await Review.findOne({
      where: { toUserId: userId },
      attributes: [[fn('AVG', col('rating')), 'avgRating']],
      raw: true,
    }) as unknown as { avgRating: string | null };

    return {
      ...user.toJSON(),
      _count: {
        listings: activeListings,
        reviewsReceived: reviewsCount,
      },
      averageRating: ratings?.avgRating ? parseFloat(ratings.avgRating) : 0,
    };
  }

  // Get user's reviews
  async getUserReviews(userId: string, page: number = 1, limit: number = 10) {
    const offset = (page - 1) * limit;

    const { rows: reviews, count: total } = await Review.findAndCountAll({
      where: { toUserId: userId },
      order: [['createdAt', 'DESC']],
      offset,
      limit,
      include: [{
        model: User,
        as: 'fromUser',
        attributes: ['id', 'name', 'avatar', 'verified'],
      }],
    });

    return {
      reviews,
      pagination: getPaginationInfo(page, limit, total),
    };
  }

  // Get user's public listings
  async getUserListings(userId: string, page: number = 1, limit: number = 10) {
    const offset = (page - 1) * limit;

    const { rows: listings, count: total } = await Listing.findAndCountAll({
      where: {
        sellerId: userId,
        status: 'ACTIVE',
        visibility: 'PUBLIC',
      },
      order: [['createdAt', 'DESC']],
      offset,
      limit,
      attributes: [
        'id', 'mcNumber', 'dotNumber', 'legalName', 'dbaName', 'title', 'askingPrice', 'listingPrice',
        'city', 'state', 'isPremium', 'yearsActive',
        'safetyRating', 'amazonStatus', 'views', 'createdAt',
      ],
    });

    // Public and unauthenticated: same masking as the catalogue, or a bot reads
    // sellerId off /listings and pulls every real MC/DOT from here.
    return {
      listings: listings.map(sanitizeListing),
      pagination: getPaginationInfo(page, limit, total),
    };
  }

  // Upload avatar
  async updateAvatar(userId: string, avatarUrl: string) {
    const user = await User.findByPk(userId);
    if (!user) {
      throw new NotFoundError('User');
    }

    await user.update({ avatar: avatarUrl });

    return { id: user.id, avatar: user.avatar };
  }

  // Deactivate account
  async deactivateAccount(userId: string) {
    await User.update(
      { status: UserStatus.SUSPENDED },
      { where: { id: userId } }
    );

    // Invalidate all refresh tokens
    await RefreshToken.destroy({
      where: { userId },
    });

    return { success: true };
  }

  // Get dashboard stats for any user type
  async getDashboardStats(userId: string, role: string) {
    const user = await User.findByPk(userId);

    if (!user) {
      throw new NotFoundError('User');
    }

    if (role === 'BUYER') {
      return this.getBuyerDashboardStats(userId);
    } else if (role === 'SELLER') {
      return this.getSellerDashboardStats(userId);
    }

    throw new ForbiddenError('Invalid role');
  }

  // Buyer dashboard stats
  private async getBuyerDashboardStats(userId: string) {
    const [
      totalOffers,
      pendingOffers,
      acceptedOffers,
      activeTransactions,
      completedTransactions,
      savedListings,
      unlockedListings,
      creditBalance,
    ] = await Promise.all([
      Offer.count({ where: { buyerId: userId } }),
      Offer.count({ where: { buyerId: userId, status: 'PENDING' } }),
      Offer.count({ where: { buyerId: userId, status: 'ACCEPTED' } }),
      Transaction.count({
        where: {
          buyerId: userId,
          status: { [Op.notIn]: ['COMPLETED', 'CANCELLED'] },
        },
      }),
      Transaction.count({
        where: { buyerId: userId, status: 'COMPLETED' },
      }),
      SavedListing.count({ where: { userId } }),
      UnlockedListing.count({ where: { userId } }),
      User.findByPk(userId, {
        attributes: ['totalCredits', 'usedCredits'],
      }),
    ]);

    return {
      offers: {
        total: totalOffers,
        pending: pendingOffers,
        accepted: acceptedOffers,
      },
      transactions: {
        active: activeTransactions,
        completed: completedTransactions,
      },
      savedListings,
      unlockedListings,
      credits: {
        total: creditBalance?.totalCredits || 0,
        used: creditBalance?.usedCredits || 0,
        available: (creditBalance?.totalCredits || 0) - (creditBalance?.usedCredits || 0),
      },
    };
  }

  // Seller dashboard stats
  private async getSellerDashboardStats(userId: string) {
    const [
      totalListings,
      activeListings,
      pendingListings,
      soldListings,
      totalOffers,
      pendingOffers,
      activeTransactions,
      completedTransactions,
      totalViews,
      totalSaves,
    ] = await Promise.all([
      Listing.count({ where: { sellerId: userId } }),
      Listing.count({ where: { sellerId: userId, status: 'ACTIVE' } }),
      Listing.count({ where: { sellerId: userId, status: 'PENDING_REVIEW' } }),
      Listing.count({ where: { sellerId: userId, status: 'SOLD' } }),
      Offer.count({ where: { sellerId: userId } }),
      Offer.count({ where: { sellerId: userId, status: 'PENDING' } }),
      Transaction.count({
        where: {
          sellerId: userId,
          status: { [Op.notIn]: ['COMPLETED', 'CANCELLED'] },
        },
      }),
      Transaction.count({
        where: { sellerId: userId, status: 'COMPLETED' },
      }),
      Listing.sum('views', { where: { sellerId: userId } }),
      Listing.sum('saves', { where: { sellerId: userId } }),
    ]);

    // Calculate total earnings from completed transactions
    const earnings = await Transaction.sum('agreedPrice', {
      where: { sellerId: userId, status: 'COMPLETED' },
    });

    return {
      listings: {
        total: totalListings,
        active: activeListings,
        pending: pendingListings,
        sold: soldListings,
      },
      offers: {
        total: totalOffers,
        pending: pendingOffers,
      },
      transactions: {
        active: activeTransactions,
        completed: completedTransactions,
      },
      analytics: {
        totalViews: totalViews || 0,
        totalSaves: totalSaves || 0,
      },
      earnings: earnings || 0,
    };
  }
}

export const userService = new UserService();
export default userService;
