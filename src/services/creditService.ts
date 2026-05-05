import sequelize from '../config/database';
import {
  User,
  Subscription,
  CreditTransaction,
  Payment,
  SubscriptionPlan,
  SubscriptionStatus,
  CreditTransactionType,
  PaymentStatus,
  PaymentType,
} from '../models';
import { NotFoundError, ForbiddenError, ConflictError, BadRequestError } from '../middleware/errorHandler';
import { SUBSCRIPTION_PLANS } from '../types';
import { addMonths, addYears } from 'date-fns';
import { stripeService } from './stripeService';
import { emailService } from './emailService';
import { pricingConfigService, SubscriptionPlanConfig } from './pricingConfigService';
import logger from '../utils/logger';
import { config } from '../config';

// ============================================
// Types
// ============================================

interface CreateSubscriptionParams {
  userId: string;
  plan: SubscriptionPlan;
  isYearly: boolean;
  paymentMethodId?: string;
}

interface PurchaseCreditsParams {
  userId: string;
  creditAmount: number;
  paymentMethodId: string;
}

interface SubscriptionWithStripe extends Subscription {
  stripeSubscriptionId?: string;
  stripeCustomerId?: string;
}

// ============================================
// Credit Service Class
// ============================================

class CreditService {
  // ============================================
  // Credit Balance Management
  // ============================================

  /**
   * Get user's credit balance
   */
  async getCreditBalance(userId: string) {
    const user = await User.findByPk(userId, {
      attributes: ['totalCredits', 'usedCredits'],
    });

    if (!user) {
      throw new NotFoundError('User');
    }

    return {
      totalCredits: user.totalCredits,
      usedCredits: user.usedCredits,
      availableCredits: user.totalCredits - user.usedCredits,
    };
  }

