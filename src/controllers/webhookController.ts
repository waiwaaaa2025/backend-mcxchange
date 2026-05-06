import { Request, Response } from 'express';
import Stripe from 'stripe';
import { stripeService } from '../services/stripeService';
import { creditService } from '../services/creditService';
import { emailService } from '../services/emailService';
import { notificationService } from '../services/notificationService';
import {
  User,
  Payment,
  Subscription,
  Transaction,
  Listing,
  PaymentStatus,
  PaymentType,
  SubscriptionPlan,
  TransactionStatus,
  ListingStatus,
  NotificationType,
  ProcessedWebhookEvent,
  CreditTransaction,
  CreditTransactionType,
} from '../models';
import logger, { logError } from '../utils/logger';
import { config } from '../config';

// ============================================
// Webhook Idempotency Helpers
// ============================================

/**
 * Check if a webhook event has already been processed
 * @param eventId - The Stripe event ID
 * @returns true if already processed, false otherwise
 */
async function isEventAlreadyProcessed(eventId: string): Promise<boolean> {
  const existing = await ProcessedWebhookEvent.findOne({
    where: { eventId },
  });
  return !!existing;
}

/**
 * Record a webhook event as processed
 * @param eventId - The Stripe event ID
 * @param eventType - The type of event (e.g., 'customer.subscription.created')
 */
async function markEventAsProcessed(eventId: string, eventType: string): Promise<void> {
  await ProcessedWebhookEvent.create({
    eventId,
    eventType,
    processedAt: new Date(),
  });
}

// ============================================
// Stripe Webhook Handler
// ============================================

export const handleStripeWebhook = async (req: Request, res: Response): Promise<void> => {
  const signature = req.headers['stripe-signature'] as string;

  if (!signature) {
    logger.warn('Webhook received without signature');
    res.status(400).json({ error: 'Missing stripe-signature header' });
    return;
  }

  // Construct and verify the event
  const event = stripeService.constructWebhookEvent(req.body, signature);

  if (!event) {
    res.status(400).json({ error: 'Invalid webhook signature' });
    return;
  }

  logger.info('Stripe webhook received', {
    type: event.type,
    eventId: event.id,
  });

  // Check for idempotency - skip if already processed
  const alreadyProcessed = await isEventAlreadyProcessed(event.id);
  if (alreadyProcessed) {
    logger.info('Webhook event already processed, skipping', {
      type: event.type,
      eventId: event.id,
    });
    res.json({ received: true, skipped: true });
    return;
  }

  try {
    // Handle different event types
    switch (event.type) {
      // Payment Intent Events
      case 'payment_intent.succeeded':
        await handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent);
        break;

      case 'payment_intent.payment_failed':
        await handlePaymentIntentFailed(event.data.object as Stripe.PaymentIntent);
        break;

      // Subscription Events
      case 'customer.subscription.created':
        await handleSubscriptionCreated(event.data.object as Stripe.Subscription);
        break;

      case 'customer.subscription.updated':
        await handleSubscriptionUpdated(event.data.object as Stripe.Subscription);
        break;

      case 'customer.subscription.deleted':
        await handleSubscriptionDeleted(event.data.object as Stripe.Subscription);
        break;

      // Invoice Events
      case 'invoice.paid':
        await handleInvoicePaid(event.data.object as Stripe.Invoice);
        break;

      case 'invoice.payment_failed':
        await handleInvoicePaymentFailed(event.data.object as Stripe.Invoice);
        break;

      // Checkout Session Events
      case 'checkout.session.completed':
        await handleCheckoutSessionCompleted(event.data.object as Stripe.Checkout.Session);
        break;

      // Charge Events
      case 'charge.refunded':
        await handleChargeRefunded(event.data.object as Stripe.Charge);
        break;

      case 'charge.dispute.created':
        await handleChargeDisputeCreated(event.data.object as Stripe.Dispute);
        break;

      // Identity Verification Events
      case 'identity.verification_session.verified':
        await handleIdentityVerified(event.data.object as any);
        break;

      case 'identity.verification_session.requires_input':
        await handleIdentityRequiresInput(event.data.object as any);
        break;

      default:
        logger.debug('Unhandled webhook event type', { type: event.type });
    }

    // Mark event as processed for idempotency
    await markEventAsProcessed(event.id, event.type);

    res.json({ received: true });
  } catch (error) {
    logError('Webhook handler error', error as Error, {
      type: event.type,
      eventId: event.id,
    });
    res.status(500).json({ error: 'Webhook handler error' });
  }
};

