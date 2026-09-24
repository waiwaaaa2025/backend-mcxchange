import { Op } from 'sequelize';
import sequelize from '../config/database';
import {
  Offer,
  Listing,
  User,
  Transaction,
  Notification,
  TransactionTimeline,
  OfferStatus,
  ListingStatus,
  TransactionStatus,
} from '../models';
import { NotFoundError, ForbiddenError, ConflictError } from '../middleware/errorHandler';
import { CreateOfferData } from '../types';
import { calculateDeposit, calculatePlatformFee, sellerNetPayout } from '../utils/helpers';
import { addDays } from 'date-fns';
import { adminNotificationService } from './adminNotificationService';
import { emailService } from './emailService';
import { config } from '../config';
import logger from '../utils/logger';

class OfferService {
  // Create a new offer
  async createOffer(buyerId: string, data: CreateOfferData) {
    const listing = await Listing.findByPk(data.listingId, {
      include: [{ model: User, as: 'seller' }],
    });

    if (!listing) {
      throw new NotFoundError('Listing');
    }

    if (listing.status !== ListingStatus.ACTIVE) {
      throw new ForbiddenError('This listing is not available for offers');
    }

    if (listing.sellerId === buyerId) {
      throw new ForbiddenError('You cannot make an offer on your own listing');
    }

    // Check if buyer already has a pending offer on this listing
    const existingOffer = await Offer.findOne({
      where: {
        listingId: data.listingId,
        buyerId,
        status: { [Op.in]: [OfferStatus.PENDING_ADMIN, OfferStatus.PENDING, OfferStatus.FORWARDED, OfferStatus.COUNTERED] },
      },
    });

    if (existingOffer) {
      throw new ConflictError('You already have a pending offer on this listing');
    }

    // Create offer — all offers go to admin first
    const offer = await Offer.create({
      listingId: data.listingId,
      buyerId,
      sellerId: listing.sellerId,
      amount: data.amount,
      message: data.message,
      expiresAt: data.expiresAt || addDays(new Date(), 7),
      status: OfferStatus.PENDING_ADMIN,
      isBuyNow: data.isBuyNow || false,
    });

    const offerWithDetails = await Offer.findByPk(offer.id, {
      include: [
        {
          model: Listing,
          as: 'listing',
          attributes: ['id', 'mcNumber', 'title', 'askingPrice', 'listingPrice'],
        },
        {
          model: User,
          as: 'buyer',
          attributes: ['id', 'name', 'email', 'trustScore', 'verified'],
        },
        {
          model: User,
          as: 'seller',
          attributes: ['id', 'name', 'email'],
        },
      ],
    });

    // Notify all admins — offers go to admin first, not seller
    const admins = await User.findAll({ where: { role: 'ADMIN' } });
    for (const admin of admins) {
      await Notification.create({
        userId: admin.id,
        type: 'OFFER',
        title: 'New Offer Awaiting Review',
        message: `Buyer offered $${data.amount.toLocaleString()} on MC-${listing.mcNumber} (seller asking $${listing.askingPrice?.toLocaleString() || 'N/A'})`,
        link: `/admin/offers`,
        metadata: JSON.stringify({ offerId: offer.id, listingId: listing.id }),
      });
    }

    return offerWithDetails;
  }

  // Get offer by ID
  async getOfferById(offerId: string, userId: string) {
    const offer = await Offer.findByPk(offerId, {
      include: [
        {
          model: Listing,
          as: 'listing',
          include: [{
            model: User,
            as: 'seller',
            attributes: ['id', 'name', 'email', 'phone', 'verified', 'trustScore'],
          }],
        },
        {
          model: User,
          as: 'buyer',
          attributes: ['id', 'name', 'email', 'phone', 'verified', 'trustScore'],
        },
        {
          model: Transaction,
          as: 'transaction',
        },
      ],
    });

    if (!offer) {
      throw new NotFoundError('Offer');
    }

    // Only buyer, seller, or admin can view offer
    if (offer.buyerId !== userId && offer.sellerId !== userId) {
      // Check if admin
      const user = await User.findByPk(userId);
      if (user?.role !== 'ADMIN') {
        throw new ForbiddenError('You do not have access to this offer');
      }
    }

    return offer;
  }

  // Get buyer's offers
  async getBuyerOffers(buyerId: string, status?: OfferStatus) {
    const where: Record<string, unknown> = { buyerId };
    if (status) {
      where.status = status;
    }

    const offers = await Offer.findAll({
      where,
      order: [['createdAt', 'DESC']],
      include: [
        {
          model: Listing,
          as: 'listing',
          attributes: ['id', 'mcNumber', 'dotNumber', 'title', 'askingPrice', 'listingPrice', 'status', 'city', 'state', 'isPremium'],
        },
        {
          model: User,
          as: 'seller',
          attributes: ['id', 'name', 'verified', 'trustScore'],
        },
        {
          model: Transaction,
          as: 'transaction',
          attributes: ['id', 'status'],
        },
      ],
    });

    return offers;
  }