  /**
   * Get credit transaction history
   */
  async getCreditHistory(userId: string, page: number = 1, limit: number = 20) {
    const offset = (page - 1) * limit;

    const { rows: transactions, count: total } = await CreditTransaction.findAndCountAll({
      where: { userId },
      order: [['createdAt', 'DESC']],
      offset,
      limit,
    });

    return {
      transactions,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  /**
   * Check if user has enough credits
   */
  async hasCredits(userId: string, required: number = 1): Promise<boolean> {
    const balance = await this.getCreditBalance(userId);
    return balance.availableCredits >= required;
  }

  /**
   * Use credits (deduct from user balance)
   */
  async useCredits(
    userId: string,
    amount: number,
    description: string,
    reference?: string
  ): Promise<{ success: boolean; newBalance: number }> {
    const user = await User.findByPk(userId);
    if (!user) {
      throw new NotFoundError('User');
    }

    const availableCredits = user.totalCredits - user.usedCredits;
    if (availableCredits < amount) {
      throw new ForbiddenError('Insufficient credits');
    }

    const newUsed = user.usedCredits + amount;
    const newBalance = user.totalCredits - newUsed;

    const t = await sequelize.transaction();

    try {
      await user.update({ usedCredits: newUsed }, { transaction: t });

      await CreditTransaction.create(
        {
          userId,
          type: CreditTransactionType.USAGE,
          amount: -amount,
          balance: newBalance,
          description,
          reference,
        },
        { transaction: t }
      );

      await t.commit();

      logger.info('Credits used', { userId, amount, newBalance });
      return { success: true, newBalance };
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }

  // ============================================
  // Subscription Plans
  // ============================================

  /**
   * Get available subscription plans (uses dynamic pricing from database)
   */
  async getSubscriptionPlans() {
    const plans = await pricingConfigService.getSubscriptionPlans();
    return plans.map((plan, index) => {
      const keys = ['STARTER', 'PROFESSIONAL', 'PREMIUM', 'VIP_ACCESS'];
      return {
        id: keys[index],
        name: plan.name,
        credits: plan.credits,
        priceMonthly: plan.priceMonthly,
        priceYearly: plan.priceYearly,
        pricePerCreditMonthly: plan.credits > 0 ? Math.round((plan.priceMonthly / plan.credits) * 100) / 100 : 0,
        pricePerCreditYearly: plan.credits > 0 ? Math.round((plan.priceYearly / plan.credits) * 100) / 100 : 0,
        stripePriceIdMonthly: plan.stripePriceIdMonthly,
        stripePriceIdYearly: plan.stripePriceIdYearly,
        features: plan.features,
      };
    });
  }

  /**
   * Get a specific subscription plan's config by key.
   * Grandfathered plans (PACKAGE_TOOL, ENTERPRISE) are no longer in the public catalog
   * but existing subscribers still need their credit allocation honored on renewal.
   */
  async getSubscriptionPlanConfig(plan: SubscriptionPlan): Promise<SubscriptionPlanConfig> {
    if (plan === SubscriptionPlan.PACKAGE_TOOL) {
      return {
        name: 'Pulse Bundle',
        credits: 0,
        priceMonthly: 14.99,
        priceYearly: 143.90,
        stripePriceIdMonthly: process.env.STRIPE_PRICE_PACKAGE_TOOL_MONTHLY || '',
        stripePriceIdYearly: process.env.STRIPE_PRICE_PACKAGE_TOOL_YEARLY || '',
        features: ['Carrier intelligence tools', 'No listing credits — tools only'],
      };
    }
    if (plan === SubscriptionPlan.ENTERPRISE) {
      return {
        name: 'Enterprise',
        credits: 15,
        priceMonthly: 79.99,
        priceYearly: 767.99,
        stripePriceIdMonthly: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY || '',
        stripePriceIdYearly: process.env.STRIPE_PRICE_ENTERPRISE_YEARLY || '',
        features: ['15 listing unlock credits per month', 'Free credit reports', 'AI-powered due diligence'],
      };
    }
    const planKey = plan as 'STARTER' | 'PROFESSIONAL' | 'PREMIUM' | 'VIP_ACCESS';
    return pricingConfigService.getSubscriptionPlan(planKey);
  }

  /**
   * Get user's current subscription
   */
  async getCurrentSubscription(userId: string) {
    const subscription = await Subscription.findOne({
      where: { userId },
    });

    return subscription;
  }

  // ============================================
  // Stripe-Integrated Subscription Management
  // ============================================

  /**
   * Create a subscription checkout session
   * Returns a Stripe checkout URL for the user to complete payment
   */
  async createSubscriptionCheckout(
    userId: string,
    plan: SubscriptionPlan,
    isYearly: boolean
  ): Promise<{ checkoutUrl: string; sessionId: string }> {
    const user = await User.findByPk(userId);
    if (!user) {
      throw new NotFoundError('User');
    }

    // Check for existing active subscription
    const existing = await Subscription.findOne({
      where: { userId, status: SubscriptionStatus.ACTIVE },
    });

    if (existing) {
      throw new ConflictError('You already have an active subscription. Please cancel it first or upgrade.');
    }

    // Get plan details from dynamic pricing config
    const planDetails = await this.getSubscriptionPlanConfig(plan);
    if (!planDetails) {
      throw new BadRequestError('Invalid subscription plan');
    }

    // Ensure user has a Stripe customer ID
    let stripeCustomerId = user.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripeService.createCustomer({
        email: user.email,
        name: user.name,
        metadata: { userId: user.id },
      });
      stripeCustomerId = customer.id;
      await user.update({ stripeCustomerId });
    }

    // Get the appropriate price ID from dynamic config
    const priceId = isYearly ? planDetails.stripePriceIdYearly : planDetails.stripePriceIdMonthly;

    if (!priceId) {
      // If no Stripe price ID configured, fall back to one-time payment
      logger.warn('No Stripe price ID configured for plan, using one-time payment', { plan, isYearly });
      return this.createOneTimePaymentCheckout(userId, plan, isYearly);
    }

    // Create Stripe checkout session for subscription
    const session = await stripeService.createSubscription({
      customerId: stripeCustomerId,
      priceId,
      metadata: {
        userId: user.id,
        plan,
        isYearly: String(isYearly),
      },
    });

    logger.info('Subscription checkout session created', {
      userId,
      plan,
      isYearly,
      sessionId: session.subscriptionId,
    });

    return {
      checkoutUrl: session.clientSecret || '',
      sessionId: session.subscriptionId || '',
    };
  }

  /**
   * Create a one-time payment checkout for subscription
   * Used when Stripe recurring prices aren't configured
   */
  private async createOneTimePaymentCheckout(
    userId: string,
    plan: SubscriptionPlan,
    isYearly: boolean
  ): Promise<{ checkoutUrl: string; sessionId: string }> {
    const user = await User.findByPk(userId);
    if (!user) {
      throw new NotFoundError('User');
    }

    const planDetails = await this.getSubscriptionPlanConfig(plan);
    const price = isYearly ? planDetails.priceYearly : planDetails.priceMonthly;
    const priceInCents = Math.round(price * 100);

    // Ensure user has a Stripe customer ID
    let stripeCustomerId = user.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripeService.createCustomer({
        email: user.email,
        name: user.name,
        metadata: { userId: user.id },
      });
      stripeCustomerId = customer.id;
      await user.update({ stripeCustomerId });
    }

    // Create payment intent
    const paymentIntent = await stripeService.createPaymentIntent({
      amount: priceInCents,
      currency: 'usd',
      customerId: stripeCustomerId,
      metadata: {
        type: 'subscription',
        userId: user.id,
        plan,
        isYearly: String(isYearly),
        credits: String(planDetails.credits),
      },
    });

    // For one-time payments, we'll create a simple payment link
    // In production, you'd use Stripe Checkout Session
    logger.info('One-time payment intent created for subscription', {
      userId,
      plan,
      paymentIntentId: paymentIntent.paymentIntentId,
    });

    return {
      checkoutUrl: `${config.frontendUrl}/checkout?payment_intent=${paymentIntent.paymentIntentId}&client_secret=${paymentIntent.clientSecret}`,
      sessionId: paymentIntent.paymentIntentId || '',
    };
  }

  /**
   * Handle successful subscription payment (called from webhook)
   */
  async handleSubscriptionPaymentSuccess(
    stripeSubscriptionId: string,
    stripeCustomerId: string,
    metadata: Record<string, string>
  ): Promise<void> {
    const { userId, plan, isYearly } = metadata;

    if (!userId || !plan) {
      logger.error('Missing metadata in subscription webhook', { metadata });
      return;
    }

    const user = await User.findByPk(userId);
    if (!user) {
      logger.error('User not found for subscription webhook', { userId });
      return;
    }

    // Get plan details from dynamic pricing config
    const planDetails = await this.getSubscriptionPlanConfig(plan as SubscriptionPlan);
    if (!planDetails) {
      logger.error('Invalid plan in subscription webhook', { plan });
      return;
    }

    const isYearlyBool = isYearly === 'true';
    const price = isYearlyBool ? planDetails.priceYearly : planDetails.priceMonthly;
    const renewalDate = isYearlyBool ? addYears(new Date(), 1) : addMonths(new Date(), 1);

    const t = await sequelize.transaction();

    try {
      // Create or update subscription
      let subscription = await Subscription.findOne({
        where: { userId },
        transaction: t,
      });

      if (subscription) {
        await subscription.update(
          {
            plan: plan as SubscriptionPlan,
            status: SubscriptionStatus.ACTIVE,
            priceMonthly: planDetails.priceMonthly,
            priceYearly: planDetails.priceYearly,
            isYearly: isYearlyBool,
            creditsPerMonth: planDetails.credits,
            creditsRemaining: planDetails.credits,
            startDate: new Date(),
            renewalDate,
            cancelledAt: null,
            stripeSubscriptionId,
          },
          { transaction: t }
        );
      } else {
        subscription = await Subscription.create(
          {
            userId,
            plan: plan as SubscriptionPlan,
            status: SubscriptionStatus.ACTIVE,
            priceMonthly: planDetails.priceMonthly,
            priceYearly: planDetails.priceYearly,
            isYearly: isYearlyBool,
            creditsPerMonth: planDetails.credits,
            creditsRemaining: planDetails.credits,
            renewalDate,
            stripeSubscriptionId,
          },
          { transaction: t }
        );
      }

      // Add credits to user
      const newTotal = user.totalCredits + planDetails.credits;
      await user.update({ totalCredits: newTotal }, { transaction: t });

      // Record credit transaction
      await CreditTransaction.create(
        {
          userId,
          type: CreditTransactionType.PURCHASE,
          amount: planDetails.credits,
          balance: newTotal - user.usedCredits,
          description: `${planDetails.name} subscription - ${planDetails.credits} credits`,
          reference: subscription.id,
        },
        { transaction: t }
      );

      // Record payment
      await Payment.create(
        {
          userId,
          type: PaymentType.SUBSCRIPTION,
          amount: price,
          status: PaymentStatus.COMPLETED,
          stripePaymentId: stripeSubscriptionId,
          description: `${planDetails.name} ${isYearlyBool ? 'yearly' : 'monthly'} subscription`,
          completedAt: new Date(),
        },
        { transaction: t }
      );

      await t.commit();

      // Send confirmation email
      try {
        await emailService.sendPaymentReceived(user.email, {
          userName: user.name,
          mcNumber: 'N/A',
          amount: price,
          paymentType: 'subscription',
        });
      } catch (emailError) {
        logger.error('Failed to send subscription confirmation email', { userId, error: emailError });
      }

      logger.info('Subscription payment processed successfully', {
        userId,
        plan,
        stripeSubscriptionId,
        credits: planDetails.credits,
      });
    } catch (error) {
      await t.rollback();
      logger.error('Failed to process subscription payment', { userId, error });
      throw error;
    }
  }

  /**
   * Handle subscription cancellation (from webhook or user request)
   */
  async cancelSubscription(userId: string, cancelAtPeriodEnd: boolean = true): Promise<Subscription> {
    const subscription = await Subscription.findOne({
      where: { userId },
    });

    if (!subscription) {
      throw new NotFoundError('Subscription');
    }

    if (subscription.status !== SubscriptionStatus.ACTIVE) {
      throw new ForbiddenError('No active subscription to cancel');
    }

    // Cancel in Stripe if we have a subscription ID
    const stripeSubId = (subscription as SubscriptionWithStripe).stripeSubscriptionId;
    if (stripeSubId) {
      try {
        if (cancelAtPeriodEnd) {
          await stripeService.cancelSubscription(stripeSubId);
        } else {
          // Immediate cancellation
          await stripeService.cancelSubscription(stripeSubId);
        }
      } catch (stripeError) {
        logger.error('Failed to cancel Stripe subscription', { userId, stripeSubId, error: stripeError });
        // Continue with local cancellation
      }
    }

    await subscription.update({
      status: cancelAtPeriodEnd ? SubscriptionStatus.ACTIVE : SubscriptionStatus.CANCELLED,
      cancelledAt: new Date(),
      // Keep end date to allow using remaining credits
      endDate: subscription.renewalDate,
    });

    // Send cancellation email
    const user = await User.findByPk(userId);
    if (user) {
      try {
        // You could create a specific cancellation email template
        logger.info('Subscription cancelled', { userId, cancelAtPeriodEnd });
      } catch (emailError) {
        logger.error('Failed to send cancellation email', { userId, error: emailError });
      }
    }

    return subscription;
  }

  /**
   * Handle Stripe subscription updated webhook
   */
  async handleSubscriptionUpdated(
    stripeSubscriptionId: string,
    status: string,
    currentPeriodEnd: Date
  ): Promise<void> {
    const subscription = await Subscription.findOne({
      where: { stripeSubscriptionId },
    });

    if (!subscription) {
      logger.warn('Subscription not found for update webhook', { stripeSubscriptionId });
      return;
    }

    // Map Stripe status to our status
    let newStatus: SubscriptionStatus;
    switch (status) {
      case 'active':
        newStatus = SubscriptionStatus.ACTIVE;
        break;
      case 'past_due':
        newStatus = SubscriptionStatus.PAST_DUE;
        break;
      case 'canceled':
        newStatus = SubscriptionStatus.CANCELLED;
        break;
      case 'unpaid':
        newStatus = SubscriptionStatus.EXPIRED;
        break;
      default:
        newStatus = subscription.status;
    }

    await subscription.update({
      status: newStatus,
      renewalDate: currentPeriodEnd,
    });

    logger.info('Subscription updated from webhook', {
      subscriptionId: subscription.id,
      stripeSubscriptionId,
      newStatus,
    });
  }

  // ============================================
  // One-time Credit Purchase
  // ============================================

  /**
   * Purchase credits with one-time payment
   */
  async purchaseCredits(params: PurchaseCreditsParams): Promise<{ paymentIntentId: string; clientSecret: string }> {
    const { userId, creditAmount, paymentMethodId } = params;

    const user = await User.findByPk(userId);
    if (!user) {
      throw new NotFoundError('User');
    }

    // Calculate price (use base rate - $5 per credit default)
    const pricePerCredit = 5;
    const totalPrice = creditAmount * pricePerCredit;
    const priceInCents = Math.round(totalPrice * 100);

    // Ensure user has a Stripe customer ID
    let stripeCustomerId = user.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripeService.createCustomer({
        email: user.email,
        name: user.name,
        metadata: { userId: user.id },
      });
      stripeCustomerId = customer.id;
      await user.update({ stripeCustomerId });
    }

    // Create payment intent
    const paymentIntent = await stripeService.createPaymentIntent({
      amount: priceInCents,
      currency: 'usd',
      customerId: stripeCustomerId,
      metadata: {
        type: 'credit_purchase',
        userId: user.id,
        creditAmount: String(creditAmount),
      },
    });

    logger.info('Credit purchase payment intent created', {
      userId,
      creditAmount,
      totalPrice,
      paymentIntentId: paymentIntent.paymentIntentId,
    });

    return {
      paymentIntentId: paymentIntent.paymentIntentId || '',
      clientSecret: paymentIntent.clientSecret || '',
    };
  }

