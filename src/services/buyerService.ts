import { Op } from 'sequelize';
import sequelize from '../config/database';
import {
  User,
  Listing,
  Offer,
  Transaction,
  SavedListing,
  UnlockedListing,
  Subscription,
  CreditTransaction,
  CreditTransactionType,
  Document,
  Payment,
  Notification,
  NotificationType,
  SubscriptionStatus,
  SubscriptionPlan,
  PremiumRequest,
  PremiumRequestStatus,
  UserTermsAcceptance,
} from '../models';
import { getPaginationInfo } from '../utils/helpers';
import { stripeService } from './stripeService';
import { NotFoundError, BadRequestError } from '../middleware/errorHandler';
import { SUBSCRIPTION_PLANS } from '../types';
import logger from '../utils/logger';

class BuyerService {
  // Get buyer dashboard stats
  async getDashboardStats(buyerId: string) {
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
      Offer.count({ where: { buyerId } }),
      Offer.count({ where: { buyerId, status: 'PENDING' } }),
      Offer.count({ where: { buyerId, status: 'ACCEPTED' } }),
      Transaction.count({
        where: {
          buyerId,
          status: { [Op.notIn]: ['COMPLETED', 'CANCELLED'] },
        },
      }),
      Transaction.count({
        where: { buyerId, status: 'COMPLETED' },
      }),
      SavedListing.count({ where: { userId: buyerId } }),
      UnlockedListing.count({ where: { userId: buyerId } }),
      User.findByPk(buyerId, {
        attributes: ['totalCredits', 'usedCredits'],
      }),
    ]);

    // Get subscription info
    const subscription = await Subscription.findOne({
      where: { userId: buyerId },
    });

    // Get recent activity
    const recentOffers = await Offer.findAll({
      where: { buyerId },
      order: [['createdAt', 'DESC']],
      limit: 5,
      include: [
        {
          model: Listing,
          as: 'listing',
          attributes: ['mcNumber', 'title', 'askingPrice', 'listingPrice'],
        },
        {
          model: User,
          as: 'seller',
          attributes: ['name'],
        },
      ],
    });

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
      subscription: subscription ? {
        plan: subscription.plan,
        status: subscription.status,
        creditsRemaining: subscription.creditsRemaining,
        renewalDate: subscription.renewalDate,
      } : null,
      recentOffers,
    };
  }

  // Get buyer's offers
  async getOffers(buyerId: string, status?: string, page: number = 1, limit: number = 20) {
    const offset = (page - 1) * limit;
    const where: Record<string, unknown> = { buyerId };
    if (status) {
      where.status = status;
    }

    const { rows: offers, count: total } = await Offer.findAndCountAll({
      where,
      order: [['createdAt', 'DESC']],
      offset,
      limit,
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

    return {
      offers,
      pagination: getPaginationInfo(page, limit, total),
    };
  }

  // Get buyer's purchases (completed transactions)
  async getPurchases(buyerId: string, page: number = 1, limit: number = 20) {
    const offset = (page - 1) * limit;

    const { rows: transactions, count: total } = await Transaction.findAndCountAll({
      where: { buyerId, status: 'COMPLETED' },
      order: [['completedAt', 'DESC']],
      offset,
      limit,
      include: [
        {
          model: Listing,
          as: 'listing',
          attributes: ['id', 'mcNumber', 'dotNumber', 'title', 'legalName', 'city', 'state'],
        },
        {
          model: User,
          as: 'seller',
          attributes: ['id', 'name', 'email', 'phone'],
        },
      ],
    });

    return {
      purchases: transactions,
      pagination: getPaginationInfo(page, limit, total),
    };
  }

  // Get saved listings
  async getSavedListings(buyerId: string, page: number = 1, limit: number = 20) {
    const offset = (page - 1) * limit;

    const { rows: saved, count: total } = await SavedListing.findAndCountAll({
      where: { userId: buyerId },
      order: [['createdAt', 'DESC']],
      offset,
      limit,
      include: [{
        model: Listing,
        as: 'listing',
        attributes: [
          'id', 'mcNumber', 'dotNumber', 'title', 'askingPrice', 'listingPrice',
          'city', 'state', 'status', 'isPremium', 'safetyRating',
          'amazonStatus', 'views',
        ],
        include: [{
          model: User,
          as: 'seller',
          attributes: ['id', 'name', 'verified', 'trustScore'],
        }],
      }],
    });

    return {
      listings: saved.map(s => ({
        ...s.listing?.toJSON(),
        savedAt: s.createdAt,
      })),
      pagination: getPaginationInfo(page, limit, total),
    };
  }

  // Get unlocked listings
  async getUnlockedListings(buyerId: string, page: number = 1, limit: number = 20) {
    const offset = (page - 1) * limit;

    const { rows: unlocked, count: total } = await UnlockedListing.findAndCountAll({
      where: { userId: buyerId },
      order: [['createdAt', 'DESC']],
      offset,
      limit,
      include: [{
        model: Listing,
        as: 'listing',
        include: [
          {
            model: User,
            as: 'seller',
            attributes: ['id', 'name', 'email', 'phone', 'verified', 'trustScore', 'companyName'],
          },
          {
            model: Document,
            as: 'documents',
            where: { status: 'VERIFIED' },
            required: false,
            attributes: ['id', 'type', 'name'],
          },
        ],
      }],
    });

    return {
      listings: unlocked.map(u => ({
        ...u.listing?.toJSON(),
        creditsUsed: u.creditsUsed,
        unlockedAt: u.createdAt,
      })),
      pagination: getPaginationInfo(page, limit, total),
    };
  }

  // Get subscription details
  async getSubscription(buyerId: string) {
    const subscription = await Subscription.findOne({
      where: { userId: buyerId },
    });

    const user = await User.findByPk(buyerId, {
      attributes: ['totalCredits', 'usedCredits'],
    });

    // Get credit history
    const recentCredits = await CreditTransaction.findAll({
      where: { userId: buyerId },
      order: [['createdAt', 'DESC']],
      limit: 10,
    });

    return {
      subscription,
      credits: {
        total: user?.totalCredits || 0,
        used: user?.usedCredits || 0,
        available: (user?.totalCredits || 0) - (user?.usedCredits || 0),
      },
      recentTransactions: recentCredits,
    };
  }

  // Get buyer's active transactions
  async getTransactions(buyerId: string, page: number = 1, limit: number = 20) {
    const offset = (page - 1) * limit;

    const { rows: transactions, count: total } = await Transaction.findAndCountAll({
      where: { buyerId },
      order: [['createdAt', 'DESC']],
      offset,
      limit,
      include: [
        {
          model: Listing,
          as: 'listing',
          attributes: ['id', 'mcNumber', 'dotNumber', 'title', 'askingPrice', 'listingPrice'],
        },
        {
          model: User,
          as: 'seller',
          attributes: ['id', 'name', 'email', 'phone', 'trustScore'],
        },
        {
          model: Payment,
          as: 'payments',
          attributes: ['id', 'type', 'amount', 'status', 'method', 'stripePaymentId', 'reference', 'verifiedAt', 'description', 'createdAt'],
          order: [['createdAt', 'DESC']],
        },
      ],
    });

    return {
      transactions,
      pagination: getPaginationInfo(page, limit, total),
    };
  }

  // Cancel subscription
  async cancelSubscription(buyerId: string) {
    const subscription = await Subscription.findOne({
      where: { userId: buyerId },
    });

    if (!subscription) {
      throw new NotFoundError('No active subscription found');
    }

    if (subscription.status !== 'ACTIVE') {
      throw new BadRequestError('Subscription is not active');
    }

    // Cancel in Stripe
    if (subscription.stripeSubId) {
      const cancelled = await stripeService.cancelSubscription(subscription.stripeSubId, false);
      if (!cancelled) {
        throw new BadRequestError('Failed to cancel subscription');
      }
    }

    // Update subscription status
    await subscription.update({
      status: 'CANCELLED',
      cancelledAt: new Date(),
    });

    return {
      message: 'Subscription cancelled successfully',
      subscription,
    };
  }

  // Verify and fulfill subscription after Stripe checkout
  // This checks Stripe for the user's subscription and adds credits if not already processed
  async verifyAndFulfillSubscription(buyerId: string) {
    const user = await User.findByPk(buyerId);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Check if user has a Stripe customer ID
    if (!user.stripeCustomerId) {
      logger.info('User has no Stripe customer ID', { buyerId });
      return { fulfilled: false, message: 'No Stripe customer found' };
    }

    // Get the Stripe instance
    const stripe = stripeService.getStripe();
    if (!stripe) {
      throw new BadRequestError('Stripe service not available');
    }

    // Get user's subscriptions from Stripe
    const stripeSubscriptions = await stripe.subscriptions.list({
      customer: user.stripeCustomerId,
      status: 'active',
      limit: 1,
    });

    if (stripeSubscriptions.data.length === 0) {
      logger.info('No active Stripe subscription found', { buyerId, customerId: user.stripeCustomerId });
      return { fulfilled: false, message: 'No active subscription found in Stripe' };
    }

    const stripeSubscription = stripeSubscriptions.data[0];
    const metadata = stripeSubscription.metadata;
    // Plan in metadata is lowercase (starter, premium, enterprise) but SUBSCRIPTION_PLANS keys are uppercase
    // Handle legacy 'PROFESSIONAL' metadata from existing Stripe subscriptions
    let planFromMetadata = (metadata?.plan || 'starter').toUpperCase();
    if (planFromMetadata === 'PROFESSIONAL') planFromMetadata = 'PREMIUM';
    const plan = planFromMetadata as SubscriptionPlan;
    const isYearly = metadata?.isYearly === 'true';

    // Calculate renewal date from Stripe subscription period end
    // Stripe returns timestamps in seconds, we need milliseconds
    const periodEnd = (stripeSubscription as any).current_period_end;
    const renewalDate = periodEnd && typeof periodEnd === 'number'
      ? new Date(periodEnd * 1000)
      : new Date(Date.now() + (isYearly ? 365 : 30) * 24 * 60 * 60 * 1000); // Fallback: 30 days or 1 year from now

    logger.info('Stripe subscription details', {
      buyerId,
      periodEnd,
      renewalDate: renewalDate.toISOString(),
      plan,
      isYearly,
    });

    // Check if we already have this subscription in our database
    let subscription = await Subscription.findOne({
      where: { userId: buyerId },
    });

    // If subscription already active with credits, don't fulfill again
    if (subscription && subscription.status === SubscriptionStatus.ACTIVE && subscription.stripeSubId === stripeSubscription.id) {
      logger.info('Subscription already fulfilled', { buyerId, subscriptionId: subscription.id });
      return {
        fulfilled: true,
        message: 'Subscription already active',
        subscription: await this.getSubscription(buyerId),
      };
    }

    // Get plan details - use type assertion for SUBSCRIPTION_PLANS index
    const planDetails = SUBSCRIPTION_PLANS[plan as keyof typeof SUBSCRIPTION_PLANS];
    if (!planDetails) {
      logger.error('Invalid plan from Stripe metadata', { plan, buyerId });
      throw new BadRequestError('Invalid subscription plan');
    }

    const t = await sequelize.transaction();

    try {
      // Create or update subscription in our database
      // NOTE: Credits are NOT added here - they are granted via webhook (customer.subscription.created)
      // to avoid double credit granting. This method only syncs the subscription record.
      if (subscription) {
        await subscription.update({
          plan,
          status: SubscriptionStatus.ACTIVE,
          priceMonthly: planDetails.priceMonthly,
          priceYearly: planDetails.priceYearly,
          isYearly,
          creditsPerMonth: planDetails.credits,
          creditsRemaining: planDetails.credits,
          startDate: new Date(),
          renewalDate,
          stripeSubId: stripeSubscription.id,
          cancelledAt: null,
        }, { transaction: t });
      } else {
        subscription = await Subscription.create({
          userId: buyerId,
          plan,
          status: SubscriptionStatus.ACTIVE,
          priceMonthly: planDetails.priceMonthly,
          priceYearly: planDetails.priceYearly,
          isYearly,
          creditsPerMonth: planDetails.credits,
          creditsRemaining: planDetails.credits,
          renewalDate,
          stripeSubId: stripeSubscription.id,
        }, { transaction: t });
      }

      await t.commit();

      logger.info('Subscription record synced successfully', {
        buyerId,
        plan,
        stripeSubscriptionId: stripeSubscription.id,
      });

      return {
        fulfilled: true,
        message: 'Subscription verified and synced',
        subscription: await this.getSubscription(buyerId),
      };
    } catch (error) {
      await t.rollback();
      logger.error('Failed to fulfill subscription', { buyerId, error });
      throw error;
    }
  }

  // Create a premium request to access a premium listing
  async createPremiumRequest(buyerId: string, listingId: string, message?: string) {
    // Check if listing exists and is premium
    const listing = await Listing.findByPk(listingId);
    if (!listing) {
      throw new NotFoundError('Listing not found');
    }

    if (!listing.isPremium) {
      throw new BadRequestError('This listing is not premium. You can unlock it directly.');
    }

    // Check if buyer already has access (already unlocked)
    const existingUnlock = await UnlockedListing.findOne({
      where: { userId: buyerId, listingId },
    });
    if (existingUnlock) {
      throw new BadRequestError('You already have access to this listing');
    }

    // Check if there's already a pending request
    const existingRequest = await PremiumRequest.findOne({
      where: {
        buyerId,
        listingId,
        status: { [Op.in]: [PremiumRequestStatus.PENDING, PremiumRequestStatus.CONTACTED, PremiumRequestStatus.IN_PROGRESS] },
      },
    });
    if (existingRequest) {
      throw new BadRequestError('You already have a pending request for this listing');
    }

    // Check if buyer has enough credits
    const user = await User.findByPk(buyerId);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Check subscription plan
    const activeSubscription = await Subscription.findOne({
      where: {
        userId: buyerId,
        status: SubscriptionStatus.ACTIVE,
      },
    });

    const isVip = activeSubscription?.plan === SubscriptionPlan.VIP_ACCESS;

    // Block Starter plan users from requesting premium listings
    if (activeSubscription?.plan === SubscriptionPlan.STARTER) {
      throw new BadRequestError('Starter plan members cannot request premium MC listings. Please upgrade to Professional or Premium to access premium listings.');
    }

    // VIP users bypass credit checks; others need at least 1 credit
    if (!isVip) {
      const availableCredits = user.totalCredits - user.usedCredits;
      if (availableCredits < 1) {
        throw new BadRequestError('Insufficient credits. Please purchase more credits to request premium access.');
      }
    }

    // Auto-approve for paid subscribers (Premium, Enterprise, VIP)
    const isPaidPlan = activeSubscription && [SubscriptionPlan.PREMIUM, SubscriptionPlan.ENTERPRISE, SubscriptionPlan.VIP_ACCESS].includes(activeSubscription.plan);

    if (isPaidPlan) {
      // Paid subscribers get auto-approved — still create the request for admin visibility
      const t = await sequelize.transaction();

      try {
        // 1. Create premium request as COMPLETED
        const request = await PremiumRequest.create(
          {
            buyerId,
            listingId,
            message,
            status: PremiumRequestStatus.COMPLETED,
          },
          { transaction: t }
        );

        // 2. Create UnlockedListing record
        await UnlockedListing.create(
          {
            userId: buyerId,
            listingId,
            creditsUsed: isVip ? 0 : 1,
          },
          { transaction: t }
        );

        // 3. Deduct credit from buyer (VIP users don't use credits)
        if (!isVip) {
          await user.update(
            { usedCredits: user.usedCredits + 1 },
            { transaction: t }
          );

          // 4. Record credit transaction for audit trail
          const availableCredits = user.totalCredits - user.usedCredits;
          await CreditTransaction.create(
            {
              userId: buyerId,
              type: CreditTransactionType.USAGE,
              amount: -1,
              balance: availableCredits - 1,
              description: `Premium listing auto-unlocked (${activeSubscription.plan}): MC-${listing.mcNumber}`,
              reference: listingId,
            },
            { transaction: t }
          );
        }

        // 5. Notify buyer
        await Notification.create(
          {
            type: NotificationType.SYSTEM,
            title: 'Premium Access Granted',
            message: `Your ${activeSubscription.plan} subscription grants you instant access to premium listing MC-${listing.mcNumber}.`,
            userId: buyerId,
          },
          { transaction: t }
        );

        await t.commit();

        logger.info(`Premium request auto-approved for ${activeSubscription.plan} subscriber`, {
          buyerId,
          listingId,
          requestId: request.id,
          creditsDeducted: isVip ? 0 : 1,
        });

        return request;
      } catch (error) {
        await t.rollback();
        logger.error('Failed to auto-approve premium request', { buyerId, listingId, error });
        throw error;
      }
    }

    // Non-enterprise: create as PENDING, requires admin approval
    const request = await PremiumRequest.create({
      buyerId,
      listingId,
      message,
      status: PremiumRequestStatus.PENDING,
    });

    logger.info('Premium request created', { buyerId, listingId, requestId: request.id });

    return request;
  }

  // Get buyer's premium requests
  async getPremiumRequests(buyerId: string, page: number = 1, limit: number = 20) {
    const offset = (page - 1) * limit;

    const { rows: requests, count: total } = await PremiumRequest.findAndCountAll({
      where: { buyerId },
      order: [['createdAt', 'DESC']],
      offset,
      limit,
      include: [{
        model: Listing,
        as: 'listing',
        attributes: ['id', 'mcNumber', 'dotNumber', 'title', 'askingPrice', 'listingPrice', 'city', 'state', 'isPremium'],
      }],
    });

    return {
      requests,
      pagination: getPaginationInfo(page, limit, total),
    };
  }

  // ============ Terms of Service Methods ============

  // Check if user has accepted the current terms
  async getTermsStatus(userId: string, termsVersion: string = '1.0') {
    const acceptance = await UserTermsAcceptance.findOne({
      where: {
        userId,
        termsVersion,
      },
    });

    if (acceptance) {
      return {
        hasAccepted: true,
        acceptedAt: acceptance.acceptedAt,
        signatureName: acceptance.signatureName,
        termsVersion: acceptance.termsVersion,
      };
    }

    return {
      hasAccepted: false,
      acceptedAt: null,
      signatureName: null,
      termsVersion,
    };
  }

  // Accept terms of service
  async acceptTerms(
    userId: string,
    signatureName: string,
    ipAddress?: string,
    userAgent?: string,
    termsVersion: string = '1.0'
  ) {
    // Check if already accepted this version
    const existing = await UserTermsAcceptance.findOne({
      where: {
        userId,
        termsVersion,
      },
    });

    if (existing) {
      return {
        alreadyAccepted: true,
        acceptance: existing,
      };
    }

    // Get user for the PDF
    const user = await User.findByPk(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }

    // Create the acceptance record
    const acceptance = await UserTermsAcceptance.create({
      userId,
      signatureName,
      termsVersion,
      acceptedAt: new Date(),
      ipAddress,
      userAgent,
    });

    // Generate PDF and email admin (async - don't wait)
    this.generateTermsPdfAndEmailAdmin(acceptance, user).catch((err) => {
      logger.error('Failed to generate terms PDF or email admin:', err);
    });

    return {
      alreadyAccepted: false,
      acceptance,
    };
  }

  // Generate PDF and email to admin (called asynchronously)
  private async generateTermsPdfAndEmailAdmin(
    acceptance: UserTermsAcceptance,
    user: User
  ) {
    try {
      // Import dynamically to avoid issues if pdfkit isn't installed
      const PDFDocument = (await import('pdfkit')).default;
      const { emailService } = await import('./emailService');

      // Create PDF in memory
      const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
      const chunks: Buffer[] = [];

      doc.on('data', (chunk: Buffer) => chunks.push(chunk));

      const effectiveDate = acceptance.acceptedAt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

      // Title
      doc
        .fontSize(14)
        .font('Helvetica-Bold')
        .text('CONFIDENTIALITY, NON-DISCLOSURE, AND NON-CIRCUMVENTION AGREEMENT', { align: 'center' })
        .moveDown(0.5);

      doc
        .fontSize(10)
        .font('Helvetica')
        .text('THIS AMENDED AND RESTATED CONFIDENTIALITY, NON-DISCLOSURE, AND NON-CIRCUMVENTION AGREEMENT', { align: 'center' })
        .moveDown();

      // Parties
      doc
        .fontSize(10)
        .text(`This Agreement is made and entered into as of ${effectiveDate} (the "Effective Date"), by and between:`)
        .moveDown(0.5);

      doc
        .font('Helvetica-Bold')
        .text('DISCLOSING PARTY: ', { continued: true })
        .font('Helvetica')
        .text('The Domilea Group, an Illinois limited liability company ("Provider"), acting in its capacity as the exclusive marketing consultant and intermediary for the owner(s) of the business opportunities presented hereunder ("Seller"); and')
        .moveDown(0.5);

      doc
        .font('Helvetica-Bold')
        .text('RECIPIENT: ', { continued: true })
        .font('Helvetica')
        .text(`${user.name} (${user.email}), the undersigned party ("Recipient").`)
        .moveDown();

      // Recitals
      doc
        .font('Helvetica-Bold')
        .text('RECITALS')
        .moveDown(0.3);

      doc
        .font('Helvetica')
        .fontSize(9)
        .text('WHEREAS, Provider serves as an intermediary for the sale of certain transportation, logistics, and trucking business assets (the "Business"); and WHEREAS, Provider possesses certain proprietary, non-public, and highly confidential information regarding the Business; and WHEREAS, Recipient has expressed an interest in evaluating a potential acquisition (the "Transaction");')
        .moveDown(0.5);

      doc.text('NOW, THEREFORE, in consideration of the mutual covenants set forth herein, the Parties agree as follows:').moveDown();

      // Article 1
      doc.font('Helvetica-Bold').fontSize(10).text('ARTICLE 1: CONFIDENTIAL INFORMATION').moveDown(0.3);
      doc.font('Helvetica').fontSize(9)
        .text('1.1. "Confidential Information" includes: (a) Corporate Identity; (b) Financial Data; (c) Operational Assets; (d) Commercial Relationships; (e) Human Capital; (f) Regulatory Status; and (g) The "Fact of Sale."')
        .moveDown(0.3)
        .text('1.4. Recipient shall use Confidential Information solely for evaluating the Transaction and shall not compete with Seller or gain unfair commercial advantage.')
        .moveDown();

      // Article 2
      doc.font('Helvetica-Bold').fontSize(10).text('ARTICLE 2: NON-CIRCUMVENTION').moveDown(0.3);
      doc.font('Helvetica').fontSize(9)
        .text('2.1. Recipient shall not initiate contact with Seller, its owners, employees, or vendors without Provider\'s prior written consent. All communications must go through Provider.')
        .moveDown(0.3)
        .text('2.2. For 24 months following the Effective Date, Recipient shall not: (a) Bypass Provider in any Transaction; (b) Enter alternative arrangements with Seller; (c) Interfere with Provider\'s agreement with Seller.')
        .moveDown(0.3)
        .text('2.3. Liability for Circumvention: Recipient shall pay Provider 10% of Total Transaction Value or Provider\'s commission, whichever is greater.')
        .moveDown();

      // Article 3
      doc.font('Helvetica-Bold').fontSize(10).text('ARTICLE 3: NON-SOLICITATION').moveDown(0.3);
      doc.font('Helvetica').fontSize(9)
        .text('3.1. For 24 months, Recipient shall not solicit or hire Seller\'s employees, drivers, or contractors.')
        .moveDown();

      // Article 4
      doc.font('Helvetica-Bold').fontSize(10).text('ARTICLE 4: DISCLAIMER AND RELEASE').moveDown(0.3);
      doc.font('Helvetica').fontSize(9)
        .text('4.2. PROVIDER MAKES NO WARRANTIES OF ANY KIND. Recipient relies solely on its own due diligence.')
        .moveDown(0.3)
        .text('4.4. Recipient releases Provider from all claims arising from inaccuracies in Confidential Information.')
        .moveDown();

      // Article 6
      doc.font('Helvetica-Bold').fontSize(10).text('ARTICLE 6: DISPUTE RESOLUTION').moveDown(0.3);
      doc.font('Helvetica').fontSize(9)
        .text('6.1. Governed by New York law. 6.2. Binding arbitration in New York, NY.')
        .moveDown(0.3)
        .text('6.4. WAIVER OF JURY TRIAL. 6.5. Provider may seek injunctive relief without bond.')
        .moveDown();

      // Signature section
      doc.addPage();
      doc.font('Helvetica-Bold').fontSize(12).text('SIGNATURE PAGE', { align: 'center' }).moveDown();

      doc.font('Helvetica').fontSize(10)
        .text('IN WITNESS WHEREOF, the Recipient has executed this Agreement as of the Effective Date.')
        .moveDown(2);

      doc
        .font('Helvetica-Bold')
        .text('RECIPIENT INFORMATION:')
        .moveDown(0.5);

      doc
        .font('Helvetica')
        .text(`Name: ${user.name}`)
        .text(`Email: ${user.email}`)
        .text(`User ID: ${user.id}`)
        .moveDown();

      doc
        .font('Helvetica-Bold')
        .text('ELECTRONIC SIGNATURE:')
        .moveDown(0.5);

      doc
        .fontSize(18)
        .font('Helvetica-Oblique')
        .text(acceptance.signatureName, { align: 'center' })
        .moveDown(0.5);

      doc
        .fontSize(10)
        .font('Helvetica')
        .text(`Date Signed: ${effectiveDate}`, { align: 'center' })
        .text(`Time: ${acceptance.acceptedAt.toLocaleTimeString()}`, { align: 'center' })
        .text(`IP Address: ${acceptance.ipAddress || 'Not recorded'}`, { align: 'center' })
        .moveDown(2);

      doc
        .fontSize(8)
        .text('This document was electronically signed through the MC-Xchange platform.', { align: 'center' })
        .text(`Document ID: ${acceptance.id}`, { align: 'center' })
        .text(`Terms Version: ${acceptance.termsVersion}`, { align: 'center' });

      doc.end();

      // Wait for PDF to finish
      const pdfBuffer = await new Promise<Buffer>((resolve) => {
        doc.on('end', () => {
          resolve(Buffer.concat(chunks));
        });
      });

      // Email to admin with PDF attachment
      await emailService.sendEmail({
        to: 'admin@domilea.com',
        subject: `NDA/NCA Signed: ${user.name} (${user.email})`,
        html: `
          <h2>New Confidentiality, Non-Disclosure, and Non-Circumvention Agreement Signed</h2>
          <p><strong>User:</strong> ${user.name}</p>
          <p><strong>Email:</strong> ${user.email}</p>
          <p><strong>Electronic Signature:</strong> ${acceptance.signatureName}</p>
          <p><strong>Signed At:</strong> ${acceptance.acceptedAt.toLocaleString()}</p>
          <p><strong>Agreement Version:</strong> ${acceptance.termsVersion}</p>
          <p><strong>IP Address:</strong> ${acceptance.ipAddress || 'Not recorded'}</p>
          <p>The signed NDA/NCA agreement is attached as a PDF.</p>
        `,
        attachments: [
          {
            filename: `terms-acceptance-${user.id}-${Date.now()}.pdf`,
            content: pdfBuffer,
            contentType: 'application/pdf',
          },
        ],
      });

      // Update acceptance record with email timestamp
      await acceptance.update({
        emailedToAdminAt: new Date(),
      });

      logger.info(`Terms acceptance PDF generated and emailed for user ${user.id}`);
    } catch (error) {
      logger.error('Error generating terms PDF or emailing admin:', error);
      throw error;
    }
  }
}

export const buyerService = new BuyerService();
export default buyerService;
