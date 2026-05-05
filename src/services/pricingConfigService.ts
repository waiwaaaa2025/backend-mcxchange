import { PlatformSetting } from '../models';

// Pricing configuration types
export interface SubscriptionPlanConfig {
  name: string;
  credits: number;
  priceMonthly: number;
  priceYearly: number;
  stripePriceIdMonthly: string;
  stripePriceIdYearly: string;
  features: string[];
}

export interface CreditPack {
  id: string;
  credits: number;
  price: number;
  stripePriceId: string;
}

export interface PlatformFeesConfig {
  listingFee: number;
  premiumListingFee: number;
  transactionFeePercentage: number;
  depositPercentage: number;
  minDeposit: number;
  maxDeposit: number;
  consultationFee: number;
}

export interface PricingConfig {
  subscriptionPlans: {
    starter: SubscriptionPlanConfig;
    premium: SubscriptionPlanConfig;
    enterprise: SubscriptionPlanConfig;
    vip_access: SubscriptionPlanConfig;
  };
  platformFees: PlatformFeesConfig;
  creditPacks: CreditPack[];
}

// Default pricing values
const DEFAULT_PRICING: PricingConfig = {
  subscriptionPlans: {
    starter: {
      name: 'Starter',
      credits: 6,
      priceMonthly: 19.99,
      priceYearly: 192,
      stripePriceIdMonthly: process.env.STRIPE_PRICE_STARTER_MONTHLY || '',
      stripePriceIdYearly: process.env.STRIPE_PRICE_STARTER_YEARLY || '',
      features: [
        '6 listing unlock credits per month',
        'Full marketplace access',
        'CarrierPulse included',
        'Standard support',
      ],
    },
    premium: {
      name: 'Premium',
      credits: 10,
      priceMonthly: 39.99,
      priceYearly: 383.99,
      stripePriceIdMonthly: process.env.STRIPE_PRICE_PREMIUM_MONTHLY || '',
      stripePriceIdYearly: process.env.STRIPE_PRICE_PREMIUM_YEARLY || '',
      features: [
        '10 listing unlock credits per month',
        'EVA AI Assistant',
        'CarrierPulse included',
        'Risk Checks',
        '5 Company Credit Reports per month',
        'UCC filings, tax liens, payment history & credit line',
        'Standard support',
      ],
    },
    enterprise: {
      name: 'Enterprise',
      credits: 20,
      priceMonthly: 79.99,
      priceYearly: 767.99,
      stripePriceIdMonthly: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY || '',
      stripePriceIdYearly: process.env.STRIPE_PRICE_ENTERPRISE_YEARLY || '',
      features: [
        '20 listing unlock credits per month',
        '20 Company Credit Reports per month',
        'Everything in Premium',
        'EVA AI Assistant',
        'CarrierPulse included',
        'Risk Checks',
        'Priority support',
      ],
    },
    vip_access: {
      name: 'VIP / Deal Access Pass',
      credits: 999,
      priceMonthly: 399,
      priceYearly: 399,
      stripePriceIdMonthly: process.env.STRIPE_PRICE_VIP_ACCESS_ONETIME || process.env.STRIPE_PRICE_VIP_ACCESS_MONTHLY || '',
      stripePriceIdYearly: process.env.STRIPE_PRICE_VIP_ACCESS_ONETIME || process.env.STRIPE_PRICE_VIP_ACCESS_YEARLY || '',
      features: [
        'Unlimited listing unlocks until purchase',
        '$399 credited toward your final MC purchase',
        'Admin full support',
        '1-on-1 consultation call',
        'AI+ Reports included',
        'Not a subscription — one-time pass',
      ],
    },
  },
  platformFees: {
    listingFee: 49.99,
    premiumListingFee: 199.99,
    transactionFeePercentage: 3,
    depositPercentage: 10,
    minDeposit: 500,
    maxDeposit: 10000,
    consultationFee: 100.00,
  },
  creditPacks: [
    { id: 'pack_10', credits: 10, price: 44.99, stripePriceId: '' },
    { id: 'pack_25', credits: 25, price: 99.99, stripePriceId: '' },
  ],
};

// Cache for pricing config
let pricingCache: PricingConfig | null = null;
let cacheTimestamp: number = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

class PricingConfigService {
  /**
   * Get the full pricing configuration
   * Uses cached value if available and not expired
   */
  async getPricingConfig(): Promise<PricingConfig> {
    // Check cache
    if (pricingCache && Date.now() - cacheTimestamp < CACHE_TTL) {
      return pricingCache;
    }

    // Load from database
    const config = await this.loadFromDatabase();

    // Update cache
    pricingCache = config;
    cacheTimestamp = Date.now();

    return config;
  }