  /**
   * Handle successful credit purchase (called from webhook)
   */
  async handleCreditPurchaseSuccess(
    paymentIntentId: string,
    metadata: Record<string, string>
  ): Promise<void> {
    const { userId, creditAmount, type } = metadata;

    if (type !== 'credit_purchase' || !userId || !creditAmount) {
      return;
    }

    const user = await User.findByPk(userId);
    if (!user) {
      logger.error('User not found for credit purchase webhook', { userId });
      return;
    }

    const credits = parseInt(creditAmount, 10);
    const newTotal = user.totalCredits + credits;

    const t = await sequelize.transaction();

    try {
      await user.update({ totalCredits: newTotal }, { transaction: t });

      await CreditTransaction.create(
        {
          userId,
          type: CreditTransactionType.PURCHASE,
          amount: credits,
          balance: newTotal - user.usedCredits,
          description: `Purchased ${credits} credits`,
          reference: paymentIntentId,
        },
        { transaction: t }
      );

      await Payment.create(
        {
          userId,
          type: PaymentType.CREDIT_PURCHASE,
          amount: credits * 5,
          status: PaymentStatus.COMPLETED,
          stripePaymentId: paymentIntentId,
          description: `Credit purchase - ${credits} credits`,
          completedAt: new Date(),
        },
        { transaction: t }
      );

      await t.commit();

      logger.info('Credit purchase processed successfully', { userId, credits, paymentIntentId });
    } catch (error) {
      await t.rollback();
      logger.error('Failed to process credit purchase', { userId, error });
      throw error;
    }
  }

