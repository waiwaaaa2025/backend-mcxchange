/**
 * Credit Service Unit Tests
 */

// Mock dependencies before importing the service
jest.mock('../../../models', () => ({
  User: {
    findByPk: jest.fn(),
    findOne: jest.fn(),
  },
  Subscription: {
    findOne: jest.fn(),
    findAll: jest.fn(),
    create: jest.fn(),
  },
  CreditTransaction: {
    findAndCountAll: jest.fn(),
    create: jest.fn(),
  },
  Payment: {
    create: jest.fn(),
  },
  SubscriptionPlan: {
    PACKAGE_TOOL: 'PACKAGE_TOOL',
    PROFESSIONAL: 'PROFESSIONAL',
    STARTER: 'STARTER',
    PREMIUM: 'PREMIUM',
    ENTERPRISE: 'ENTERPRISE',
  },
  SubscriptionStatus: {
    ACTIVE: 'active',
    CANCELLED: 'cancelled',
    EXPIRED: 'expired',
    PAST_DUE: 'past_due',
  },
  CreditTransactionType: {
    PURCHASE: 'purchase',
    USAGE: 'usage',
    BONUS: 'bonus',
    REFUND: 'refund',
  },
  PaymentStatus: {
    COMPLETED: 'completed',
    PENDING: 'pending',
    FAILED: 'failed',
  },
  PaymentType: {
    SUBSCRIPTION: 'subscription',
    CREDIT_PURCHASE: 'credit_purchase',
  },
}));

jest.mock('../../../config/database', () => ({
  __esModule: true,
  default: {
    transaction: jest.fn().mockImplementation(async (callback) => {
      if (typeof callback === 'function') {
        const mockTransaction = {
          commit: jest.fn(),
          rollback: jest.fn(),
        };
        await callback(mockTransaction);
        return mockTransaction;
      }
      return {
        commit: jest.fn(),
        rollback: jest.fn(),
      };
    }),
  },
}));

jest.mock('../../../types', () => ({
  SUBSCRIPTION_PLANS: {
    STARTER: {
      name: 'Starter',
      credits: 5,
      priceMonthly: 29,
      priceYearly: 290,
      stripePriceIdMonthly: 'price_starter_monthly',
      stripePriceIdYearly: 'price_starter_yearly',
    },
    PREMIUM: {
      name: 'Premium',
      credits: 15,
      priceMonthly: 79,
      priceYearly: 790,
      stripePriceIdMonthly: 'price_pro_monthly',
      stripePriceIdYearly: 'price_pro_yearly',
    },
    ENTERPRISE: {
      name: 'Enterprise',
      credits: 50,
      priceMonthly: 199,
      priceYearly: 1990,
      stripePriceIdMonthly: 'price_enterprise_monthly',
      stripePriceIdYearly: 'price_enterprise_yearly',
    },
  },
}));

jest.mock('../../../services/stripeService', () => ({
  stripeService: {
    createCustomer: jest.fn().mockResolvedValue({ id: 'cus_test123' }),
    createPaymentIntent: jest.fn().mockResolvedValue({
      success: true,
      paymentIntentId: 'pi_test123',
      clientSecret: 'pi_test123_secret',
    }),
    createSubscription: jest.fn().mockResolvedValue({
      id: 'sub_test123',
      url: 'https://checkout.stripe.com/test',
    }),
    cancelSubscription: jest.fn().mockResolvedValue(undefined),
  },
}));

// Plan prices come from pricingConfigService (DB-backed); the real one reads
// PlatformSetting, so stub it with a fixed catalog in creditService's order.
const plan = (name: string, credits: number, priceMonthly: number, priceYearly: number) => ({
  name,
  credits,
  priceMonthly,
  priceYearly,
  stripePriceIdMonthly: `price_${name.toLowerCase()}_monthly`,
  stripePriceIdYearly: `price_${name.toLowerCase()}_yearly`,
  features: [],
});
const mockPlans = {
  STARTER: plan('Starter', 5, 29, 290),
  PREMIUM: plan('Premium', 15, 79, 790),
  ENTERPRISE: plan('Enterprise', 50, 199, 1990),
  VIP_ACCESS: plan('VIP', 0, 499, 4990),
  LEAD_GENERATOR_BUYER: plan('LeadBuyer', 0, 99, 990),
  LEAD_GENERATOR_BROKER: plan('LeadBroker', 0, 499, 4990),
};
jest.mock('../../../services/pricingConfigService', () => ({
  pricingConfigService: {
    getSubscriptionPlans: jest.fn(async () => Object.values(mockPlans)),
    getSubscriptionPlan: jest.fn(async (key: keyof typeof mockPlans) => mockPlans[key]),
  },
}));