  /**
   * Update pricing configuration
   */
  async updatePricingConfig(updates: Partial<PricingConfig>): Promise<PricingConfig> {
    const currentConfig = await this.getPricingConfig();

    // Merge updates
    const newConfig: PricingConfig = {
      subscriptionPlans: {
        ...currentConfig.subscriptionPlans,
        ...(updates.subscriptionPlans || {}),
      },
      platformFees: {
        ...currentConfig.platformFees,
        ...(updates.platformFees || {}),
      },
      creditPacks: updates.creditPacks || currentConfig.creditPacks,
    };

    // Save to database
    await this.saveToDatabase(newConfig);

    // Clear cache
    this.clearCache();

    return newConfig;
  }

  /**
   * Get subscription plans for public API
   */
  async getSubscriptionPlans(): Promise<SubscriptionPlanConfig[]> {
    const config = await this.getPricingConfig();
    return [
      config.subscriptionPlans.starter,
      config.subscriptionPlans.premium,
      config.subscriptionPlans.enterprise,
      config.subscriptionPlans.vip_access,
    ];
  }

  /**
   * Get a specific subscription plan by key
   */
  async getSubscriptionPlan(planKey: 'STARTER' | 'PREMIUM' | 'ENTERPRISE' | 'VIP_ACCESS'): Promise<SubscriptionPlanConfig> {
    const config = await this.getPricingConfig();
    const key = planKey.toLowerCase() as 'starter' | 'premium' | 'enterprise' | 'vip_access';
    return config.subscriptionPlans[key];
  }

  /**
   * Get platform fees
   */
  async getPlatformFees(): Promise<PlatformFeesConfig> {
    const config = await this.getPricingConfig();
    return config.platformFees;
  }

  /**
   * Get credit packs for public API
   */
  async getCreditPacks(): Promise<CreditPack[]> {
    const config = await this.getPricingConfig();
    return config.creditPacks;
  }

  /**
   * Get consultation fee
   */
  async getConsultationFee(): Promise<number> {
    const config = await this.getPricingConfig();
    return config.platformFees.consultationFee;
  }

  /**
   * Get a specific credit pack by ID
   */
  async getCreditPack(packId: string): Promise<CreditPack | null> {
    const config = await this.getPricingConfig();
    return config.creditPacks.find(pack => pack.id === packId) || null;
  }

  /**
   * Get Stripe price ID for a subscription plan
   */
  async getStripePriceId(planKey: 'STARTER' | 'PREMIUM' | 'ENTERPRISE' | 'VIP_ACCESS', isYearly: boolean): Promise<string> {
    const plan = await this.getSubscriptionPlan(planKey);
    return isYearly ? plan.stripePriceIdYearly : plan.stripePriceIdMonthly;
  }

  /**
   * Clear the pricing cache (call after updates)
   */
  clearCache(): void {
    pricingCache = null;
    cacheTimestamp = 0;
  }