  // ============================================
  // Legacy Subscription (without Stripe)
  // ============================================

  /**
   * Subscribe to a plan (legacy method for manual/test subscriptions)
   */
  async subscribe(
    userId: string,
    plan: SubscriptionPlan,
    isYearly: boolean,
    stripePaymentId?: string
  ) {
    // Check for existing active subscription
    const existing = await Subscription.findOne({
      where: { userId },
    });

    if (existing && existing.status === SubscriptionStatus.ACTIVE) {
      throw new ConflictError('You already have an active subscription');
    }

    // Get plan details from dynamic pricing config
    const planDetails = await this.getSubscriptionPlanConfig(plan);
    const price = isYearly ? planDetails.priceYearly : planDetails.priceMonthly;
    const renewalDate = isYearly ? addYears(new Date(), 1) : addMonths(new Date(), 1);

    // Create or update subscription
    let subscription: Subscription;
    if (existing) {
      await existing.update({
        plan,
        status: SubscriptionStatus.ACTIVE,
        priceMonthly: planDetails.priceMonthly,
        priceYearly: planDetails.priceYearly,
        isYearly,
        creditsPerMonth: planDetails.credits,
        creditsRemaining: planDetails.credits,
        startDate: new Date(),
        renewalDate,
        cancelledAt: null,
      });
      subscription = existing;
    } else {
      subscription = await Subscription.create({
        userId,
        plan,
        status: SubscriptionStatus.ACTIVE,
        priceMonthly: planDetails.priceMonthly,
        priceYearly: planDetails.priceYearly,
        isYearly,
        creditsPerMonth: planDetails.credits,
        creditsRemaining: planDetails.credits,
        renewalDate,
      });
    }

    // Add credits to user
    const user = await User.findByPk(userId);
    if (!user) throw new NotFoundError('User');

    const newTotal = user.totalCredits + planDetails.credits;

    const t = await sequelize.transaction();

    try {
      // Update user credits
      await user.update({ totalCredits: newTotal }, { transaction: t });

      // Record credit transaction
      await CreditTransaction.create(
        {
          userId,
          type: CreditTransactionType.PURCHASE,
          amount: planDetails.credits,
          balance: newTotal - user.usedCredits,
          description: `${planDetails.name} subscription - ${planDetails.credits} credits`,
          reference: subscription.id,
        },
        { transaction: t }
      );

      // Record payment
      await Payment.create(
        {
          userId,
          type: PaymentType.SUBSCRIPTION,
          amount: price,
          status: PaymentStatus.COMPLETED,
          stripePaymentId,
          description: `${planDetails.name} ${isYearly ? 'yearly' : 'monthly'} subscription`,
          completedAt: new Date(),
        },
        { transaction: t }
      );

      await t.commit();
    } catch (error) {
      await t.rollback();
      throw error;
    }

    return subscription;
  }