// ============================================
// Payment Intent Handlers
// ============================================

async function handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent): Promise<void> {
  logger.info('Payment intent succeeded', {
    paymentIntentId: paymentIntent.id,
    amount: paymentIntent.amount,
  });

  const metadata = paymentIntent.metadata;
  const userId = metadata?.userId;
  const paymentType = metadata?.paymentType as PaymentType;
  const transactionId = metadata?.transactionId;
  const paymentId = metadata?.paymentId;

  if (!userId) {
    logger.warn('Payment intent missing userId metadata', {
      paymentIntentId: paymentIntent.id,
    });
    return;
  }

  // Get user
  const user = await User.findByPk(userId);
  if (!user) {
    logger.error('User not found for payment', { userId });
    return;
  }

  // Update payment record if exists
  if (paymentId) {
    await Payment.update(
      {
        status: PaymentStatus.COMPLETED,
        stripePaymentIntentId: paymentIntent.id,
        paidAt: new Date(),
      },
      { where: { id: paymentId } }
    );
  }

  // Handle based on payment type
  switch (paymentType) {
    case PaymentType.DEPOSIT:
      await handleDepositPayment(transactionId, user, paymentIntent.amount);
      break;

    case PaymentType.FINAL_PAYMENT:
      await handleFinalPayment(transactionId, user, paymentIntent.amount);
      break;

    case PaymentType.CREDIT_PURCHASE:
      const credits = parseInt(metadata?.credits || '0');
      await handleCreditPurchase(user, credits, paymentIntent.amount);
      break;

    case PaymentType.LISTING_FEE:
      // Listing fee paid - listing can be activated
      const listingId = metadata?.listingId;
      if (listingId) {
        logger.info('Listing fee paid', { listingId, userId });
        // TODO: Update listing status if needed
      }
      break;

    default:
      logger.info('Payment completed without specific handler', {
        paymentType,
        paymentIntentId: paymentIntent.id,
      });
  }

  // Send email notification
  await emailService.sendPaymentReceived(user.email, {
    userName: user.name,
    mcNumber: metadata?.mcNumber || 'N/A',
    amount: stripeService.centsToDollars(paymentIntent.amount),
    paymentType: paymentType as string || 'payment',
    transactionUrl: transactionId
      ? `${config.frontendUrl}/transactions/${transactionId}`
      : undefined,
  });
}

async function handlePaymentIntentFailed(paymentIntent: Stripe.PaymentIntent): Promise<void> {
  logger.warn('Payment intent failed', {
    paymentIntentId: paymentIntent.id,
    failureCode: paymentIntent.last_payment_error?.code,
    failureMessage: paymentIntent.last_payment_error?.message,
  });

  const metadata = paymentIntent.metadata;
  const userId = metadata?.userId;
  const paymentId = metadata?.paymentId;

  // Update payment record
  if (paymentId) {
    await Payment.update(
      {
        status: PaymentStatus.FAILED,
        failureReason: paymentIntent.last_payment_error?.message,
      },
      { where: { id: paymentId } }
    );
  }

  // Notify user
  if (userId) {
    await notificationService.create({
      userId,
      type: 'PAYMENT' as any,
      title: 'Payment Failed',
      message: 'Your payment could not be processed. Please try again or use a different payment method.',
      metadata: { paymentIntentId: paymentIntent.id },
    });
  }
}

// ============================================
// Subscription Handlers
// ============================================

