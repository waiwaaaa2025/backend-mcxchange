import { Op } from 'sequelize';
import { MASKED_NUMBER, sanitizeListing } from './listingSanitize';
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

/**
 * Whether this viewer may see a SOLD listing at all. Once sold, a listing's
 * details (city, fleet, years, safety record, trucks, FMCSA intel) are enough
 * to look the MC back up, so everyone outside the deal gets a 404 instead.
 */
export async function canViewSoldListing(
  listing: { id: string; sellerId?: string | null },
  viewer: { userId?: string; role?: UserRole | string }
): Promise<boolean> {
  if (viewer.role === UserRole.ADMIN) return true;
  if (!viewer.userId) return false;
  if (listing.sellerId === viewer.userId) return true;
  return (await getPurchasedListingIds(viewer.userId, [listing.id])).has(listing.id);
}

/**
 * The only thing the public learns about a sale: that one happened, roughly
 * where, and when (month). No id, so there is nothing to follow back to the
 * listing; no city, fleet, years or ratings to cross-reference against FMCSA.
 */
export function soldListingStub(listing: Record<string, any>) {
  const soldAt = listing.soldAt || listing.updatedAt;
  const d = soldAt ? new Date(soldAt) : null;
  return {
    status: ListingStatus.SOLD,
    state: listing.state || null,
    authorityType: listing.authorityType || null,
    soldMonth: d && !isNaN(d.getTime())
      ? `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
      : null,
  };
}

/**
 * A sold listing as it appears in a buyer's own saved/unlocked lists when they
 * weren't party to the sale: enough to say "this one sold", nothing to look up.
 */
export function soldListingRow(listing: Record<string, any>, extra: Record<string, any> = {}) {
  return {
    id: listing.id,
    title: 'Sold Authority',
    mcNumber: MASKED_NUMBER,
    dotNumber: null,
    legalName: null,
    dbaName: null,
    ...soldListingStub(listing),
    ...extra,
  };
}

/**
 * Mask a buyer's own saved/unlocked rows: sold listings collapse to
 * soldListingRow unless the viewer was in the deal; unsold ones the viewer
 * hasn't unlocked go through sanitizeListing.
 */
export async function maskBuyerListingRows(
  rows: Array<{ listing: Record<string, any>; extra?: Record<string, any>; unlocked: boolean }>,
  viewer: { userId?: string; role?: UserRole | string }
): Promise<Record<string, any>[]> {
  const soldIds = rows.filter((r) => isSold(r.listing.status)).map((r) => r.listing.id);
  const purchased = viewer.role === UserRole.ADMIN ? new Set<string>() : await getPurchasedListingIds(viewer.userId, soldIds);
  return rows.map(({ listing, extra = {}, unlocked }) => {
    const party = viewer.role === UserRole.ADMIN || listing.sellerId === viewer.userId || purchased.has(listing.id);
    if (isSold(listing.status) && !party) return soldListingRow(listing, extra);
    if (unlocked || party) return { ...listing, ...extra };
    return { ...sanitizeListing(listing), ...extra };
  });
}
