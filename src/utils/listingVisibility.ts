import { Op } from 'sequelize';
import { MASKED_NUMBER } from './listingSanitize';
import { Transaction, TransactionStatus, ListingStatus, UserRole } from '../models';

// Same full mask as listingSanitize — the two must agree, or one reveals what
// the other hides.
export function maskNumber<T extends string | null | undefined>(num: T): T {
  if (!num) return num;
  return MASKED_NUMBER as T;
}

export function isSold(status: unknown): boolean {
  return status === ListingStatus.SOLD;
}

/**
 * Sold listings hide their MC/DOT from everyone except admins, the seller who
 * owned the listing, and the buyer who actually completed the purchase.
 * Unlocking a listing with credits does NOT survive the sale.
 */
export function canSeeSoldNumbers(opts: {
  listing: { sellerId?: string | null };
  userId?: string;
  role?: UserRole | string;
  isPurchaser?: boolean;
}): boolean {
  const { listing, userId, role, isPurchaser } = opts;
  if (role === UserRole.ADMIN) return true;
  if (userId && listing.sellerId === userId) return true;
  return !!isPurchaser;
}

/** Mask MC/DOT in place on a plain listing object. Returns the same object. */
export function maskListingNumbers<T extends Record<string, any>>(listing: T): T {
  const target = listing as Record<string, any>;
  target.mcNumber = maskNumber(target.mcNumber);
  if (target.dotNumber) target.dotNumber = maskNumber(target.dotNumber);
  return listing;
}

/**
 * Listing IDs the user completed a purchase on. Used so the actual buyer keeps
 * access to the MC/DOT of a listing after it flips to SOLD.
 */
export async function getPurchasedListingIds(
  userId: string | undefined,
  listingIds: string[]
): Promise<Set<string>> {
  if (!userId || listingIds.length === 0) return new Set();

  const purchases = await Transaction.findAll({
    where: {
      buyerId: userId,
      listingId: { [Op.in]: listingIds },
      status: TransactionStatus.COMPLETED,
    },
    attributes: ['listingId'],
  });

  return new Set(purchases.map((p: any) => p.listingId));
}

/**
 * Mask MC/DOT on every SOLD listing the viewer isn't entitled to see.
 * Safe to call with any mix of sold and unsold listings.
 */
export async function maskSoldListings<T extends Record<string, any>>(
  listings: T[],
  viewer: { userId?: string; role?: UserRole | string }
): Promise<T[]> {
  const soldIds = listings.filter((l) => isSold(l.status)).map((l) => l.id);
  if (soldIds.length === 0) return listings;

  const purchasedIds =
    viewer.role === UserRole.ADMIN
      ? new Set<string>()
      : await getPurchasedListingIds(viewer.userId, soldIds);

  return listings.map((listing) => {
    if (!isSold(listing.status)) return listing;
    const allowed = canSeeSoldNumbers({
      listing,
      userId: viewer.userId,
      role: viewer.role,
      isPurchaser: purchasedIds.has(listing.id),
    });
    return allowed ? listing : maskListingNumbers(listing);
  });
}