jest.mock('../../../services/emailService', () => ({
  emailService: {
    sendPaymentReceived: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../../config', () => ({
  config: {
    frontendUrl: 'http://localhost:5173',
    credits: {
      pricePerCredit: 5,
    },
  },
}));

import {
  User,
  Subscription,
  CreditTransaction,
  Payment,
  SubscriptionStatus,
  CreditTransactionType,
} from '../../../models';
import { creditService } from '../../../services/creditService';

describe('CreditService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('getCreditBalance', () => {
    it('should return credit balance for user', async () => {
      const mockUser = {
        totalCredits: 100,
        usedCredits: 25,
      };

      (User.findByPk as jest.Mock).mockResolvedValue(mockUser);

      const result = await creditService.getCreditBalance('user-123');

      expect(result).toEqual({
        totalCredits: 100,
        usedCredits: 25,
        availableCredits: 75,
      });
    });

    it('should throw NotFoundError for non-existent user', async () => {
      (User.findByPk as jest.Mock).mockResolvedValue(null);

      await expect(creditService.getCreditBalance('non-existent')).rejects.toThrow('User not found');
    });
  });

  describe('getCreditHistory', () => {
    it('should return paginated credit history', async () => {
      const mockTransactions = [
        { id: 'tx1', amount: 10, type: 'purchase' },
        { id: 'tx2', amount: -1, type: 'usage' },
      ];

      (CreditTransaction.findAndCountAll as jest.Mock).mockResolvedValue({
        rows: mockTransactions,
        count: 50,
      });

      const result = await creditService.getCreditHistory('user-123', 1, 10);

      expect(result.transactions).toHaveLength(2);
      expect(result.pagination).toEqual({
        page: 1,
        limit: 10,
        total: 50,
        totalPages: 5,
      });
    });

    it('should calculate correct pagination', async () => {
      (CreditTransaction.findAndCountAll as jest.Mock).mockResolvedValue({
        rows: [],
        count: 0,
      });

      const result = await creditService.getCreditHistory('user-123', 3, 20);

      expect(result.pagination.page).toBe(3);
      expect(result.pagination.limit).toBe(20);
    });
  });

  describe('hasCredits', () => {
    it('should return true if user has enough credits', async () => {
      const mockUser = { totalCredits: 10, usedCredits: 5 };
      (User.findByPk as jest.Mock).mockResolvedValue(mockUser);

      const result = await creditService.hasCredits('user-123', 3);

      expect(result).toBe(true);
    });

    it('should return false if user does not have enough credits', async () => {
      const mockUser = { totalCredits: 10, usedCredits: 8 };
      (User.findByPk as jest.Mock).mockResolvedValue(mockUser);

      const result = await creditService.hasCredits('user-123', 5);

      expect(result).toBe(false);
    });

    it('should default to checking for 1 credit', async () => {
      const mockUser = { totalCredits: 1, usedCredits: 0 };
      (User.findByPk as jest.Mock).mockResolvedValue(mockUser);

      const result = await creditService.hasCredits('user-123');

      expect(result).toBe(true);
    });
  });

  describe('useCredits', () => {
    it('should deduct credits successfully', async () => {
      const mockUser = {
        id: 'user-123',
        totalCredits: 10,
        usedCredits: 2,
        update: jest.fn(),
      };

      (User.findByPk as jest.Mock).mockResolvedValue(mockUser);
      (CreditTransaction.create as jest.Mock).mockResolvedValue({ id: 'tx-123' });

      const result = await creditService.useCredits(
        'user-123',
        3,
        'Viewed listing',
        'listing-123'
      );

      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(5); // 10 - 2 - 3
      expect(mockUser.update).toHaveBeenCalled();
    });

    it('should throw error if insufficient credits', async () => {
      const mockUser = {
        id: 'user-123',
        totalCredits: 5,
        usedCredits: 4,
      };

      (User.findByPk as jest.Mock).mockResolvedValue(mockUser);

      await expect(
        creditService.useCredits('user-123', 3, 'Test')
      ).rejects.toThrow('Insufficient credits');
    });
  });

  describe('getSubscriptionPlans', () => {
    it('should return all subscription plans with calculated prices', async () => {
      const plans = await creditService.getSubscriptionPlans();

      expect(plans.map((p) => p.id)).toEqual([
        'STARTER',
        'PREMIUM',
        'ENTERPRISE',
        'VIP_ACCESS',
        'LEAD_GENERATOR_BUYER',
        'LEAD_GENERATOR_BROKER',
      ]);
      expect(plans[0]).toHaveProperty('id');
      expect(plans[0]).toHaveProperty('name');
      expect(plans[0]).toHaveProperty('credits');
      expect(plans[0]).toHaveProperty('priceMonthly');
      expect(plans[0]).toHaveProperty('priceYearly');
      expect(plans[0]).toHaveProperty('pricePerCreditMonthly');
      expect(plans[0]).toHaveProperty('pricePerCreditYearly');
    });

    it('should calculate correct price per credit', async () => {
      const plans = await creditService.getSubscriptionPlans();
      const starterPlan = plans.find((p) => p.id === 'STARTER');

      expect(starterPlan?.pricePerCreditMonthly).toBe(5.8); // 29 / 5 = 5.8
      expect(starterPlan?.pricePerCreditYearly).toBe(58); // 290 / 5
    });

    it('should report 0 per credit for plans without credits', async () => {
      const plans = await creditService.getSubscriptionPlans();
      expect(plans.find((p) => p.id === 'VIP_ACCESS')?.pricePerCreditMonthly).toBe(0);
    });
  });

  describe('getCurrentSubscription', () => {
    it('should return current subscription', async () => {
      const mockSubscription = {
        id: 'sub-123',
        plan: 'PREMIUM',
        status: 'active',
      };

      (Subscription.findOne as jest.Mock).mockResolvedValue(mockSubscription);

      const result = await creditService.getCurrentSubscription('user-123');

      expect(result).toEqual(mockSubscription);
    });

    it('should return null if no subscription', async () => {
      (Subscription.findOne as jest.Mock).mockResolvedValue(null);

      const result = await creditService.getCurrentSubscription('user-123');

      expect(result).toBeNull();
    });
  });

  describe('subscribe (legacy)', () => {
    it('should create new subscription', async () => {
      const mockUser = {
        id: 'user-123',
        totalCredits: 0,
        usedCredits: 0,
        update: jest.fn(),
      };

      const mockSubscription = {
        id: 'sub-123',
        userId: 'user-123',
        plan: 'STARTER',
        status: 'active',
      };

      (Subscription.findOne as jest.Mock).mockResolvedValue(null);
      (User.findByPk as jest.Mock).mockResolvedValue(mockUser);
      (Subscription.create as jest.Mock).mockResolvedValue(mockSubscription);
      (CreditTransaction.create as jest.Mock).mockResolvedValue({ id: 'tx-123' });
      (Payment.create as jest.Mock).mockResolvedValue({ id: 'pay-123' });

      const result = await creditService.subscribe('user-123', 'STARTER' as any, false);

      expect(result).toEqual(mockSubscription);
      expect(Subscription.create).toHaveBeenCalledWith(
        expect.objectContaining({ plan: 'STARTER', creditsPerMonth: 5, priceMonthly: 29 })
      );
      expect(mockUser.update).toHaveBeenCalledWith({ totalCredits: 5 }, expect.anything());
    });

    it('should throw error if active subscription exists', async () => {
      (Subscription.findOne as jest.Mock).mockResolvedValue({
        status: SubscriptionStatus.ACTIVE,
      });

      await expect(
        creditService.subscribe('user-123', 'STARTER' as any, false)
      ).rejects.toThrow('You already have an active subscription');
    });
  });

  describe('cancelSubscription', () => {
    it('should cancel active subscription', async () => {
      const mockSubscription = {
        id: 'sub-123',
        status: SubscriptionStatus.ACTIVE,
        renewalDate: new Date(),
        update: jest.fn(),
      };

      (Subscription.findOne as jest.Mock).mockResolvedValue(mockSubscription);
      (User.findByPk as jest.Mock).mockResolvedValue({ id: 'user-123' });

      const result = await creditService.cancelSubscription('user-123');

      expect(mockSubscription.update).toHaveBeenCalled();
      expect(result).toEqual(mockSubscription);
    });

    it('should throw error if no subscription found', async () => {
      (Subscription.findOne as jest.Mock).mockResolvedValue(null);

      await expect(creditService.cancelSubscription('user-123')).rejects.toThrow(
        'Subscription not found'
      );
    });

    it('should throw error if subscription is not active', async () => {
      (Subscription.findOne as jest.Mock).mockResolvedValue({
        status: SubscriptionStatus.CANCELLED,
      });

      await expect(creditService.cancelSubscription('user-123')).rejects.toThrow(
        'No active subscription to cancel'
      );
    });
  });

  describe('addBonusCredits', () => {
    it('should add bonus credits to user', async () => {
      const mockUser = {
        id: 'user-123',
        totalCredits: 10,
        usedCredits: 2,
        update: jest.fn(),
      };

      (User.findByPk as jest.Mock).mockResolvedValue(mockUser);
      (CreditTransaction.create as jest.Mock).mockResolvedValue({ id: 'tx-123' });

      const result = await creditService.addBonusCredits(
        'user-123',
        5,
        'Welcome bonus',
        'admin-123'
      );

      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(13); // 10 + 5 - 2
      expect(mockUser.update).toHaveBeenCalledWith(
        { totalCredits: 15 },
        expect.anything()
      );
    });

    it('should throw error if user not found', async () => {
      (User.findByPk as jest.Mock).mockResolvedValue(null);

      await expect(
        creditService.addBonusCredits('non-existent', 5, 'Bonus', 'admin-123')
      ).rejects.toThrow('User not found');
    });
  });

  describe('refundCredits', () => {
    it('should refund used credits', async () => {
      const mockUser = {
        id: 'user-123',
        totalCredits: 10,
        usedCredits: 5,
        update: jest.fn(),
      };

      (User.findByPk as jest.Mock).mockResolvedValue(mockUser);
      (CreditTransaction.create as jest.Mock).mockResolvedValue({ id: 'tx-123' });

      const result = await creditService.refundCredits(
        'user-123',
        3,
        'Refund for cancelled listing'
      );

      expect(result.success).toBe(true);
      expect(result.newBalance).toBe(8); // 10 - (5 - 3)
    });

    it('should throw error if not enough used credits', async () => {
      const mockUser = {
        id: 'user-123',
        totalCredits: 10,
        usedCredits: 2,
      };

      (User.findByPk as jest.Mock).mockResolvedValue(mockUser);

      await expect(
        creditService.refundCredits('user-123', 5, 'Refund')
      ).rejects.toThrow('Not enough used credits to refund');
    });
  });

  describe('purchaseCredits', () => {
    it('should create payment intent for credit purchase', async () => {
      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        stripeCustomerId: 'cus_existing',
        update: jest.fn(),
      };

      (User.findByPk as jest.Mock).mockResolvedValue(mockUser);

      const result = await creditService.purchaseCredits({
        userId: 'user-123',
        creditAmount: 10,
        paymentMethodId: 'pm_test123',
      });

      expect(result).toEqual({ paymentIntentId: 'pi_test123', clientSecret: 'pi_test123_secret' });
      const { stripeService } = require('../../../services/stripeService');
      expect(stripeService.createPaymentIntent).toHaveBeenCalledWith(
        expect.objectContaining({ amount: 5000, customerId: 'cus_existing' }) // 10 credits x $5
      );
    });

    it('should create Stripe customer if not exists', async () => {
      const mockUser = {
        id: 'user-123',
        email: 'test@example.com',
        firstName: 'Test',
        lastName: 'User',
        stripeCustomerId: null,
        update: jest.fn(),
      };

      (User.findByPk as jest.Mock).mockResolvedValue(mockUser);

      await creditService.purchaseCredits({
        userId: 'user-123',
        creditAmount: 5,
        paymentMethodId: 'pm_test123',
      });

      const { stripeService } = require('../../../services/stripeService');
      expect(stripeService.createCustomer).toHaveBeenCalled();
      expect(mockUser.update).toHaveBeenCalledWith({ stripeCustomerId: 'cus_test123' });
    });
  });
});