async function handleSubscriptionCreated(subscription: Stripe.Subscription): Promise<void> {
  logger.info('Subscription created', {
    subscriptionId: subscription.id,
    customerId: subscription.customer,
  });

  const userId = subscription.metadata?.userId;
  if (!userId) {
    logger.warn('Subscription created without userId metadata');
    return;
  }

  // CarrierPulse standalone subscription — mark access on user
  if (subscription.metadata?.type === 'carrier_pulse') {
    await User.update(
      { carrierPulseAccess: true, carrierPulseStripeSubId: subscription.id },
      { where: { id: userId } }
    );
    logger.info('CarrierPulse access granted', { userId, subscriptionId: subscription.id });
    return;
  }

  // Update or create subscription record in our database
  const plan = subscription.metadata?.plan as SubscriptionPlan || SubscriptionPlan.STARTER;

  await Subscription.upsert({
    userId,
    stripeSubId: subscription.id,
    stripeCustomerId: subscription.customer as string,
    plan,
    status: subscription.status,
    currentPeriodStart: new Date((subscription as any).current_period_start * 1000),
    currentPeriodEnd: new Date((subscription as any).current_period_end * 1000),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
  });

  // Grant initial credits
  await creditService.grantSubscriptionCredits(userId, plan);
}

async function handleSubscriptionUpdated(subscription: Stripe.Subscription): Promise<void> {
  logger.info('Subscription updated', {
    subscriptionId: subscription.id,
    status: subscription.status,
  });

  // Find subscription in our database
  const dbSubscription = await Subscription.findOne({
    where: { stripeSubId: subscription.id },
  });

  if (!dbSubscription) {
    logger.warn('Subscription not found in database', {
      subscriptionId: subscription.id,
    });
    return;
  }

  // Update subscription record
  await dbSubscription.update({
    status: subscription.status,
    currentPeriodStart: new Date((subscription as any).current_period_start * 1000),
    currentPeriodEnd: new Date((subscription as any).current_period_end * 1000),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    canceledAt: subscription.canceled_at
      ? new Date(subscription.canceled_at * 1000)
      : null,
  });

  // If subscription was renewed (new period started)
  if (subscription.status === 'active') {
    // Check if this is a renewal (billing_reason in invoice event is better)
    // Credits are usually granted via invoice.paid event
  }
}

async function handleSubscriptionDeleted(subscription: Stripe.Subscription): Promise<void> {
  logger.info('Subscription deleted', {
    subscriptionId: subscription.id,
  });

  // Find and update subscription in our database
  const dbSubscription = await Subscription.findOne({
    where: { stripeSubId: subscription.id },
  });

  if (dbSubscription) {
    await dbSubscription.update({
      status: 'canceled',
      canceledAt: new Date(),
    });

    // Notify user
    await notificationService.create({
      userId: dbSubscription.userId,
      type: 'PAYMENT' as any,
      title: 'Subscription Cancelled',
      message: 'Your subscription has been cancelled. You will retain access until the end of your billing period.',
    });
  }
}

// ============================================
// Invoice Handlers
// ============================================

async function handleInvoicePaid(invoice: Stripe.Invoice): Promise<void> {
  logger.info('Invoice paid', {
    invoiceId: invoice.id,
    amount: invoice.amount_paid,
    billingReason: invoice.billing_reason,
  });

  const subscription = (invoice as any).subscription;
  if (!subscription) return;

  // Find subscription in our database
  const dbSubscription = await Subscription.findOne({
    where: {
      stripeSubId: typeof subscription === 'string' ? subscription : subscription.id,
    },
  });

  if (!dbSubscription) return;

  // If this is a renewal (not first invoice), grant monthly credits
  if (invoice.billing_reason === 'subscription_cycle') {
    await creditService.grantSubscriptionCredits(
      dbSubscription.userId,
      dbSubscription.plan as SubscriptionPlan
    );

    logger.info('Monthly credits granted for subscription renewal', {
      userId: dbSubscription.userId,
      plan: dbSubscription.plan,
    });
  }
}

async function handleInvoicePaymentFailed(invoice: Stripe.Invoice): Promise<void> {
  logger.warn('Invoice payment failed', {
    invoiceId: invoice.id,
    customerId: invoice.customer,
  });

  const subscription = (invoice as any).subscription;
  if (!subscription) return;

  // Find subscription in our database
  const dbSubscription = await Subscription.findOne({
    where: {
      stripeSubId: typeof subscription === 'string' ? subscription : subscription.id,
    },
  });

  if (dbSubscription) {
    // Notify user
    await notificationService.create({
      userId: dbSubscription.userId,
      type: 'PAYMENT' as any,
      title: 'Payment Failed',
      message: 'Your subscription payment failed. Please update your payment method to avoid service interruption.',
    });
  }
}