  // ============================================
  // Admin Operations
  // ============================================

  /**
   * Add bonus credits (admin)
   */
  async addBonusCredits(userId: string, amount: number, reason: string, adminId: string) {
    const user = await User.findByPk(userId);

    if (!user) {
      throw new NotFoundError('User');
    }

    const newTotal = user.totalCredits + amount;

    const t = await sequelize.transaction();

    try {
      await user.update({ totalCredits: newTotal }, { transaction: t });

      await CreditTransaction.create(
        {
          userId,
          type: CreditTransactionType.BONUS,
          amount,
          balance: newTotal - user.usedCredits,
          description: reason,
          reference: adminId,
        },
        { transaction: t }
      );

      await t.commit();

      logger.info('admin_add_bonus_credits', {
        adminId,
        targetUserId: userId,
        amount,
        reason,
        newBalance: newTotal - user.usedCredits,
      });
    } catch (error) {
      await t.rollback();
      throw error;
    }

    return { success: true, newBalance: newTotal - user.usedCredits };
  }

  /**
   * Refund credits
   */
  async refundCredits(userId: string, amount: number, reason: string) {
    const user = await User.findByPk(userId);

    if (!user) {
      throw new NotFoundError('User');
    }

    if (user.usedCredits < amount) {
      throw new ForbiddenError('Not enough used credits to refund');
    }

    const newUsed = user.usedCredits - amount;

    const t = await sequelize.transaction();

    try {
      await user.update({ usedCredits: newUsed }, { transaction: t });

      await CreditTransaction.create(
        {
          userId,
          type: CreditTransactionType.REFUND,
          amount,
          balance: user.totalCredits - newUsed,
          description: reason,
        },
        { transaction: t }
      );

      await t.commit();

      logger.info('Credits refunded', { userId, amount, reason });
    } catch (error) {
      await t.rollback();
      throw error;
    }

    return { success: true, newBalance: user.totalCredits - newUsed };
  }

