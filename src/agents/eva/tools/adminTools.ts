import { Lead, User, UserRole } from '../../../models';
import morproLinqService, { type LinqSearchFilters } from '../../../services/morproLinqService';
import type { ToolDef } from '../../core/types';

function isoDateOffset(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

export function buildAdminTools(): ToolDef[] {
  return [
    {
      schema: {
        type: 'function',
        function: {
          name: 'who_am_i',
          description: 'Returns the current admin user (name, email, role).',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
        },
      },
      handler: async (_args, ctx) => {
        if (!ctx.userId) return { error: 'no user in context' };
        const u = await User.findByPk(ctx.userId, { attributes: ['id', 'name', 'email', 'role'] });
        return u || { error: 'user not found' };
      },
    },

    {
      schema: {
        type: 'function',
        function: {
          name: 'search_carriers',
          description:
            'Search Domilea\'s local snapshot of carriers (synced from LINQ). Use this for filtering by state, fleet size, authority status, safety rating, name substring, carrier age, or "insurance expires within N days" (where data exists).',
          parameters: {
            type: 'object',
            properties: {
              state: { type: 'string', description: '2-letter US state code' },
              nameContains: { type: 'string', description: 'case-insensitive substring of legal name' },
              minFleet: { type: 'integer' },
              maxFleet: { type: 'integer' },
              authorityStatus: { type: 'string' },
              safetyRating: { type: 'string' },
              insuranceExpiresWithinDays: { type: 'integer', description: 'e.g. 30 for next 30 days' },
              addedBefore: { type: 'string', description: 'YYYY-MM-DD' },
              addedAfter: { type: 'string', description: 'YYYY-MM-DD' },
              limit: { type: 'integer', description: 'default 25, max 50' },
              cursor: { type: 'string', description: 'next_cursor from a previous call, to get the next page' },
            },
            additionalProperties: false,
          },
        },
      },
      handler: async (args: any) => {
        const filters: LinqSearchFilters = { limit: Math.min(50, Math.max(1, args.limit || 25)) };
        if (args.cursor) filters.cursor = String(args.cursor);
        if (args.state) filters.state = String(args.state).toUpperCase();
        if (args.authorityStatus) filters.status = String(args.authorityStatus).toUpperCase();
        if (args.safetyRating) filters.safety_rating = args.safetyRating;
        if (args.minFleet != null) filters.min_fleet_size = args.minFleet;
        if (args.maxFleet != null) filters.max_fleet_size = args.maxFleet;
        if (args.addedBefore) filters.added_before = args.addedBefore;
        if (args.addedAfter) filters.added_after = args.addedAfter;
        if (args.nameContains) filters.name_contains = args.nameContains;
        if (args.insuranceExpiresWithinDays != null) {
          filters.insurance_cancels_after = isoDateOffset(0);
          filters.insurance_cancels_before = isoDateOffset(args.insuranceExpiresWithinDays);
          filters.has_active_insurance = true;
        }
        const res = await morproLinqService.searchCarriers(filters);
        if (!res) return { error: 'LINQ search failed' };
        return {
          limit: res.limit,
          has_more: res.has_more,
          next_cursor: res.next_cursor ?? null,
          returned: res.carriers?.length || 0,
          carriers: res.carriers,
        };
      },
    },

    {
      schema: {
        type: 'function',
        function: {
          name: 'get_carrier',
          description: 'Live LINQ report for a single carrier by DOT number — full FMCSA profile, authority, safety, insurance status.',
          parameters: {
            type: 'object',
            properties: { dotNumber: { type: 'string' } },
            required: ['dotNumber'],
            additionalProperties: false,
          },
        },
      },
      handler: async (args: any) => {
        if (!args.dotNumber) return { error: 'dotNumber required' };
        if (!morproLinqService.isConfigured()) return { error: 'LINQ API key not set' };
        const report = await morproLinqService.getFullReport(String(args.dotNumber));
        if (!report) return { error: `No data for DOT ${args.dotNumber}` };
        return { dotNumber: args.dotNumber, report };
      },
    },

    {
      schema: {
        type: 'function',
        function: {
          name: 'search_leads',
          description: 'Search saved leads (carriers reps have flagged for outreach). Admin sees all leads across reps.',
          parameters: {
            type: 'object',
            properties: {
              status: { type: 'string', enum: ['NEW', 'CONTACTED', 'INTERESTED', 'NOT_INTERESTED', 'CALLBACK', 'WON', 'DEAD'] },
              assignedToUserId: { type: 'string', description: 'UUID of an admin rep' },
              dotNumber: { type: 'string' },
              limit: { type: 'integer' },
            },
            additionalProperties: false,
          },
        },
      },
      handler: async (args: any) => {
        const where: any = {};
        if (args.status) where.status = args.status;
        if (args.assignedToUserId) where.assignedToUserId = args.assignedToUserId;
        if (args.dotNumber) where.dotNumber = String(args.dotNumber);
        const limit = Math.min(100, Math.max(1, args.limit || 25));
        const rows = await Lead.findAll({
          where,
          order: [['updatedAt', 'DESC']],
          limit,
          include: [{ model: User, as: 'assignee', attributes: ['id', 'name', 'email'] }],
        });
        return { count: rows.length, leads: rows };
      },
    },

    {
      schema: {
        type: 'function',
        function: {
          name: 'get_lead',
          description: 'Get a single lead by id or DOT number, with live carrier intelligence from LINQ.',
          parameters: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              dotNumber: { type: 'string' },
              includeCarrierReport: { type: 'boolean', description: 'Fetch the live LINQ carrier report (slower, more detail).' },
            },
            additionalProperties: false,
          },
        },
      },
      handler: async (args: any) => {
        const where: any = {};
        if (args.id) where.id = args.id;
        else if (args.dotNumber) where.dotNumber = String(args.dotNumber);
        else return { error: 'Provide id or dotNumber' };
        const lead = await Lead.findOne({
          where,
          include: [{ model: User, as: 'assignee', attributes: ['id', 'name', 'email'] }],
        });
        if (!lead) return { error: 'lead not found' };
        let report = null;
        if (args.includeCarrierReport && morproLinqService.isConfigured()) {
          report = await morproLinqService.getFullReport(lead.dotNumber);
        }
        return { lead, ...(report ? { report } : {}) };
      },
    },
  ];
}