// ============================================
// Charge Handlers
// ============================================

async function handleChargeRefunded(charge: Stripe.Charge): Promise<void> {
  logger.info('Charge refunded', {
    chargeId: charge.id,
    amount: charge.amount_refunded,
  });

  // Find payment by stripe payment intent
  const paymentIntentId = typeof charge.payment_intent === 'string'
    ? charge.payment_intent
    : charge.payment_intent?.id;

  if (paymentIntentId) {
    await Payment.update(
      { status: PaymentStatus.REFUNDED },
      { where: { stripePaymentIntentId: paymentIntentId } }
    );
  }
}

async function handleChargeDisputeCreated(dispute: Stripe.Dispute): Promise<void> {
  logger.warn('Charge dispute created', {
    disputeId: dispute.id,
    chargeId: dispute.charge,
    reason: dispute.reason,
    amount: dispute.amount,
  });

  // This is a serious event - notify admin
  // TODO: Implement admin notification system
}

// ============================================
// Checkout Session Handlers
// ============================================

async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
  logger.info('Checkout session completed', {
    sessionId: session.id,
    paymentStatus: session.payment_status,
  });

  // Only process if payment was successful
  if (session.payment_status !== 'paid') {
    logger.info('Checkout session not yet paid', { sessionId: session.id });
    return;
  }

  const metadata = session.metadata;
  const type = metadata?.type;

  // Handle deposit payments from checkout
  if (type === 'deposit') {
    const transactionId = metadata?.transactionId;
    const buyerId = metadata?.buyerId;
    const mcNumber = metadata?.mcNumber;

    if (!transactionId || !buyerId) {
      logger.warn('Deposit checkout missing required metadata', {
        sessionId: session.id,
        metadata,
      });
      return;
    }

    // Get buyer
    const buyer = await User.findByPk(buyerId);
    if (!buyer) {
      logger.error('Buyer not found for deposit payment', { buyerId });
      return;
    }

    // Update transaction status
    const transaction = await Transaction.findByPk(transactionId);
    if (transaction && transaction.status === TransactionStatus.AWAITING_DEPOSIT) {
      const amountPaid = session.amount_total ? session.amount_total / 100 : 1000;

      await transaction.update({
        status: TransactionStatus.DEPOSIT_RECEIVED,
        depositAmount: amountPaid,
        depositPaidAt: new Date(),
      });

      logger.info('Transaction deposit received via checkout', {
        transactionId,
        amount: amountPaid,
        buyerId,
      });

      // Notify seller
      await notificationService.notifyTransactionStatus(
        transaction.sellerId,
        'Deposit Received',
        `The buyer has paid the $${amountPaid.toLocaleString()} deposit for MC #${mcNumber || 'N/A'}.`,
        transactionId
      );

      // Notify buyer
      await notificationService.notifyTransactionStatus(
        buyerId,
        'Deposit Confirmed',
        `Your deposit of $${amountPaid.toLocaleString()} has been received. The transaction room is now active.`,
        transactionId
      );

      // Send email to buyer
      await emailService.sendPaymentReceived(buyer.email, {
        userName: buyer.name,
        mcNumber: mcNumber || 'N/A',
        amount: amountPaid,
        paymentType: 'deposit',
        transactionUrl: `${config.frontendUrl}/transaction/${transactionId}`,
      });
    } else {
      logger.warn('Transaction not found or not awaiting deposit', {
        transactionId,
        currentStatus: transaction?.status,
      });
    }
  }

  // Handle listing fee payments from checkout
  if (type === 'listing_fee') {
    const mcNumber = metadata?.mcNumber;
    const sellerId = metadata?.sellerId;

    if (!mcNumber || !sellerId) {
      logger.warn('Listing fee checkout missing required metadata', {
        sessionId: session.id,
        metadata,
      });
      return;
    }

    // Find the listing by mcNumber and sellerId (only update DRAFT listings)
    const listing = await Listing.findOne({
      where: {
        mcNumber,
        sellerId,
        status: ListingStatus.DRAFT,
      },
    });

    if (listing) {
      await listing.update({ listingFeePaid: true });

      logger.info('Listing fee paid - listing marked as paid', {
        listingId: listing.id,
        mcNumber,
        sellerId,
      });

      // Get seller for notification
      const seller = await User.findByPk(sellerId);

      if (seller) {
        // Notify seller
        await notificationService.create({
          userId: sellerId,
          type: NotificationType.SYSTEM,
          title: 'Listing Fee Paid',
          message: `Your listing fee for MC #${mcNumber} has been processed. You can now submit your listing for review.`,
          link: '/seller/listings',
        });

        // Send email to seller
        await emailService.sendPaymentReceived(seller.email, {
          userName: seller.name,
          mcNumber,
          amount: session.amount_total ? session.amount_total / 100 : 35,
          paymentType: 'listing fee',
          transactionUrl: `${config.frontendUrl}/seller/listings`,
        });
      }
    } else {
      logger.warn('Listing not found for fee payment (or not in DRAFT status)', {
        mcNumber,
        sellerId,
      });
    }
  }

  // Handle final payment via Stripe Connect split
  if (type === 'final_payment') {
    const transactionId = metadata?.transactionId;
    const buyerId = metadata?.buyerId;
    const sellerId = metadata?.sellerId;
    const mcNumber = metadata?.mcNumber;

    if (!transactionId || !buyerId || !sellerId) {
      logger.warn('Final payment checkout missing required metadata', {
        sessionId: session.id,
        metadata,
      });
      return;
    }

    const transaction = await Transaction.findByPk(transactionId);
    if (transaction && transaction.status === TransactionStatus.PAYMENT_PENDING) {
      const amountPaid = session.amount_total ? session.amount_total / 100 : 0;
      const sellerPayoutCents = parseInt(metadata?.sellerPayout || '0');
      const applicationFeeCents = parseInt(metadata?.applicationFee || '0');

      await transaction.update({
        status: TransactionStatus.PAYMENT_RECEIVED,
        finalPaymentAmount: amountPaid,
        finalPaidAt: new Date(),
        finalPaymentMethod: 'STRIPE' as any,
        sellerPayout: sellerPayoutCents / 100,
        platformFee: applicationFeeCents / 100,
      });

      // Create Payment record
      await Payment.create({
        type: PaymentType.FINAL_PAYMENT,
        amount: amountPaid,
        status: PaymentStatus.COMPLETED,
        method: 'STRIPE',
        stripePaymentId: session.payment_intent as string,
        description: `Final payment for MC #${mcNumber || 'N/A'} via Stripe Connect`,
        completedAt: new Date(),
        transactionId,
        userId: buyerId,
      });

      logger.info('Final payment received via Stripe Connect', {
        transactionId,
        amount: amountPaid,
        sellerPayout: sellerPayoutCents / 100,
        platformFee: applicationFeeCents / 100,
        buyerId,
        sellerId,
      });

      // Get buyer and seller for notifications
      const buyer = await User.findByPk(buyerId);
      const seller = await User.findByPk(sellerId);

      // Notify seller
      await notificationService.notifyTransactionStatus(
        sellerId,
        'Final Payment Received',
        `The buyer has completed the final payment of $${amountPaid.toLocaleString()} for MC #${mcNumber || 'N/A'}. Funds will be deposited to your connected account.`,
        transactionId
      );

      // Notify buyer
      await notificationService.notifyTransactionStatus(
        buyerId,
        'Payment Confirmed',
        `Your payment of $${amountPaid.toLocaleString()} for MC #${mcNumber || 'N/A'} has been processed. The admin will complete the transfer shortly.`,
        transactionId
      );

      // Send email to buyer
      if (buyer) {
        await emailService.sendPaymentReceived(buyer.email, {
          userName: buyer.name,
          mcNumber: mcNumber || 'N/A',
          amount: amountPaid,
          paymentType: 'final payment',
          transactionUrl: `${config.frontendUrl}/transaction/${transactionId}`,
        });
      }

      // Send email to seller
      if (seller) {
        await emailService.sendPaymentReceived(seller.email, {
          userName: seller.name,
          mcNumber: mcNumber || 'N/A',
          amount: sellerPayoutCents / 100,
          paymentType: 'seller payout',
          transactionUrl: `${config.frontendUrl}/transaction/${transactionId}`,
        });
      }
    } else {
      logger.warn('Transaction not found or not in PAYMENT_PENDING status for final payment', {
        transactionId,
        currentStatus: transaction?.status,
      });
    }
  }

  // Handle credit pack purchases from checkout
  if (type === 'credit_pack') {
    const userId = metadata?.userId;
    const credits = parseInt(metadata?.credits || '0');
    const packId = metadata?.packId;

    if (!userId || credits <= 0) {
      logger.warn('Credit pack checkout missing required metadata', {
        sessionId: session.id,
        metadata,
      });
      return;
    }

    // Get user
    const user = await User.findByPk(userId);
    if (!user) {
      logger.error('User not found for credit pack purchase', { userId });
      return;
    }

    // Add credits to user
    await creditService.addCredits(
      userId,
      credits,
      'PURCHASE',
      `Credit pack purchase - ${credits} credits`
    );

    logger.info('Credit pack purchase completed', {
      userId,
      credits,
      packId,
      sessionId: session.id,
    });

    // Notify user
    await notificationService.create({
      userId,
      type: NotificationType.SYSTEM,
      title: 'Credits Added',
      message: `${credits} credits have been added to your account.`,
      link: '/buyer/subscription',
    });

    // Send email to user
    await emailService.sendPaymentReceived(user.email, {
      userName: user.name,
      mcNumber: 'N/A',
      amount: session.amount_total ? session.amount_total / 100 : 0,
      paymentType: 'credit pack',
    });
  }

  // Handle one-time credit report purchases ($35)
  if (type === 'credit_report_purchase') {
    const userId = metadata?.userId;
    const connectId = metadata?.connectId;
    const companyName = metadata?.companyName;

    if (!userId || !connectId) {
      logger.warn('Credit report purchase checkout missing required metadata', {
        sessionId: session.id,
        metadata,
      });
      return;
    }

    // Record purchase as a credit transaction for tracking
    const reference = `credit_report_purchase:${connectId}`;
    const existing = await CreditTransaction.findOne({
      where: { userId, reference, type: CreditTransactionType.USAGE },
    });

    if (!existing) {
      await CreditTransaction.create({
        userId,
        amount: 0, // No credits deducted — paid via Stripe
        type: CreditTransactionType.USAGE,
        description: `Credit report purchased for ${companyName || connectId}`,
        reference,
      });
    }

    logger.info('Credit report purchase completed', {
      userId,
      connectId,
      companyName,
      sessionId: session.id,
    });

    // Notify user
    const user = await User.findByPk(userId);
    if (user) {
      await notificationService.create({
        userId,
        type: NotificationType.SYSTEM,
        title: 'Credit Report Purchased',
        message: `Your credit report for ${companyName || 'the requested company'} is now available.`,
        link: `/buyer/creditsafe?connectId=${connectId}`,
      });
    }
  }
}

