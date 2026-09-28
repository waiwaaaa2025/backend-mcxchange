import { Op } from 'sequelize';
import { Listing, Offer, SavedListing, Subscription, User, UnlockedListing, ListingStatus, ListingVisibility, OfferStatus } from '../../../models';
import { sanitizeListing } from '../../../utils/listingSanitize';
import type { ToolDef } from '../../core/types';

// Listings reach buyers through Eva the same way as through the listings API:
// MC/DOT, legal name and identifying title text stay masked until unlocked.
async function maskUnlessUnlocked(listings: any[], userId: string | null): Promise<any[]> {
  const ids = listings.map((l) => l?.id).filter(Boolean);
  const unlocked = userId && ids.length
    ? new Set((await UnlockedListing.findAll({ where: { userId, listingId: ids }, attributes: ['listingId'] })).map((u) => u.listingId))
    : new Set<string>();
  return listings.map((l) => {
    if (!l) return l;
    if (unlocked.has(l.id)) return l.toJSON ? l.toJSON() : l;
    const { legalName, dbaName, ...safe } = sanitizeListing(l);
    return safe;
  });
}

export function buildBuyerTools(): ToolDef[] {
  return [
    {
      schema: {
        type: 'function',
        function: {
          name: 'search_marketplace',
          description: 'Search active public listings on the Domilea marketplace by state, price, fleet size, authority age, or text.',
          parameters: {
            type: 'object',
            properties: {
              state: { type: 'string', description: '2-letter US state code' },
              minPrice: { type: 'integer' },
              maxPrice: { type: 'integer' },
              minFleet: { type: 'integer' },
              maxFleet: { type: 'integer' },
              minYearsActive: { type: 'integer' },
              query: { type: 'string', description: 'substring match on title or legal name' },
              limit: { type: 'integer' },
            },
            additionalProperties: false,
          },
        },
      },
      handler: async (args: any, ctx) => {
        const where: any = {
          status: ListingStatus.ACTIVE,
          visibility: ListingVisibility.PUBLIC,
        };
        if (args.state) where.state = String(args.state).toUpperCase();
        if (args.minPrice != null) where.askingPrice = { [Op.gte]: args.minPrice };
        if (args.maxPrice != null) where.askingPrice = { ...(where.askingPrice || {}), [Op.lte]: args.maxPrice };
        if (args.minFleet != null) where.fleetSize = { [Op.gte]: args.minFleet };
        if (args.maxFleet != null) where.fleetSize = { ...(where.fleetSize || {}), [Op.lte]: args.maxFleet };
        if (args.minYearsActive != null) where.yearsActive = { [Op.gte]: args.minYearsActive };
        // Title only — matching the hidden legal name would confirm which carrier a listing is.
        if (args.query) where.title = { [Op.like]: `%${args.query}%` };
        const limit = Math.min(100, Math.max(1, args.limit || 25));
        const { rows, count } = await Listing.findAndCountAll({
          where,
          limit,
          order: [['createdAt', 'DESC']],
          attributes: [
            'id', 'title', 'mcNumber', 'dotNumber', 'legalName', 'dbaName', 'askingPrice', 'state', 'city', 'fleetSize',
            'totalDrivers', 'safetyRating', 'yearsActive', 'isPremium', 'createdAt',
          ],
        });
        return { total: count, returned: rows.length, listings: await maskUnlessUnlocked(rows, ctx.userId) };
      },
    },

    {
      schema: {
        type: 'function',
        function: {
          name: 'get_my_saved_listings',
          description: 'The buyer’s saved listings.',
          parameters: {
            type: 'object',
            properties: { limit: { type: 'integer' } },
            additionalProperties: false,
          },
        },
      },
      handler: async (args: any, ctx) => {
        if (!ctx.userId) return { error: 'no user in context' };
        const limit = Math.min(100, Math.max(1, args.limit || 25));
        const rows = await SavedListing.findAll({
          where: { userId: ctx.userId },
          order: [['createdAt', 'DESC']],
          limit,
          include: [{
            model: Listing,
            as: 'listing',
            attributes: ['id', 'title', 'mcNumber', 'dotNumber', 'legalName', 'dbaName', 'askingPrice', 'state', 'city', 'fleetSize', 'status'],
          }],
        });
        const listings = await maskUnlessUnlocked(rows.map((r: any) => r.listing), ctx.userId);
        return { count: rows.length, saved: rows.map((r: any, i) => ({ savedAt: r.createdAt, listing: listings[i] })) };
      },
    },

    {
      schema: {
        type: 'function',
        function: {
          name: 'get_my_offers_sent',
          description: 'Offers the buyer has sent on listings. Optional filter by status.',
          parameters: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: Object.values(OfferStatus) },
              limit: { type: 'integer' },
            },
            additionalProperties: false,
          },
        },
      },
      handler: async (args: any, ctx) => {
        if (!ctx.userId) return { error: 'no user in context' };
        const where: any = { buyerId: ctx.userId };
        if (args.status) where.status = args.status;
        const limit = Math.min(100, Math.max(1, args.limit || 25));
        const rows = await Offer.findAll({
          where,
          order: [['createdAt', 'DESC']],
          limit,
          include: [{ model: Listing, as: 'listing', attributes: ['id', 'title', 'mcNumber', 'dotNumber', 'legalName', 'dbaName', 'askingPrice', 'state'] }],
        });
        const listings = await maskUnlessUnlocked(rows.map((r: any) => r.listing), ctx.userId);
        return {
          count: rows.length,
          offers: rows.map((r: any, i) => ({ ...r.toJSON(), listing: listings[i] })),
        };
      },
    },

    {
      schema: {
        type: 'function',
        function: {
          name: 'get_my_credits',
          description: 'The buyer’s current subscription plan, credit balance, and renewal date.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      handler: async (_args, ctx) => {
        if (!ctx.userId) return { error: 'no user in context' };
        const [user, sub] = await Promise.all([
          User.findByPk(ctx.userId, { attributes: ['totalCredits', 'usedCredits'] }),
          Subscription.findOne({ where: { userId: ctx.userId } }),
        ]);
        if (!user) return { error: 'user not found' };
        const totalCredits = (user as any).totalCredits ?? 0;
        const usedCredits = (user as any).usedCredits ?? 0;
        return {
          totalCredits,
          usedCredits,
          remainingCredits: Math.max(0, totalCredits - usedCredits),
          subscription: sub
            ? {
                plan: (sub as any).plan,
                status: (sub as any).status,
                renewsAt: (sub as any).currentPeriodEnd,
                creditsPerMonth: (sub as any).creditsPerMonth,
              }
            : null,
        };
      },
    },
  ];
}