  // ============================================
  // Scheduled Operations
  // ============================================

  /**
   * Process monthly credit renewal (called by cron job)
   * Note: With Stripe subscriptions, this is handled by webhooks
   * This method is for manual/legacy subscriptions
   */
  async processMonthlyRenewals() {
    const now = new Date();

    // Find subscriptions due for renewal (without Stripe subscription ID)
    const dueSubscriptions = await Subscription.findAll({
      where: {
        status: SubscriptionStatus.ACTIVE,
        renewalDate: { [Symbol.for('lte')]: now },
        stripeSubscriptionId: null, // Only manual subscriptions
      },
      include: [{ model: User, as: 'user' }],
    });

    const results = [];

    for (const subscription of dueSubscriptions) {
      try {
        const user = subscription.user;
        if (!user) continue;

        const newTotal = user.totalCredits + subscription.creditsPerMonth;
        const newRenewalDate = subscription.isYearly
          ? addYears(subscription.renewalDate || now, 1)
          : addMonths(subscription.renewalDate || now, 1);

        const t = await sequelize.transaction();

        try {
          await user.update({ totalCredits: newTotal }, { transaction: t });

          await subscription.update(
            {
              renewalDate: newRenewalDate,
              creditsRemaining: subscription.creditsPerMonth,
            },
            { transaction: t }
          );

          await CreditTransaction.create(
            {
              userId: subscription.userId,
              type: CreditTransactionType.PURCHASE,
              amount: subscription.creditsPerMonth,
              balance: newTotal - user.usedCredits,
              description: 'Subscription renewal',
              reference: subscription.id,
            },
            { transaction: t }
          );

          await t.commit();
          results.push({ userId: subscription.userId, success: true });

          logger.info('Manual subscription renewed', {
            userId: subscription.userId,
            credits: subscription.creditsPerMonth,
          });
        } catch (error) {
          await t.rollback();
          throw error;
        }
      } catch (error) {
        logger.error(`Failed to renew subscription for user ${subscription.userId}`, { error });
        results.push({ userId: subscription.userId, success: false, error });
      }
    }

    return results;
  }