// ============================================
// Identity Verification Handlers
// ============================================

async function handleIdentityVerified(session: any): Promise<void> {
  const userId = session.metadata?.userId;
  if (!userId) {
    logger.warn('Identity verification session missing userId metadata', {
      sessionId: session.id,
    });
    return;
  }

  const user = await User.findByPk(userId);
  if (!user) {
    logger.error('User not found for identity verification', { userId });
    return;
  }

  // Update user as verified
  const newTrustScore = Math.min((user.trustScore || 50) + 15, 100);
  await user.update({
    identityVerified: true,
    identityVerifiedAt: new Date(),
    identityVerificationStatus: 'verified',
    trustScore: newTrustScore,
  });

  logger.info('User identity verified via webhook', {
    userId,
    sessionId: session.id,
    newTrustScore,
  });

  // Send notification
  await notificationService.create({
    userId,
    type: NotificationType.VERIFICATION,
    title: 'Identity Verified',
    message: 'Your identity has been successfully verified. You now have full access to all platform features.',
    link: '/settings',
  });

  // Send email
  await emailService.sendEmail({
    to: user.email,
    subject: 'Identity Verification Successful - Domilea',
    html: `
      <h2>Identity Verified</h2>
      <p>Hi ${user.name},</p>
      <p>Your identity has been successfully verified on Domilea. You now have full access to all platform features including:</p>
      <ul>
        <li>Viewing MC Authority details</li>
        <li>Making and receiving offers</li>
        <li>Sending messages</li>
        <li>Purchasing credits</li>
      </ul>
      <p>Thank you for helping us maintain a safe and trustworthy marketplace.</p>
    `,
  });
}

