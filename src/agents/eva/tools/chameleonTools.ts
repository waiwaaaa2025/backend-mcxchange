import { Op } from 'sequelize';
import { Listing, ListingStatus, UnlockedListing, UserRole } from '../../../models';
import { chameleonIntelService, resolveMcToDot, summarizeIntelForAgent } from '../../../services/chameleonIntelService';
import { hasCarrierPulseAccess } from '../../../utils/carrierPulseAccess';
import type { AgentContext, ToolDef } from '../../core/types';

const CHECK_PAGE: Record<string, string> = {
  [UserRole.ADMIN]: '/admin/chameleon-check',
  [UserRole.SELLER]: '/seller/chameleon-check',
  [UserRole.BUYER]: '/buyer/chameleon-check',
};

// A listing's DOT is masked until the buyer unlocks it, so Eva may only check a
// listing the buyer has unlocked (or the seller owns).
async function dotForListing(listingId: string, ctx: AgentContext): Promise<{ dot?: string; error?: string }> {
  const listing = await Listing.findByPk(listingId, { attributes: ['id', 'dotNumber', 'sellerId'] });
  if (!listing) return { error: 'Listing not found.' };
  const allowed =
    ctx.role === UserRole.ADMIN ||
    (ctx.role === UserRole.SELLER && listing.sellerId === ctx.userId) ||
    !!(await UnlockedListing.findOne({ where: { userId: ctx.userId, listingId }, attributes: ['id'] }));
  if (!allowed) return { error: 'Unlock this listing first — its DOT number stays hidden until you do.' };
  if (!listing.dotNumber) return { error: 'This listing has no DOT number on file.' };
  return { dot: String(listing.dotNumber) };
}

export function buildChameleonTools(): ToolDef[] {
  return [
    {
      schema: {
        type: 'function',
        function: {
          name: 'chameleon_check',
          description:
            'Chameleon carrier check from FMCSA data: other DOT numbers running the same trucks/trailers (VINs), other DOTs sharing the phone, email, officer names or street address, FMCSA prior-revocation links, and name/address/phone/officer changes over time (possible ownership change). Pass exactly one of dotNumber, mcNumber, or listingId (a listing the user has unlocked). Takes 5–10 seconds.',
          parameters: {
            type: 'object',
            properties: {
              dotNumber: { type: 'string', description: 'USDOT number' },
              mcNumber: { type: 'string', description: 'MC docket number, with or without the MC prefix' },
              listingId: { type: 'string', description: 'Domilea listing id (must be unlocked by the user)' },
            },
            additionalProperties: false,
          },
        },
      },
      handler: async (args: any, ctx) => {
        if (!ctx.userId) return { error: 'no user in context' };
        if (!(await hasCarrierPulseAccess(ctx.userId, ctx.role))) {
          return {
            error: 'Chameleon Check is included with any Domilea subscription or the CarrierPulse add-on. The user does not have access yet.',
            upgradePath: '/buyer/chameleon-check',
          };
        }

        let dot: string | null = null;
        if (args.listingId) {
          const r = await dotForListing(String(args.listingId), ctx);
          if (r.error) return { error: r.error };
          dot = r.dot!;
        } else if (args.mcNumber) {
          dot = await resolveMcToDot(String(args.mcNumber));
          if (!dot) return { error: `No carrier found for MC ${args.mcNumber} in the FMCSA census.` };
        } else if (args.dotNumber) {
          dot = String(args.dotNumber).replace(/\D/g, '');
        }
        if (!dot) return { error: 'Provide a DOT number, MC number, or an unlocked listing.' };

        const intel = await chameleonIntelService.getIntel(dot);
        if (!intel) return { error: `DOT ${dot} is not in the FMCSA census.` };
        return {
          ...summarizeIntelForAgent(intel),
          fullReportPath: `${CHECK_PAGE[ctx.role || UserRole.BUYER] || CHECK_PAGE[UserRole.BUYER]}/${dot}`,
        };
      },
    },
  ];
}

// Buyers need their unlocked listings (with the now-visible DOT/MC) to ask
// "check everything I've unlocked".
export function buildUnlockedListingsTool(): ToolDef {
  return {
    schema: {
      type: 'function',
      function: {
        name: 'get_my_unlocked_listings',
        description: 'Listings the buyer has unlocked with credits, including their MC and DOT numbers. Use with chameleon_check (listingId) to vet them.',
        parameters: {
          type: 'object',
          properties: { limit: { type: 'integer' } },
          additionalProperties: false,
        },
      },
    },
    handler: async (args: any, ctx) => {
      if (!ctx.userId) return { error: 'no user in context' };
      const limit = Math.min(50, Math.max(1, args.limit || 20));
      const rows = await UnlockedListing.findAll({
        where: { userId: ctx.userId },
        order: [['createdAt', 'DESC']],
        limit,
        include: [{
          model: Listing,
          as: 'listing',
          // Sold or taken-down listings drop off the unlocked list.
          required: true,
          where: { status: { [Op.in]: [ListingStatus.ACTIVE, ListingStatus.RESERVED] } },
          attributes: ['id', 'title', 'mcNumber', 'dotNumber', 'askingPrice', 'state', 'status'],
        }],
      });
      return {
        count: rows.length,
        unlocked: rows.map((r: any) => ({ unlockedAt: r.createdAt, ...(r.listing?.toJSON?.() || {}) })),
      };
    },
  };
}