  /**
   * Process expired subscriptions
   */
  async processExpiredSubscriptions() {
    const now = new Date();

    // Find cancelled subscriptions past their end date
    const expiredSubscriptions = await Subscription.findAll({
      where: {
        status: SubscriptionStatus.CANCELLED,
        endDate: { [Symbol.for('lte')]: now },
      },
    });

    for (const subscription of expiredSubscriptions) {
      await subscription.update({ status: SubscriptionStatus.EXPIRED });
      logger.info('Subscription expired', { subscriptionId: subscription.id, userId: subscription.userId });
    }

    return expiredSubscriptions.length;
  }

  /**
   * Grant subscription credits (used by webhooks)
   */
  async grantSubscriptionCredits(userId: string, plan: SubscriptionPlan): Promise<void> {
    // Get plan details from dynamic pricing config
    const planDetails = await this.getSubscriptionPlanConfig(plan);
    if (!planDetails) {
      logger.error('Invalid subscription plan', { userId, plan });
      return;
    }

    const credits = planDetails.credits;

    // Credits reset each month — don't roll over unused credits
    // Set totalCredits to the plan amount and reset usedCredits to 0
    const user = await User.findByPk(userId);
    if (!user) {
      logger.error('User not found for credit grant', { userId });
      return;
    }

    const t = await sequelize.transaction();
    try {
      await user.update({ totalCredits: credits, usedCredits: 0 }, { transaction: t });

      await CreditTransaction.create(
        {
          userId,
          type: CreditTransactionType.SUBSCRIPTION,
          amount: credits,
          balance: credits,
          description: `Monthly credits reset for ${plan} plan (${credits} credits)`,
        },
        { transaction: t }
      );

      await t.commit();
      logger.info('Subscription credits reset', { userId, plan, credits });
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }

  /**
   * Add credits to user account (used by webhooks)
   */
  async addCredits(
    userId: string,
    amount: number,
    type: CreditTransactionType | string = CreditTransactionType.BONUS,
    description: string = 'Credits added'
  ): Promise<void> {
    const user = await User.findByPk(userId);
    if (!user) {
      throw new NotFoundError('User');
    }

    const newTotal = user.totalCredits + amount;
    const t = await sequelize.transaction();

    try {
      await user.update({ totalCredits: newTotal }, { transaction: t });

      await CreditTransaction.create(
        {
          userId,
          type: type as CreditTransactionType,
          amount,
          balance: newTotal - user.usedCredits,
          description,
        },
        { transaction: t }
      );

      await t.commit();
      logger.info('Credits added', { userId, amount, type, newBalance: newTotal - user.usedCredits });
    } catch (error) {
      await t.rollback();
      throw error;
    }
  }
}

export const creditService = new CreditService();
export default creditService;