async function handleIdentityRequiresInput(session: any): Promise<void> {
  const userId = session.metadata?.userId;
  if (!userId) {
    logger.warn('Identity verification requires_input session missing userId metadata', {
      sessionId: session.id,
    });
    return;
  }

  const user = await User.findByPk(userId);
  if (!user) {
    logger.error('User not found for identity verification requires_input', { userId });
    return;
  }

  await user.update({
    identityVerificationStatus: 'requires_input',
  });

  logger.info('Identity verification requires input', {
    userId,
    sessionId: session.id,
    lastError: session.last_error,
  });

  // Send notification to retry
  await notificationService.create({
    userId,
    type: NotificationType.VERIFICATION,
    title: 'Identity Verification Needs Attention',
    message: 'Your identity verification could not be completed. Please try again with a clear photo of your government ID.',
    link: '/settings',
  });
}

// ============================================
// Helper Functions
// ============================================

async function handleDepositPayment(
  transactionId: string | undefined,
  user: User,
  amountCents: number
): Promise<void> {
  if (!transactionId) return;

  // Update transaction status
  const transaction = await Transaction.findByPk(transactionId);
  if (transaction && transaction.status === TransactionStatus.AWAITING_DEPOSIT) {
    await transaction.update({
      status: TransactionStatus.DEPOSIT_RECEIVED,
      depositAmount: stripeService.centsToDollars(amountCents),
      depositPaidAt: new Date(),
    });

    logger.info('Transaction deposit received', {
      transactionId,
      amount: stripeService.centsToDollars(amountCents),
    });

    // Notify seller
    await notificationService.notifyTransactionStatus(
      transaction.sellerId,
      'Deposit Received',
      `The buyer has paid the deposit for your MC listing.`,
      transactionId
    );
  }
}