  // Get seller's offers — only shows offers that admin has forwarded (or already acted on)
  async getSellerOffers(sellerId: string, status?: OfferStatus) {
    const where: Record<string, unknown> = { sellerId };
    if (status) {
      where.status = status;
    } else {
      // Never show PENDING_ADMIN offers to sellers — those are admin-only
      where.status = { [Op.ne]: OfferStatus.PENDING_ADMIN };
    }

    const offers = await Offer.findAll({
      where,
      order: [['createdAt', 'DESC']],
      attributes: { exclude: ['message'] }, // Hide buyer's message from seller — admin only
      include: [
        {
          model: Listing,
          as: 'listing',
          attributes: ['id', 'mcNumber', 'dotNumber', 'title', 'askingPrice', 'listingPrice', 'status'],
        },
        {
          model: User,
          as: 'buyer',
          attributes: ['id', 'name', 'verified', 'trustScore'],
        },
        {
          model: Transaction,
          as: 'transaction',
          attributes: ['id', 'status'],
        },
      ],
    });

    return offers;
  }

  // Accept offer (creates transaction)
  async acceptOffer(offerId: string, sellerId: string) {
    const offer = await Offer.findByPk(offerId, {
      include: [
        { model: Listing, as: 'listing' },
        { model: User, as: 'buyer' },
      ],
    });

    if (!offer) {
      throw new NotFoundError('Offer');
    }

    if (offer.sellerId !== sellerId) {
      throw new ForbiddenError('You can only accept offers on your own listings');
    }

    if (offer.status !== OfferStatus.FORWARDED && offer.status !== OfferStatus.PENDING && offer.status !== OfferStatus.COUNTERED) {
      throw new ForbiddenError('This offer cannot be accepted');
    }

    // Calculate amounts — buyer pays their offer amount, seller gets sellerAmount
    const buyerPrice = Number(offer.counterAmount || offer.amount);
    const depositAmount = calculateDeposit(buyerPrice);
    const platformFee = calculatePlatformFee(buyerPrice);
    const sellerPrice = sellerNetPayout(buyerPrice, platformFee, offer.sellerAmount, (offer as any).listing?.askingPrice ?? (await Listing.findByPk(offer.listingId, { attributes: ['askingPrice'] }))?.askingPrice);

    const t = await sequelize.transaction();

    try {
      // Update offer status
      await offer.update(
        { status: OfferStatus.ACCEPTED, respondedAt: new Date() },
        { transaction: t }
      );

      // Create transaction — agreedPrice is what buyer pays, sellerPayout is what seller gets
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

      // Update listing status
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

      // Create notification for buyer
      await Notification.create({
        userId: offer.buyerId,
        type: 'OFFER',
        title: 'Offer Accepted!',
        message: `Your offer on MC-${offer.listing?.mcNumber} has been accepted. Please proceed with the deposit.`,
        link: `/transaction/${transaction.id}`,
        metadata: JSON.stringify({ transactionId: transaction.id }),
      });

      // Create timeline entry
      await TransactionTimeline.create({
        transactionId: transaction.id,
        status: TransactionStatus.AWAITING_DEPOSIT,
        title: 'Transaction Created',
        description: 'Offer accepted. Awaiting deposit from buyer.',
        actorId: sellerId,
        actorRole: 'SELLER',
      });

      // Notify admins of new transaction (async, don't wait)
      adminNotificationService.notifyTransaction({
        transactionId: transaction.id,
        mcNumber: offer.listing?.mcNumber || 'Unknown',
        buyerName: offer.buyer?.name || 'Unknown',
        sellerName: offer.listing?.seller?.name || 'Unknown',
        amount: buyerPrice,
        status: 'created',
      }).catch(err => {
        logger.error('Failed to send admin notification for transaction', err);
      });

      // Send "offer accepted" emails to both parties (best effort)
      try {
        const seller = await User.findByPk(offer.sellerId, { attributes: ['email', 'name'] });
        const buyerEmail = offer.buyer?.email;
        const buyerName = offer.buyer?.name || 'Buyer';
        const sellerName = seller?.name || 'Seller';
        const mcNumber = offer.listing?.mcNumber || 'N/A';
        const listingTitle = offer.listing?.title || '';

        if (buyerEmail) {
          await emailService.sendOfferAccepted(buyerEmail, {
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
        logger.error('Failed to send offer accepted emails', { offerId, err });
      }

      return { offer, transaction };
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }

  // Reject offer
  async rejectOffer(offerId: string, sellerId: string) {
    const offer = await Offer.findByPk(offerId, {
      include: [{ model: Listing, as: 'listing' }],
    });

    if (!offer) {
      throw new NotFoundError('Offer');
    }

    if (offer.sellerId !== sellerId) {
      throw new ForbiddenError('You can only reject offers on your own listings');
    }

    if (offer.status !== OfferStatus.FORWARDED && offer.status !== OfferStatus.PENDING && offer.status !== OfferStatus.COUNTERED) {
      throw new ForbiddenError('This offer cannot be rejected');
    }

    await offer.update({
      status: OfferStatus.REJECTED,
      respondedAt: new Date(),
    });

    // Create notification for buyer
    await Notification.create({
      userId: offer.buyerId,
      type: 'OFFER',
      title: 'Offer Declined',
      message: `Your offer on MC-${offer.listing?.mcNumber} has been declined.`,
      link: `/buyer/offers`,
    });

    return offer;
  }

  // Counter offer
  async counterOffer(offerId: string, sellerId: string, counterAmount: number, message?: string) {
    const offer = await Offer.findByPk(offerId, {
      include: [{ model: Listing, as: 'listing' }],
    });

    if (!offer) {
      throw new NotFoundError('Offer');
    }

    if (offer.sellerId !== sellerId) {
      throw new ForbiddenError('You can only counter offers on your own listings');
    }

    if (offer.status !== OfferStatus.FORWARDED && offer.status !== OfferStatus.PENDING) {
      throw new ForbiddenError('This offer cannot be countered');
    }

    await offer.update({
      status: OfferStatus.COUNTERED,
      counterAmount,
      counterMessage: message,
      counterAt: new Date(),
    });

    // Create notification for buyer
    await Notification.create({
      userId: offer.buyerId,
      type: 'OFFER',
      title: 'Counter Offer Received',
      message: `The seller has countered your offer on MC-${offer.listing?.mcNumber} with $${counterAmount.toLocaleString()}`,
      link: `/buyer/offers`,
      metadata: JSON.stringify({ offerId, counterAmount }),
    });

    return offer;
  }

  // Accept counter offer (buyer accepts seller's counter)
  async acceptCounterOffer(offerId: string, buyerId: string) {
    const offer = await Offer.findByPk(offerId, {
      include: [{ model: Listing, as: 'listing' }],
    });

    if (!offer) {
      throw new NotFoundError('Offer');
    }

    if (offer.buyerId !== buyerId) {
      throw new ForbiddenError('You can only accept counter offers on your own offers');
    }

    if (offer.status !== OfferStatus.COUNTERED) {
      throw new ForbiddenError('This offer does not have a counter offer');
    }

    // Accept the counter by setting the amount to counter amount
    await offer.update({
      amount: offer.counterAmount!,
      status: OfferStatus.PENDING, // Reset to pending so seller can accept
      respondedAt: new Date(),
    });

    // Notify seller that counter was accepted
    await Notification.create({
      userId: offer.sellerId,
      type: 'OFFER',
      title: 'Counter Offer Accepted',
      message: `The buyer has accepted your counter offer on MC-${offer.listing?.mcNumber}. Please confirm to proceed.`,
      link: `/seller/offers`,
    });

    return offer;
  }

  // Withdraw offer (buyer cancels their offer)
  async withdrawOffer(offerId: string, buyerId: string) {
    const offer = await Offer.findByPk(offerId);

    if (!offer) {
      throw new NotFoundError('Offer');
    }

    if (offer.buyerId !== buyerId) {
      throw new ForbiddenError('You can only withdraw your own offers');
    }

    if (offer.status !== OfferStatus.PENDING && offer.status !== OfferStatus.COUNTERED) {
      throw new ForbiddenError('This offer cannot be withdrawn');
    }

    await offer.update({
      status: OfferStatus.WITHDRAWN,
      respondedAt: new Date(),
    });

    return offer;
  }

  // Get all offers for a listing (admin)
  async getListingOffers(listingId: string) {
    const offers = await Offer.findAll({
      where: { listingId },
      order: [['createdAt', 'DESC']],
      include: [
        {
          model: User,
          as: 'buyer',
          attributes: ['id', 'name', 'email', 'verified', 'trustScore'],
        },
        {
          model: User,
          as: 'seller',
          attributes: ['id', 'name'],
        },
        {
          model: Transaction,
          as: 'transaction',
          attributes: ['id', 'status'],
        },
      ],
    });

    return offers;
  }
}

export const offerService = new OfferService();
export default offerService;