  /**
   * Load pricing config from database
   */
  private async loadFromDatabase(): Promise<PricingConfig> {
    const settings = await PlatformSetting.findAll();
    const settingsMap: Record<string, string> = {};

    for (const setting of settings) {
      settingsMap[setting.key] = setting.value;
    }

    // Build config from settings, falling back to defaults
    return {
      subscriptionPlans: {
        starter: {
          name: 'Starter',
          credits: this.parseNumber(settingsMap['starter_credits'], DEFAULT_PRICING.subscriptionPlans.starter.credits),
          priceMonthly: this.parseNumber(settingsMap['starter_price_monthly'], DEFAULT_PRICING.subscriptionPlans.starter.priceMonthly),
          priceYearly: this.parseNumber(settingsMap['starter_price_yearly'], DEFAULT_PRICING.subscriptionPlans.starter.priceYearly),
          stripePriceIdMonthly: settingsMap['starter_stripe_monthly'] || DEFAULT_PRICING.subscriptionPlans.starter.stripePriceIdMonthly,
          stripePriceIdYearly: settingsMap['starter_stripe_yearly'] || DEFAULT_PRICING.subscriptionPlans.starter.stripePriceIdYearly,
          features: this.parseJson(settingsMap['starter_features'], DEFAULT_PRICING.subscriptionPlans.starter.features),
        },
        premium: {
          name: 'Premium',
          credits: this.parseNumber(settingsMap['premium_credits'], DEFAULT_PRICING.subscriptionPlans.premium.credits),
          priceMonthly: this.parseNumber(settingsMap['premium_price_monthly'], DEFAULT_PRICING.subscriptionPlans.premium.priceMonthly),
          priceYearly: this.parseNumber(settingsMap['premium_price_yearly'], DEFAULT_PRICING.subscriptionPlans.premium.priceYearly),
          stripePriceIdMonthly: settingsMap['premium_stripe_monthly'] || DEFAULT_PRICING.subscriptionPlans.premium.stripePriceIdMonthly,
          stripePriceIdYearly: settingsMap['premium_stripe_yearly'] || DEFAULT_PRICING.subscriptionPlans.premium.stripePriceIdYearly,
          features: this.parseJson(settingsMap['premium_features'], DEFAULT_PRICING.subscriptionPlans.premium.features),
        },
        enterprise: {
          name: 'Enterprise',
          credits: this.parseNumber(settingsMap['enterprise_credits'], DEFAULT_PRICING.subscriptionPlans.enterprise.credits),
          priceMonthly: this.parseNumber(settingsMap['enterprise_price_monthly'], DEFAULT_PRICING.subscriptionPlans.enterprise.priceMonthly),
          priceYearly: this.parseNumber(settingsMap['enterprise_price_yearly'], DEFAULT_PRICING.subscriptionPlans.enterprise.priceYearly),
          stripePriceIdMonthly: settingsMap['enterprise_stripe_monthly'] || DEFAULT_PRICING.subscriptionPlans.enterprise.stripePriceIdMonthly,
          stripePriceIdYearly: settingsMap['enterprise_stripe_yearly'] || DEFAULT_PRICING.subscriptionPlans.enterprise.stripePriceIdYearly,
          features: this.parseJson(settingsMap['enterprise_features'], DEFAULT_PRICING.subscriptionPlans.enterprise.features),
        },
        vip_access: {
          name: 'VIP / Deal Access Pass',
          credits: this.parseNumber(settingsMap['vip_access_credits'], DEFAULT_PRICING.subscriptionPlans.vip_access.credits),
          priceMonthly: this.parseNumber(settingsMap['vip_access_price_monthly'], DEFAULT_PRICING.subscriptionPlans.vip_access.priceMonthly),
          priceYearly: this.parseNumber(settingsMap['vip_access_price_yearly'], DEFAULT_PRICING.subscriptionPlans.vip_access.priceYearly),
          stripePriceIdMonthly: settingsMap['vip_access_stripe_monthly'] || DEFAULT_PRICING.subscriptionPlans.vip_access.stripePriceIdMonthly,
          stripePriceIdYearly: settingsMap['vip_access_stripe_yearly'] || DEFAULT_PRICING.subscriptionPlans.vip_access.stripePriceIdYearly,
          features: this.parseJson(settingsMap['vip_access_features'], DEFAULT_PRICING.subscriptionPlans.vip_access.features),
        },
      },
      platformFees: {
        listingFee: this.parseNumber(settingsMap['listing_fee'], DEFAULT_PRICING.platformFees.listingFee),
        premiumListingFee: this.parseNumber(settingsMap['premium_listing_fee'], DEFAULT_PRICING.platformFees.premiumListingFee),
        transactionFeePercentage: this.parseNumber(settingsMap['transaction_fee_percentage'], DEFAULT_PRICING.platformFees.transactionFeePercentage),
        depositPercentage: this.parseNumber(settingsMap['deposit_percentage'], DEFAULT_PRICING.platformFees.depositPercentage),
        minDeposit: this.parseNumber(settingsMap['min_deposit'], DEFAULT_PRICING.platformFees.minDeposit),
        maxDeposit: this.parseNumber(settingsMap['max_deposit'], DEFAULT_PRICING.platformFees.maxDeposit),
        consultationFee: this.parseNumber(settingsMap['consultation_fee'], DEFAULT_PRICING.platformFees.consultationFee),
      },
      creditPacks: this.parseJson(settingsMap['credit_packs'], DEFAULT_PRICING.creditPacks),
    };
  }