async function handleFinalPayment(
  transactionId: string | undefined,
  user: User,
  amountCents: number
): Promise<void> {
  if (!transactionId) return;

  // Update transaction status
  const transaction = await Transaction.findByPk(transactionId);
  if (transaction && transaction.status === TransactionStatus.PAYMENT_PENDING) {
    await transaction.update({
      status: TransactionStatus.PAYMENT_RECEIVED,
      finalPaymentAmount: stripeService.centsToDollars(amountCents),
      finalPaymentPaidAt: new Date(),
    });

    logger.info('Transaction final payment received', {
      transactionId,
      amount: stripeService.centsToDollars(amountCents),
    });

    // Notify both parties
    await notificationService.notifyTransactionStatus(
      transaction.sellerId,
      'Final Payment Received',
      'The buyer has completed the final payment. The transaction is being finalized.',
      transactionId
    );

    await notificationService.notifyTransactionStatus(
      transaction.buyerId,
      'Payment Confirmed',
      'Your payment has been confirmed. The MC authority transfer will be processed shortly.',
      transactionId
    );
  }
}

async function handleCreditPurchase(
  user: User,
  credits: number,
  amountCents: number
): Promise<void> {
  if (credits <= 0) {
    logger.warn('Invalid credit purchase amount', { credits });
    return;
  }

  // Add credits to user
  await creditService.addCredits(
    user.id,
    credits,
    'PURCHASE',
    `Purchased ${credits} credits`
  );

  logger.info('Credits purchased', {
    userId: user.id,
    credits,
    amount: stripeService.centsToDollars(amountCents),
  });
}

export default {
  handleStripeWebhook,
};
