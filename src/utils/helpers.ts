import { PaginationInfo, TRUST_SCORE_WEIGHTS, PLATFORM_FEES } from '../types';

// Generate pagination info
export function getPaginationInfo(
  page: number,
  limit: number,
  total: number
): PaginationInfo {
  const totalPages = Math.ceil(total / limit);
  return {
    page,
    limit,
    total,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

// Calculate trust score based on user activity
export function calculateTrustScore(params: {
  completedDeals: number;
  positiveReviews: number;
  negativeReviews: number;
  isVerifiedSeller: boolean;
  accountAgeMonths: number;
}): number {
  const { completedDeals, positiveReviews, negativeReviews, isVerifiedSeller, accountAgeMonths } = params;

  let score = TRUST_SCORE_WEIGHTS.BASE_SCORE;

  // Add points for completed deals
  score += completedDeals * TRUST_SCORE_WEIGHTS.COMPLETED_DEALS;

  // Add/subtract points for reviews
  score += positiveReviews * TRUST_SCORE_WEIGHTS.POSITIVE_REVIEW;
  score += negativeReviews * TRUST_SCORE_WEIGHTS.NEGATIVE_REVIEW;

  // Add points for verified seller
  if (isVerifiedSeller) {
    score += TRUST_SCORE_WEIGHTS.VERIFIED_SELLER;
  }

  // Add points for account age (capped at 12 months)
  const cappedAge = Math.min(accountAgeMonths, 12);
  score += cappedAge * TRUST_SCORE_WEIGHTS.ACCOUNT_AGE_MONTH;

  // Clamp between 0 and 100
  return Math.max(0, Math.min(TRUST_SCORE_WEIGHTS.MAX_SCORE, score));
}

// Get trust level from score
export function getTrustLevel(score: number): 'high' | 'medium' | 'low' {
  if (score >= 80) return 'high';
  if (score >= 50) return 'medium';
  return 'low';
}

// Calculate deposit amount
export function calculateDeposit(agreedPrice: number): number {
  const deposit = agreedPrice * (PLATFORM_FEES.DEPOSIT_PERCENTAGE / 100);
  return Math.max(PLATFORM_FEES.MIN_DEPOSIT, Math.min(PLATFORM_FEES.MAX_DEPOSIT, deposit));
}

// Calculate platform fee
export function calculatePlatformFee(salePrice: number): number {
  return salePrice * (PLATFORM_FEES.TRANSACTION_FEE_PERCENTAGE / 100);
}

/**
 * What the seller receives for an MC sale: their asking price, but never more
 * than the agreed price minus the platform fee. A buyer paying above asking
 * leaves the spread with Domilea; a deal agreed below asking pays the seller
 * agreed − fee. An admin-negotiated seller net (offer.sellerAmount) replaces
 * the asking price, under the same cap.
 */
export function sellerNetPayout(
  agreedPrice: number,
  platformFee: number,
  negotiatedSellerAmount?: number | null,
  askingPrice?: number | null
): number {
  const cap = Math.max(Number(agreedPrice) - Number(platformFee || 0), 0);
  const negotiated = Number(negotiatedSellerAmount);
  const asking = Number(askingPrice);
  const target = negotiated > 0 ? negotiated : asking > 0 ? asking : cap;
  return Math.round(Math.min(target, cap) * 100) / 100;
}

// Format currency
export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(amount);
}

// Sanitize search query
export function sanitizeSearchQuery(query: string): string {
  return query
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .substring(0, 100);
}

// Parse boolean query param
export function parseBooleanParam(value: string | undefined): boolean | undefined {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}

// Parse integer query param
export function parseIntParam(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = parseInt(value, 10);
  return isNaN(parsed) ? undefined : parsed;
}

// Generate random string for references
export function generateReference(prefix: string = 'REF'): string {
  const timestamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `${prefix}-${timestamp}-${random}`;
}

// Calculate months since a date
export function monthsSince(date: Date): number {
  const now = new Date();
  const months =
    (now.getFullYear() - date.getFullYear()) * 12 + (now.getMonth() - date.getMonth());
  return Math.max(0, months);
}

// Mask sensitive data (e.g., email)
export function maskEmail(email: string): string {
  const [name, domain] = email.split('@');
  if (!name || !domain) return email;
  const maskedName = name.substring(0, 2) + '***';
  return `${maskedName}@${domain}`;
}

// Mask phone number
export function maskPhone(phone: string): string {
  if (phone.length < 4) return phone;
  return phone.substring(0, phone.length - 4).replace(/./g, '*') + phone.slice(-4);
}

// Validate MC number format
export function isValidMCNumber(mc: string): boolean {
  return /^\d{1,7}$/.test(mc.replace(/^MC-?/i, ''));
}

// Validate DOT number format
export function isValidDOTNumber(dot: string): boolean {
  return /^\d{1,8}$/.test(dot.replace(/^DOT-?/i, ''));
}

// Normalize MC number (remove prefix, pad to 6 digits)
export function normalizeMCNumber(mc: string): string {
  return mc.replace(/^MC-?/i, '').replace(/^0+/, '');
}

// Normalize DOT number
export function normalizeDOTNumber(dot: string): string {
  return dot.replace(/^DOT-?/i, '').replace(/^0+/, '');
}

// Delay helper for rate limiting
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
