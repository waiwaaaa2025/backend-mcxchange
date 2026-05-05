import { Request } from 'express';
import { UserRole } from '../models';

// Extend Express Request with user
export interface AuthRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: UserRole;
    name: string;
    stripeCustomerId?: string | null;
    identityVerified?: boolean;
  };
}

// API Response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
  errors?: ValidationError[];
  pagination?: PaginationInfo;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface PaginationInfo {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
}

// Query params for listings
export interface ListingQueryParams {
  page?: number;
  limit?: number;
  search?: string;
  minPrice?: number;
  maxPrice?: number;
  state?: string;
  safetyRating?: string;
  amazonStatus?: string;
  authorityType?: string;
  trustLevel?: string;
  verified?: boolean;
  premium?: boolean;
  vip?: boolean;
  highwaySetup?: boolean;
  hasEmail?: boolean;
  hasPhone?: boolean;
  minYears?: number;
  sortBy?: 'price_asc' | 'price_desc' | 'trust_score' | 'newest' | 'oldest' | 'years_active';
  status?: string;
  sellerId?: string;
}

// JWT Payload
export interface JWTPayload {
  id: string;
  email: string;
  role: UserRole;
  name: string;
  iat?: number;
  exp?: number;
}

// FMCSA Types
export interface FMCSACarrierData {
  dotNumber: string;
  mcNumber?: string;
  legalName: string;
  dbaName?: string;
  carrierOperation: string;
  hqCity: string;
  hqState: string;
  physicalAddress: string;
  phone: string;
  safetyRating: string;
  safetyRatingDate?: string;
  totalDrivers: number;
  totalPowerUnits: number;
  mcs150Date?: string;
  allowedToOperate: string;
  bipdRequired: number;
  cargoRequired: number;
  bondRequired: number;
  insuranceOnFile: boolean;
  bipdOnFile: number;
  cargoOnFile: number;
  bondOnFile: number;
  cargoTypes: string[];
  // Inspection Data (from FMCSA carrier endpoint)
  driverInsp: number;
  driverOosInsp: number;
  driverOosRate: number;
  vehicleInsp: number;
  vehicleOosInsp: number;
  vehicleOosRate: number;
  hazmatInsp: number;
  hazmatOosInsp: number;
  hazmatOosRate: number;
  // Crash Data
  crashTotal: number;
  fatalCrash: number;
  injuryCrash: number;
  towCrash: number;
  // BASIC Scores
  unsafeDrivingBasic: number;
  hoursOfServiceBasic: number;
  driverFitnessBasic: number;
  controlledSubstancesBasic: number;
  vehicleMaintenanceBasic: number;
  hazmatBasic: number;
  crashIndicatorBasic: number;
}

export interface FMCSAAuthorityHistory {
  commonAuthorityStatus: string;
  commonAuthorityGrantDate?: string;
  commonAuthorityReinstatedDate?: string;
  commonAuthorityRevokedDate?: string;
  contractAuthorityStatus: string;
  contractAuthorityGrantDate?: string;
  brokerAuthorityStatus: string;
  brokerAuthorityGrantDate?: string;
  applicationDate?: string;
  grantDate?: string;
  effectiveDate?: string;
  revocationDate?: string;
}

export interface FMCSAInsuranceHistory {
  insurerName: string;
  policyNumber: string;
  insuranceType: string;
  coverageAmount: number;
  effectiveDate: string;
  cancellationDate?: string;
  status: string;
}

// Transaction Step Data
export interface TransactionStep {
  id: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  title: string;
  description: string;
  completedAt?: Date;
  actorId?: string;
  actorRole?: UserRole;
}

// Offer Data
export interface CreateOfferData {
  listingId: string;
  amount: number;
  message?: string;
  expiresAt?: Date;
  isBuyNow?: boolean;
}

// Listing Data
export interface CreateListingData {
  mcNumber: string;
  dotNumber: string;
  legalName: string;
  dbaName?: string;
  title: string;
  description?: string;
  askingPrice: number;
  listingPrice?: number;
  city: string;
  state: string;
  address?: string;
  yearsActive?: number;
  fleetSize?: number;
  totalDrivers?: number;
  safetyRating?: string;
  insuranceOnFile?: boolean;
  bipdCoverage?: number;
  cargoCoverage?: number;
  bondAmount?: number;
  amazonStatus?: string;
  amazonRelayScore?: string;
  authorityType?: string;
  highwaySetup?: boolean;
  sellingWithEmail?: boolean;
  sellingWithPhone?: boolean;
  rmisSetup?: boolean;
  setupWithBrokers?: boolean;
  contactEmail?: string;
  contactPhone?: string;
  cargoTypes?: string[];
  visibility?: string;
  isPremium?: boolean;
  isVip?: boolean;
  fmcsaData?: string;
  authorityHistory?: string;
  insuranceHistory?: string;
  insuranceCompany?: string;
  monthlyInsurancePremium?: number;
}

// Subscription Plans
// Used by buyerService.fulfillSubscription to populate Subscription DB record
// after Stripe webhook. Values must match the public catalog in pricingConfigService.
// PROFESSIONAL kept for grandfathered subs (buyerService.ts maps PROFESSIONAL → PREMIUM
// before the SUBSCRIPTION_PLANS lookup, so this block is defensive).
export const SUBSCRIPTION_PLANS = {
  STARTER: {
    name: 'Starter',
    credits: 6,
    priceMonthly: 19.99,
    priceYearly: 192,
    stripePriceIdMonthly: process.env.STRIPE_PRICE_STARTER_MONTHLY || '',
    stripePriceIdYearly: process.env.STRIPE_PRICE_STARTER_YEARLY || '',
  },
  PROFESSIONAL: {
    name: 'Professional',
    credits: 10,
    priceMonthly: 39,
    priceYearly: 374.40,
    stripePriceIdMonthly: process.env.STRIPE_PRICE_PROFESSIONAL_MONTHLY || '',
    stripePriceIdYearly: process.env.STRIPE_PRICE_PROFESSIONAL_YEARLY || '',
  },
  PREMIUM: {
    name: 'Premium',
    credits: 10,
    priceMonthly: 39.99,
    priceYearly: 383.99,
    stripePriceIdMonthly: process.env.STRIPE_PRICE_PREMIUM_MONTHLY || '',
    stripePriceIdYearly: process.env.STRIPE_PRICE_PREMIUM_YEARLY || '',
  },
  ENTERPRISE: {
    name: 'Enterprise',
    credits: 20,
    priceMonthly: 79.99,
    priceYearly: 767.99,
    stripePriceIdMonthly: process.env.STRIPE_PRICE_ENTERPRISE_MONTHLY || '',
    stripePriceIdYearly: process.env.STRIPE_PRICE_ENTERPRISE_YEARLY || '',
  },
};

// Platform Fees
export const PLATFORM_FEES = {
  LISTING_FEE: 49.99,
  PREMIUM_LISTING_FEE: 199.99,
  TRANSACTION_FEE_PERCENTAGE: 3, // 3% of sale price
  DEPOSIT_PERCENTAGE: 10, // 10% of agreed price
  MIN_DEPOSIT: 500,
  MAX_DEPOSIT: 10000,
} as const;

// Trust Score Calculation
export const TRUST_SCORE_WEIGHTS = {
  COMPLETED_DEALS: 10, // per deal
  POSITIVE_REVIEW: 5,
  NEGATIVE_REVIEW: -10,
  VERIFIED_SELLER: 20,
  ACCOUNT_AGE_MONTH: 1, // per month
  MAX_SCORE: 100,
  BASE_SCORE: 50,
} as const;