  /**
   * Save pricing config to database
   */
  private async saveToDatabase(config: PricingConfig): Promise<void> {
    const settings: Array<{ key: string; value: string; type: string }> = [
      // Starter plan
      { key: 'starter_credits', value: String(config.subscriptionPlans.starter.credits), type: 'number' },
      { key: 'starter_price_monthly', value: String(config.subscriptionPlans.starter.priceMonthly), type: 'number' },
      { key: 'starter_price_yearly', value: String(config.subscriptionPlans.starter.priceYearly), type: 'number' },
      { key: 'starter_stripe_monthly', value: config.subscriptionPlans.starter.stripePriceIdMonthly, type: 'string' },
      { key: 'starter_stripe_yearly', value: config.subscriptionPlans.starter.stripePriceIdYearly, type: 'string' },
      { key: 'starter_features', value: JSON.stringify(config.subscriptionPlans.starter.features), type: 'json' },

      // Premium plan
      { key: 'premium_credits', value: String(config.subscriptionPlans.premium.credits), type: 'number' },
      { key: 'premium_price_monthly', value: String(config.subscriptionPlans.premium.priceMonthly), type: 'number' },
      { key: 'premium_price_yearly', value: String(config.subscriptionPlans.premium.priceYearly), type: 'number' },
      { key: 'premium_stripe_monthly', value: config.subscriptionPlans.premium.stripePriceIdMonthly, type: 'string' },
      { key: 'premium_stripe_yearly', value: config.subscriptionPlans.premium.stripePriceIdYearly, type: 'string' },
      { key: 'premium_features', value: JSON.stringify(config.subscriptionPlans.premium.features), type: 'json' },

      // Enterprise plan
      { key: 'enterprise_credits', value: String(config.subscriptionPlans.enterprise.credits), type: 'number' },
      { key: 'enterprise_price_monthly', value: String(config.subscriptionPlans.enterprise.priceMonthly), type: 'number' },
      { key: 'enterprise_price_yearly', value: String(config.subscriptionPlans.enterprise.priceYearly), type: 'number' },
      { key: 'enterprise_stripe_monthly', value: config.subscriptionPlans.enterprise.stripePriceIdMonthly, type: 'string' },
      { key: 'enterprise_stripe_yearly', value: config.subscriptionPlans.enterprise.stripePriceIdYearly, type: 'string' },
      { key: 'enterprise_features', value: JSON.stringify(config.subscriptionPlans.enterprise.features), type: 'json' },

      // VIP Access plan
      { key: 'vip_access_credits', value: String(config.subscriptionPlans.vip_access.credits), type: 'number' },
      { key: 'vip_access_price_monthly', value: String(config.subscriptionPlans.vip_access.priceMonthly), type: 'number' },
      { key: 'vip_access_price_yearly', value: String(config.subscriptionPlans.vip_access.priceYearly), type: 'number' },
      { key: 'vip_access_stripe_monthly', value: config.subscriptionPlans.vip_access.stripePriceIdMonthly, type: 'string' },
      { key: 'vip_access_stripe_yearly', value: config.subscriptionPlans.vip_access.stripePriceIdYearly, type: 'string' },
      { key: 'vip_access_features', value: JSON.stringify(config.subscriptionPlans.vip_access.features), type: 'json' },

      // Platform fees
      { key: 'listing_fee', value: String(config.platformFees.listingFee), type: 'number' },
      { key: 'premium_listing_fee', value: String(config.platformFees.premiumListingFee), type: 'number' },
      { key: 'transaction_fee_percentage', value: String(config.platformFees.transactionFeePercentage), type: 'number' },
      { key: 'deposit_percentage', value: String(config.platformFees.depositPercentage), type: 'number' },
      { key: 'min_deposit', value: String(config.platformFees.minDeposit), type: 'number' },
      { key: 'max_deposit', value: String(config.platformFees.maxDeposit), type: 'number' },
      { key: 'consultation_fee', value: String(config.platformFees.consultationFee), type: 'number' },

      // Credit packs
      { key: 'credit_packs', value: JSON.stringify(config.creditPacks), type: 'json' },
    ];

    // Upsert all settings
    for (const setting of settings) {
      await PlatformSetting.upsert({
        key: setting.key,
        value: setting.value,
        type: setting.type,
      });
    }
  }

  // Helper methods for parsing
  private parseNumber(value: string | undefined, defaultValue: number): number {
    if (!value) return defaultValue;
    const parsed = parseFloat(value);
    return isNaN(parsed) ? defaultValue : parsed;
  }

  private parseJson<T>(value: string | undefined, defaultValue: T): T {
    if (!value) return defaultValue;
    try {
      return JSON.parse(value) as T;
    } catch {
      return defaultValue;
    }
  }
}

export const pricingConfigService = new PricingConfigService();
export default pricingConfigService;
