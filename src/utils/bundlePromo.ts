/**
 * Shared helper for the Buyer's-Guide 60-day bundle promo.
 * Used by auth middleware, controllers, and the guide service to keep the
 * "what counts as bundle access" rule in one place.
 */

export const BUNDLE_PROMO_ACCESS_TYPE = 'pdf_bundle_60day';

export interface BundlePromoFields {
  promoAccessType?: string | null;
  promoAccessExpiresAt?: Date | string | null;
}

export function hasActiveBundlePromo(user: BundlePromoFields | null | undefined): boolean {
  if (!user) return false;
  if (user.promoAccessType !== BUNDLE_PROMO_ACCESS_TYPE) return false;
  if (!user.promoAccessExpiresAt) return false;
  return new Date(user.promoAccessExpiresAt).getTime() > Date.now();
}
