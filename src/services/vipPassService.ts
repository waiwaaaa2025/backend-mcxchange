import Stripe from 'stripe';
import { creditService } from './creditService';
import { emailService } from './emailService';
import { notificationService } from './notificationService';
import {
  User,
  Payment,
  Subscription,
  PaymentStatus,
  PaymentType,
  SubscriptionPlan,
  SubscriptionStatus,
  NotificationType,
} from '../models';
import logger from '../utils/logger';

/**
 * Fulfil a completed VIP / Deal Access Pass purchase ($399 one-time, mode: 'payment').
 *
 * The pass is NOT a recurring Stripe subscription, so customer.subscription.*
 * events never fire for it and `stripe.subscriptions.list` never returns it.
 * This function records an ACTIVE VIP_ACCESS subscription row (which the
 * entitlement + access gates key off), grants CarrierPulse access, resets
 * credits to the VIP allotment, and records the payment.
 *
 * It is called from TWO places and must stay idempotent:
 *   1. The Stripe webhook (checkout.session.completed, metadata.type === 'vip_pass_purchase')
 *   2. The synchronous verify/fulfil fallback (buyerService.verifyAndFulfillSubscription),
 *      so a VIP buyer is not stranded when the webhook is delayed or never lands.
 *
 * Idempotency: we skip if the user already has an active VIP_ACCESS row. The
 * webhook layer additionally guards on event id (ProcessedWebhookEvent).
 *
 * @returns true if a VIP_ACCESS row is active for the user after this call.
 */
export async function fulfillVipPassPurchase(session: Stripe.Checkout.Session): Promise<boolean> {
  const userId = session.metadata?.userId;
  if (!userId) {
    logger.warn('VIP pass checkout missing userId metadata', { sessionId: session.id });
    return false;
  }

  const user = await User.findByPk(userId);
  if (!user) {
    logger.error('User not found for VIP pass purchase', { userId, sessionId: session.id });
    return false;
  }

  const existing = await Subscription.findOne({ where: { userId } });
  if (existing && existing.status === SubscriptionStatus.ACTIVE && existing.plan === SubscriptionPlan.VIP_ACCESS) {
    logger.info('VIP pass already active for user, skipping', { userId, sessionId: session.id });
    return true;
  }

  // VIP_ACCESS is not in the SUBSCRIPTION_PLANS map; pull its config from the
  // pricing service (credits=999 "unlimited unlocks until purchase", price=399).
  const planConfig = await creditService.getSubscriptionPlanConfig(SubscriptionPlan.VIP_ACCESS);

  // One-time pass — no recurring period. Set a far-future renewal date so the
  // subscription reads as active "until purchase" (admin cancels on completion).
  const renewalDate = new Date(Date.now() + 100 * 365 * 24 * 60 * 60 * 1000);
  const stripeCustomerId = (session.customer as string) || user.stripeCustomerId || null;

  if (existing) {
    await existing.update({
      plan: SubscriptionPlan.VIP_ACCESS,
      status: SubscriptionStatus.ACTIVE,
      priceMonthly: planConfig.priceMonthly,
      priceYearly: planConfig.priceYearly,
      isYearly: false,
      creditsPerMonth: planConfig.credits,
      creditsRemaining: planConfig.credits,
      startDate: new Date(),
      renewalDate,
      stripeSubId: null,
      stripeCustomerId,
      cancelledAt: null,
    } as any);
  } else {
    await Subscription.create({
      userId,
      plan: SubscriptionPlan.VIP_ACCESS,
      status: SubscriptionStatus.ACTIVE,
      priceMonthly: planConfig.priceMonthly,
      priceYearly: planConfig.priceYearly,
      isYearly: false,
      creditsPerMonth: planConfig.credits,
      creditsRemaining: planConfig.credits,
      renewalDate,
      stripeSubId: null,
      stripeCustomerId,
    } as any);
  }

  // Grant CarrierPulse access and persist the Stripe customer id if it changed.
  await user.update({
    carrierPulseAccess: true,
    ...(stripeCustomerId && stripeCustomerId !== user.stripeCustomerId
      ? { stripeCustomerId }
      : {}),
  });

  // Reset credit balance to the VIP allotment (unlimited listing unlocks).
  await creditService.grantSubscriptionCredits(userId, SubscriptionPlan.VIP_ACCESS);

  // Record the payment for traceability (idempotent on stripePaymentId).
  const stripePaymentId = (session.payment_intent as string) || session.id;
  const amount = session.amount_total ? session.amount_total / 100 : planConfig.priceMonthly;
  const existingPayment = await Payment.findOne({ where: { stripePaymentId } });
  if (!existingPayment) {
    await Payment.create({
      userId,
      type: PaymentType.SUBSCRIPTION,
      amount,
      status: PaymentStatus.COMPLETED,
      stripePaymentId,
      description: 'VIP / Deal Access Pass (one-time)',
      completedAt: new Date(),
    } as any);
  }

  logger.info('VIP pass purchase fulfilled', { userId, sessionId: session.id, amount });

  await notificationService.create({
    userId,
    type: NotificationType.SYSTEM,
    title: 'VIP Access Activated',
    message: 'Your VIP / Deal Access Pass is active. CarrierPulse and 20 company credit reports/mo are now included.',
    link: '/buyer/subscription',
  });

  await emailService.sendPaymentReceived(user.email, {
    userName: user.name,
    mcNumber: 'N/A',
    amount,
    paymentType: 'VIP / Deal Access Pass',
  });

  return true;
}
