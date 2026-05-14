import { Op } from 'sequelize';
import {
  CreditTransaction,
  CreditTransactionType,
  Subscription,
  SubscriptionPlan,
  SubscriptionStatus,
  User,
} from '../models';
import { hasActiveBundlePromo } from '../utils/bundlePromo';
import { sequelize } from '../models';

export type EntitlementSource = 'bundle' | 'premium' | 'enterprise' | 'vip' | 'admin' | null;

export interface CreditReportEntitlement {
  source: EntitlementSource;
  monthlyQuota: number; // 0 if no entitlement
  used: number;
  remaining: number; // monthlyQuota - used (Infinity for unlimited)
  isUnlimited: boolean;
  expiresAt: Date | null; // bundle expiry only
}

const QUOTA_BY_PLAN: Partial<Record<SubscriptionPlan, number>> = {
  [SubscriptionPlan.PREMIUM]: 5,
  [SubscriptionPlan.PROFESSIONAL]: 5, // grandfathered, treated like Premium
  [SubscriptionPlan.ENTERPRISE]: 20,
  // VIP_ACCESS is handled separately as unlimited
};

const BUNDLE_MONTHLY_QUOTA = 5;
export const FREE_PULL_REFERENCE_PREFIX = 'free_credit_pull';

/**
 * Returns the current UTC month key in YYYY-MM format. Used to namespace
 * free-credit-pull tracking rows so each month's quota is independent.
 */
export function currentMonthKey(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = (now.getUTCMonth() + 1).toString().padStart(2, '0');
  return `${y}-${m}`;
}

export function freePullReference(connectId: string, monthKey: string = currentMonthKey()): string {
  return `${FREE_PULL_REFERENCE_PREFIX}:${monthKey}:${connectId}`;
}

/**
 * Returns the user's credit-report entitlement for the current month.
 * Priority: admin > bundle promo > subscription plan tier > none.
 *
 * Note: callers that want to know if a *specific* carrier has already been
 * pulled this month (no quota burn) should additionally query
 * CreditTransaction by `freePullReference(connectId)`.
 */
export async function getCreditReportEntitlement(
  userId: string,
  opts: { isAdmin?: boolean } = {}
): Promise<CreditReportEntitlement> {
  if (opts.isAdmin) {
    return {
      source: 'admin',
      monthlyQuota: Infinity,
      used: 0,
      remaining: Infinity,
      isUnlimited: true,
      expiresAt: null,
    };
  }

  const [user, subscription] = await Promise.all([
    User.findByPk(userId, {
      attributes: ['promoAccessType', 'promoAccessExpiresAt'],
    }),
    Subscription.findOne({ where: { userId } }),
  ]);

  const bundleActive = hasActiveBundlePromo(user);
  const subActive = subscription?.status === SubscriptionStatus.ACTIVE;
  const plan = subscription?.plan as SubscriptionPlan | undefined;

  let source: EntitlementSource = null;
  let monthlyQuota = 0;
  let isUnlimited = false;
  let expiresAt: Date | null = null;

  // Bundle promo takes priority over subscription. If a user has both, the
  // bundle window is what was sold most recently and should drive the UI.
  if (bundleActive) {
    source = 'bundle';
    monthlyQuota = BUNDLE_MONTHLY_QUOTA;
    expiresAt = user?.promoAccessExpiresAt ? new Date(user.promoAccessExpiresAt) : null;
  } else if (subActive && plan === SubscriptionPlan.VIP_ACCESS) {
    source = 'vip';
    monthlyQuota = Infinity;
    isUnlimited = true;
  } else if (subActive && plan && QUOTA_BY_PLAN[plan]) {
    source = plan === SubscriptionPlan.ENTERPRISE ? 'enterprise' : 'premium';
    monthlyQuota = QUOTA_BY_PLAN[plan] as number;
  }

  if (!source) {
    return {
      source: null,
      monthlyQuota: 0,
      used: 0,
      remaining: 0,
      isUnlimited: false,
      expiresAt: null,
    };
  }

  const used = isUnlimited ? 0 : await countUsedThisMonth(userId);
  const remaining = isUnlimited ? Infinity : Math.max(0, monthlyQuota - used);

  return { source, monthlyQuota, used, remaining, isUnlimited, expiresAt };
}

async function countUsedThisMonth(userId: string, monthKey: string = currentMonthKey()): Promise<number> {
  return CreditTransaction.count({
    where: {
      userId,
      reference: { [Op.like]: `${FREE_PULL_REFERENCE_PREFIX}:${monthKey}:%` },
      type: CreditTransactionType.USAGE,
    },
  });
}

/**
 * Returns true if the user has already pulled this carrier's report for free
 * during the current month. Subsequent views in the same month don't burn
 * additional quota.
 */
export async function hasPulledThisMonth(userId: string, connectId: string): Promise<boolean> {
  const existing = await CreditTransaction.findOne({
    where: {
      userId,
      reference: freePullReference(connectId),
      type: CreditTransactionType.USAGE,
    },
  });
  return !!existing;
}

/**
 * Records a free credit-report pull for tracking. Idempotent: a second call
 * for the same (user, connectId, month) is a no-op and returns the existing
 * row. Returns { created: true } only on the first pull of the month.
 */
export async function recordFreePull(
  userId: string,
  connectId: string,
  source: Exclude<EntitlementSource, null>
): Promise<{ created: boolean }> {
  const reference = freePullReference(connectId);

  const t = await sequelize.transaction();
  try {
    const existing = await CreditTransaction.findOne({
      where: { userId, reference, type: CreditTransactionType.USAGE },
      transaction: t,
    });
    if (existing) {
      await t.commit();
      return { created: false };
    }

    const user = await User.findByPk(userId, { transaction: t });
    const balance = user ? user.totalCredits - user.usedCredits : 0;

    await CreditTransaction.create(
      {
        userId,
        type: CreditTransactionType.USAGE,
        amount: 0,
        balance,
        description: `Free Creditsafe credit report (${source})`,
        reference,
      },
      { transaction: t }
    );
    await t.commit();
    return { created: true };
  } catch (err) {
    await t.rollback();
    throw err;
  }
}

/**
 * Public-friendly shape for API responses. Converts Infinity to null so it
 * serializes cleanly through JSON.
 */
export function entitlementForApi(e: CreditReportEntitlement) {
  return {
    source: e.source,
    monthlyQuota: e.isUnlimited ? null : e.monthlyQuota,
    used: e.used,
    remaining: e.isUnlimited ? null : e.remaining,
    isUnlimited: e.isUnlimited,
    expiresAt: e.expiresAt,
  };
}
