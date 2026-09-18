import { Request, Response } from 'express';
import { Op, WhereOptions, fn, col, literal } from 'sequelize';
import { Lead, LeadStatus, User, UserRole, AgentAction } from '../models';
import morproLinqService, {
  safetyLabel,
  splitLocalFilters,
  type LinqSearchFilters,
  type LinqCarrierRow,
} from '../services/morproLinqService';
import fmcsaLeadsService from '../services/fmcsaLeadsService';
import fmcsaNewCarriersService, { type NewCarrierFilters } from '../services/fmcsaNewCarriersService';
import type { InsuranceLead, InsuranceLeadFilters } from '../types/carrierData';
import { logLeadActivity, type LeadActivityKind } from '../services/leadActivity.service';
import logger from '../utils/logger';

interface AuthedRequest extends Request {
  user?: { id: string; role: UserRole };
}

function parseInt10(v: unknown, fallback: number): number {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function isoDateOffset(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

// Map the Leads-UI query params → LINQ search filters.
// LINQ is the indexed source of truth; we don't second-guess its predicates.
function buildLinqFilters(q: Request['query']): LinqSearchFilters {
  const f: LinqSearchFilters = {};
  if (q.state) f.state = String(q.state).toUpperCase();
  if (q.authorityStatus) f.status = String(q.authorityStatus).toUpperCase();
  if (q.safetyRating) f.safety_rating = String(q.safetyRating);
  if (q.minFleet) f.min_fleet_size = parseInt10(q.minFleet, 0);
  if (q.maxFleet) f.max_fleet_size = parseInt10(q.maxFleet, Number.MAX_SAFE_INTEGER);
  if (q.name) f.name_contains = String(q.name);
  if (q.addedBefore) f.added_before = String(q.addedBefore);
  if (q.addedAfter) f.added_after = String(q.addedAfter);
  // Headline filter: "insurance expires in next N days" → LINQ Round-4 filter pair
  if (q.insuranceExpiresWithinDays) {
    const days = parseInt10(q.insuranceExpiresWithinDays, 30);
    f.insurance_cancels_after = isoDateOffset(0);
    f.insurance_cancels_before = isoDateOffset(days);
    f.has_active_insurance = true;
  }
  return f;
}

// Map a LINQ search row to the list-page shape — no extra HTTP calls. The row's own
// insurance_summary is deliberately ignored: it reports policies on file without
// applying their cancellations, so the date comes from FMCSA in withInsurance().
function rowToListShape(c: LinqCarrierRow, insuranceCancel: string | null = null) {
  return {
    dotNumber: String(c.dot_number),
    legalName: c.legal_name,
    dba: (c as any).dba_name || null,
    state: c.state,
    totalPowerUnits: c.power_units,
    totalDrivers: (c as any).drivers || null,
    authorityStatus: c.status,
    safetyRating: safetyLabel(c.safety_rating),
    insuranceCancellationDate: insuranceCancel,
  };
}

function leadTypeFrom(v: unknown): InsuranceLeadFilters['leadType'] {
  return v === 'cancellation' || v === 'renewal' ? v : 'all';
}

// The insurance filter can't be served by LINQ: probed live, its
// `insurance_cancels_*` search returns a tiny fraction of the carriers FMCSA
// itself lists (3 vs 112 for Illinois in a 30-day window), and its per-row
// insurance summary ignores cancellations altogether. When the user asks for
// insurance, the search runs against FMCSA's own feed instead — the same code
// behind the Insurance Leads tool, so both tools agree.
function insuranceFiltersFrom(q: Request['query']): InsuranceLeadFilters {
  return {
    expiringWithinDays: parseInt10(q.insuranceExpiresWithinDays, 30),
    leadType: leadTypeFrom(q.insuranceLeadType),
    state: q.state ? String(q.state).toUpperCase() : undefined,
    minUnits: q.minFleet ? parseInt10(q.minFleet, 0) : undefined,
    maxUnits: q.maxFleet ? parseInt10(q.maxFleet, Number.MAX_SAFE_INTEGER) : undefined,
    minSafety: q.safetyRating ? String(q.safetyRating) : undefined,
    nameContains: q.name ? String(q.name) : undefined,
    addedAfter: q.addedAfter ? String(q.addedAfter) : undefined,
    addedBefore: q.addedBefore ? String(q.addedBefore) : undefined,
  };
}

// FMCSA lead → the same list shape LINQ rows map to. Contact comes free with the
// census row, so these rows don't need the per-carrier hydration LINQ needs.
function leadToListShape(l: InsuranceLead) {
  return {
    dotNumber: l.dotNumber,
    legalName: l.legalName,
    dba: null,
    state: l.state,
    totalPowerUnits: l.powerUnits,
    totalDrivers: null,
    // The FMCSA lead search only ever returns carriers whose census record and
    // operating authority are both active.
    authorityStatus: 'ACTIVE',
    safetyRating: l.safetyRating,
    // A renewal isn't a cancellation: its date travels separately so the
    // pipeline's "cancelling this week" count never picks it up.
    insuranceCancellationDate: l.pendingReason === 'RENEWAL_DUE' ? null : l.insuranceExpiryDate,
    insuranceRenewalDate: l.pendingReason === 'RENEWAL_DUE' ? l.insuranceExpiryDate : null,
    insuranceStatus: l.pendingReason,
    insuranceCompany: l.insuranceCompany,
    phone: l.phone,
    email: l.email,
  };
}

// Attach the real insurance verdict to a page of LINQ rows: two FMCSA queries for
// the whole page, never one per row. LINQ's own insurance summary is stale, so a
// row shows nothing rather than a date FMCSA no longer stands behind.
async function withInsurance<T extends { dotNumber: string }>(rows: T[]) {
  const snapshots = await fmcsaLeadsService.insuranceStatusFor(rows.map((r) => r.dotNumber));
  return rows.map((row) => {
    const snap = snapshots?.get(row.dotNumber);
    return {
      ...row,
      insuranceCancellationDate: snap?.cancellationDate ?? null,
      insuranceStatus: snap?.status ?? null,
      insuranceCompany: snap?.insuranceCompany ?? snap?.renewalCompany ?? null,
      insuranceRenewalDate: snap?.renewalDate ?? null,
    };
  });
}

// Used by CSV export (small, bounded). NEVER use on the list page —
// the per-row /carrier hydration is the slowness culprit. Phone/email live on
// the LINQ detail record, not /search; the cancellation date is on the row.
async function hydrateForCsv(rows: LinqCarrierRow[]) {
  // FMCSA's census is the carrier's own filing and answers for the whole batch in
  // one query, so it is the number we publish; LINQ is asked only about the rows
  // the census leaves incomplete.
  const dots = rows.map((c) => String(c.dot_number));
  const census = await fmcsaLeadsService.contactsFor(dots);

  return Promise.all(rows.map(async (c) => {
    const dot = String(c.dot_number);
    const hit = census.get(dot);
    let phone = hit?.phone || null;
    let email = hit?.email || null;
    if (!phone || !email) {
      const carrier = (await morproLinqService.getCarrier(dot)) as any;
      phone = phone || carrier?.phone || carrier?.cell_phone || null;
      email = email || carrier?.email || null;
    }
    return { ...rowToListShape(c), phone, email };
  }));
}

// GET /api/admin/leads/carriers/search?state=TX&insuranceExpiresWithinDays=30&cursor=…&limit=25
export async function searchCarriers(req: Request, res: Response) {
  // LINQ pages by cursor (it ignores `page`) and rejects limit > 50.
  const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
  const limit = Math.min(50, Math.max(1, parseInt10(req.query.limit, 25)));

  // An insurance search goes to FMCSA, which actually has the cancellations.
  if (req.query.insuranceExpiresWithinDays) {
    const insuranceFilters = insuranceFiltersFrom(req.query);
    const leads = await fmcsaLeadsService.searchInsuranceLeads(insuranceFilters, cursor ?? null, limit);
    if (!leads) {
      return res.status(502).json({ success: false, error: 'Insurance lead search unavailable' });
    }
    return res.json({
      success: true,
      data: {
        carriers: leads.results.map(leadToListShape),
        limit: leads.limit,
        hasMore: leads.hasMore,
        nextCursor: leads.nextCursor,
        total: leads.total,
        insuranceHorizon: isoDateOffset(insuranceFilters.expiringWithinDays ?? 30),
      },
    });
  }

  // Default to status:ACTIVE for prospecting when no filter is set.
  const userFilters = buildLinqFilters(req.query);
  const filters: LinqSearchFilters = {
    ...(Object.keys(userFilters).length === 0 ? { status: 'ACTIVE' } : userFilters),
    limit,
    ...(cursor ? { cursor } : {}),
  };
  const result = await morproLinqService.searchCarriersFiltered(filters);
  if (!result) {
    return res.status(502).json({ success: false, error: 'LINQ search unavailable' });
  }

  // No per-row hydration — search response only. Safety rating, and status when
  // combined with state, are matched on our side — see splitLocalFilters. The
  // insurance column is filled from FMCSA for the page as a whole.
  const carriers = await withInsurance(result.carriers.map((c) => rowToListShape(c)));

  res.json({
    success: true,
    data: {
      carriers,
      limit,
      hasMore: result.hasMore,
      nextCursor: result.nextCursor != null ? String(result.nextCursor) : null,
      insuranceHorizon: null,
    },
  });
}

// GET /api/admin/leads/carriers/:dot - fast two-call detail (carrier + insurance).
// Pass ?full=true for the aggregated /report endpoint (slower, more comprehensive).
export async function getCarrierDetail(req: Request, res: Response) {
  const { dot } = req.params;

  if (!morproLinqService.isConfigured()) {
    return res.status(503).json({
      success: false,
      error: 'MORPRO_LINQ_API_KEY not set — live report unavailable',
    });
  }

  if (req.query.full === 'true') {
    const report = await morproLinqService.getFullReport(dot);
    if (!report) return res.status(404).json({ success: false, error: `No data for DOT ${dot}` });
    return res.json({ success: true, data: { report } });
  }

  const [carrier, insurance] = await Promise.all([
    morproLinqService.getCarrier(dot),
    morproLinqService.getInsurance(dot),
  ]);
  if (!carrier && !insurance) {
    return res.status(404).json({ success: false, error: `No data for DOT ${dot}` });
  }
  res.json({ success: true, data: { carrier, insurance } });
}

// GET /api/admin/leads/carriers/export.csv?...same filters as search
// Paginates LINQ search up to maxRows total, hydrates each row in parallel batches.
export async function exportCarriersCsv(req: Request, res: Response) {
  const maxRows = Math.min(1000, Math.max(1, parseInt10(req.query.limit, 200)));

  // Insurance export comes from FMCSA, like the search does, and its rows already
  // carry the census phone/email — no per-carrier hydration needed.
  if (req.query.insuranceExpiresWithinDays) {
    const insuranceFilters = insuranceFiltersFrom(req.query);
    const rows: ReturnType<typeof leadToListShape>[] = [];
    let leadCursor: string | null = null;
    do {
      const page = await fmcsaLeadsService.searchInsuranceLeads(insuranceFilters, leadCursor, 50);
      if (!page) {
        return res.status(502).json({ success: false, error: 'Insurance lead search unavailable' });
      }
      rows.push(...page.results.map(leadToListShape));
      leadCursor = page.nextCursor;
    } while (leadCursor && rows.length < maxRows);
    return sendCarriersCsv(res, rows.slice(0, maxRows));
  }

  // Safety (and status alongside state) can't go to LINQ — match rows here.
  const { linq: baseFilters, matches, hasLocal } = splitLocalFilters(buildLinqFilters(req.query));

  const collected: Awaited<ReturnType<typeof hydrateForCsv>> = [];
  const pageSize = 50; // LINQ max
  // Local filters can discard most of a page; cap the scan so a sparse match
  // can't walk an entire state.
  const maxScanPages = Math.ceil(maxRows / pageSize) * (hasLocal ? 4 : 1);
  let pagesRead = 0;
  let cursor: string | number | undefined;

  while (collected.length < maxRows) {
    const filters: LinqSearchFilters = {
      ...baseFilters,
      limit: pageSize,
      ...(cursor != null ? { cursor } : {}),
    };
    const result = await morproLinqService.searchCarriers(filters);
    if (!result || (result.carriers || []).length === 0) break;

    const remaining = maxRows - collected.length;
    const slice = (result.carriers || []).filter(matches).slice(0, remaining);
    const hydrated = await hydrateForCsv(slice);
    collected.push(...hydrated);

    // LINQ ignores `page`; follow next_cursor or we'd re-read page 1 forever.
    if (!result.has_more || result.next_cursor == null || ++pagesRead >= maxScanPages) break;
    cursor = result.next_cursor;
  }

  return sendCarriersCsv(res, await withInsurance(collected));
}

function sendCarriersCsv(
  res: Response,
  rows: Array<{
    dotNumber: string; legalName: string | null; dba: string | null; state: string | null;
    totalPowerUnits: number | null; totalDrivers: number | null; authorityStatus: string | null;
    safetyRating: string | null; insuranceCancellationDate: string | null;
    insuranceStatus?: string | null; insuranceCompany?: string | null; insuranceRenewalDate?: string | null;
    phone: string | null; email: string | null;
  }>
) {
  const csvHeaders = [
    'dot_number', 'legal_name', 'dba', 'state', 'total_power_units', 'total_drivers',
    'authority_status', 'safety_rating', 'insurance_cancellation_date', 'insurance_status',
    'insurance_company', 'insurance_renewal_date', 'phone', 'email',
  ];
  const escape = (v: unknown) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [csvHeaders.join(',')];
  for (const r of rows) {
    lines.push([
      r.dotNumber, r.legalName, r.dba, r.state, r.totalPowerUnits, r.totalDrivers,
      r.authorityStatus, r.safetyRating, r.insuranceCancellationDate, r.insuranceStatus ?? null,
      r.insuranceCompany ?? null, r.insuranceRenewalDate ?? null, r.phone, r.email,
    ].map(escape).join(','));
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="leads-export-${new Date().toISOString().slice(0,10)}.csv"`);
  res.send(lines.join('\n'));
}

// GET /api/admin/leads - list current rep's pipeline (or all if ?all=true)
export async function listLeads(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const all = req.query.all === 'true';
  const status = req.query.status as LeadStatus | undefined;

  const where: WhereOptions = {};
  if (!all) (where as any).assignedToUserId = userId;
  if (status) (where as any).status = status;

  const leads = await Lead.findAll({
    where,
    include: [
      { model: User, as: 'assignee', attributes: ['id', 'name', 'email'] },
      { model: User, as: 'creator', attributes: ['id', 'name', 'email'] },
    ],
    order: [['updatedAt', 'DESC']],
  });

  // The stored snapshot is whatever FMCSA said the day the lead was saved, so a rep
  // could be calling a carrier that re-insured weeks ago. One lookup for the whole
  // pipeline gives every row today's answer; the snapshot stays as the fallback.
  const withStatus = await attachLiveInsurance(leads);
  res.json({ success: true, data: withStatus });
}

// Adds `insuranceStatus` / `insuranceCancellationDate` to saved Lead rows.
const LIVE_INSURANCE_CAP = 500;
async function attachLiveInsurance(leads: Lead[]) {
  const dots = leads.slice(0, LIVE_INSURANCE_CAP).map((l) => String(l.dotNumber));
  const snapshots = dots.length ? await fmcsaLeadsService.insuranceStatusFor(dots) : new Map();
  return leads.map((lead) => {
    const snap = snapshots?.get(String(lead.dotNumber));
    return {
      ...lead.toJSON(),
      insuranceStatus: snap?.status ?? null,
      insuranceCancellationDate: snap?.cancellationDate ?? null,
      insuranceCompany: snap?.insuranceCompany ?? snap?.renewalCompany ?? null,
      insuranceRenewalDate: snap?.renewalDate ?? null,
    };
  });
}

// POST /api/admin/leads - save a carrier as a lead for the current rep.
// Pulls denormalized snapshot fields live from LINQ at save time.
export async function createLead(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const { dotNumber, assignedToUserId, notes, status } = req.body as {
    dotNumber: string;
    assignedToUserId?: string;
    notes?: string;
    status?: LeadStatus;
  };

  if (!dotNumber) return res.status(400).json({ success: false, error: 'dotNumber required' });

  // Pull a one-shot snapshot to denormalize onto the Lead row. This is a fixed
  // cost per save (not a mirror). Scout's enrich_lead refreshes these same fields
  // when it runs (and adds the AI summary to notes).
  //
  // Insurance and contact come from FMCSA: the provider's `earliest_cancellation_date`
  // comes back null for carriers that demonstrably have a cancellation filed, and its
  // phone/email disagree with the carrier's own filing.
  const [snapshots, contacts] = await Promise.all([
    fmcsaLeadsService.insuranceStatusFor([dotNumber]),
    fmcsaLeadsService.contactsFor([dotNumber]),
  ]);
  const snapshot = snapshots?.get(dotNumber) ?? null;
  let insuranceCancel: string | null = snapshot?.cancellationDate ?? null;
  let phone: string | null = contacts.get(dotNumber)?.phone ?? null;
  let email: string | null = contacts.get(dotNumber)?.email ?? null;
  let carrierName: string | null = null;

  if (morproLinqService.isConfigured()) {
    const carrier: any = (await morproLinqService.getCarrier(dotNumber)) || {};
    carrierName = carrier.legal_name || null;
    phone = phone || carrier.phone || carrier.cell_phone || null;
    email = email || carrier.email || null;
  }

  const [lead, created] = await Lead.findOrCreate({
    where: { assignedToUserId: assignedToUserId || userId, dotNumber },
    defaults: {
      dotNumber,
      assignedToUserId: assignedToUserId || userId,
      createdByUserId: userId,
      status: status || LeadStatus.NEW,
      notes,
      carrierNameSnapshot: carrierName,
      phoneSnapshot: phone,
      emailSnapshot: email,
      insuranceCancellationSnapshot: insuranceCancel,
    } as any,
  });

  res.status(created ? 201 : 200).json({ success: true, data: lead, alreadyExisted: !created });
}

// PATCH /api/admin/leads/:id - update status, notes, last-contacted, reassign.
// Each meaningful field change emits a typed event into agent_actions so the
// lead timeline shows status/assignee/notes history alongside Scout's enrichments.
export async function updateLead(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const { id } = req.params;
  const lead = await Lead.findByPk(id);
  if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });

  const before = {
    status: lead.status,
    notes: lead.notes || '',
    assignedToUserId: lead.assignedToUserId,
  };

  const { status, notes, lastContactedAt, assignedToUserId } = req.body;
  const patch: Partial<Lead> = {};
  if (status) (patch as any).status = status;
  if (notes !== undefined) (patch as any).notes = notes;
  if (lastContactedAt) (patch as any).lastContactedAt = new Date(lastContactedAt);
  if (assignedToUserId) (patch as any).assignedToUserId = assignedToUserId;

  await lead.update(patch as any);

  // Activity log — one row per meaningful change.
  if (status && status !== before.status) {
    await logLeadActivity({
      leadId: lead.id, userId, actionType: 'status_changed',
      outputData: { from: before.status, to: status },
    });
  }
  if (assignedToUserId && assignedToUserId !== before.assignedToUserId) {
    await logLeadActivity({
      leadId: lead.id, userId, actionType: 'assignee_changed',
      outputData: { from: before.assignedToUserId, to: assignedToUserId },
    });
  }
  if (notes !== undefined && notes !== before.notes) {
    await logLeadActivity({
      leadId: lead.id, userId, actionType: 'note_updated',
      inputData: { newLength: (notes || '').length, oldLength: before.notes.length },
    });
  }

  logger.info('Lead updated', { leadId: id, by: userId });
  res.json({ success: true, data: lead });
}

// GET /api/admin/leads/:id/activity - typed timeline pulled from agent_actions.
export async function getLeadActivity(req: AuthedRequest, res: Response) {
  const { id } = req.params;
  const lead = await Lead.findByPk(id);
  if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });

  const rows = await AgentAction.findAll({
    where: { targetType: 'lead', targetId: id },
    order: [['createdAt', 'DESC']],
    limit: 100,
  });

  // Resolve user names for triggeredBy: 'user:<uuid>' rows so the UI can label
  // each entry without a second round trip.
  const userIds = new Set<string>();
  for (const r of rows) {
    if (r.triggeredBy?.startsWith('user:')) userIds.add(r.triggeredBy.slice(5));
  }
  const users = userIds.size
    ? await User.findAll({ where: { id: { [Op.in]: Array.from(userIds) } }, attributes: ['id', 'name', 'email'] })
    : [];
  const byId = new Map(users.map(u => [u.id, { id: u.id, name: u.name, email: u.email }]));

  res.json({
    success: true,
    data: {
      activity: rows.map(r => ({
        id: r.id,
        agentSlug: r.agentSlug,
        actionType: r.actionType,
        inputData: r.inputData,
        outputData: r.outputData,
        triggeredBy: r.triggeredBy,
        actor: r.triggeredBy?.startsWith('user:') ? byId.get(r.triggeredBy.slice(5)) || null : null,
        createdAt: r.createdAt,
      })),
    },
  });
}

// POST /api/admin/leads/:id/activity - log a manual rep activity (call/email/voicemail/note).
// Bumps Lead.lastContactedAt for contact kinds so the stats widgets stay accurate.
export async function logLeadActivityHttp(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const { id } = req.params;
  const { kind, body, outcome } = req.body as {
    kind?: 'call' | 'email' | 'voicemail' | 'note';
    body?: string;
    outcome?: string;
  };

  if (!kind || !['call', 'email', 'voicemail', 'note'].includes(kind)) {
    return res.status(400).json({ success: false, error: 'kind must be call|email|voicemail|note' });
  }

  const lead = await Lead.findByPk(id);
  if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });

  const actionType: LeadActivityKind =
    kind === 'call' ? 'call_logged'
    : kind === 'email' ? 'email_logged'
    : kind === 'voicemail' ? 'voicemail_logged'
    : 'note_updated';

  await logLeadActivity({
    leadId: lead.id,
    userId,
    actionType,
    inputData: body ? { body: body.slice(0, 2000) } : undefined,
    outputData: outcome ? { outcome } : undefined,
  });

  // Contact kinds bump lastContactedAt so the "needs follow-up" widget recovers.
  if (kind === 'call' || kind === 'email' || kind === 'voicemail') {
    await lead.update({ lastContactedAt: new Date() } as any);
  }

  res.status(201).json({ success: true });
}

// GET /api/admin/leads/pipeline/stats - 4 widget counts scoped to the current rep.
export async function getPipelineStats(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const weekOut = new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10);
  const followUpCutoff = new Date(now.getTime() - 7 * 86_400_000);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

  const [needsFollowUp, expiring, activePipeline, wonThisMonth] = await Promise.all([
    Lead.count({
      where: {
        assignedToUserId: userId,
        status: { [Op.in]: [LeadStatus.CONTACTED, LeadStatus.INTERESTED, LeadStatus.CALLBACK] },
        [Op.or]: [
          { lastContactedAt: null },
          { lastContactedAt: { [Op.lt]: followUpCutoff } },
        ],
      } as any,
    }),
    countUrgentInsurance(userId, today, weekOut),
    Lead.count({
      where: {
        assignedToUserId: userId,
        status: { [Op.notIn]: [LeadStatus.WON, LeadStatus.DEAD, LeadStatus.NOT_INTERESTED] },
      } as any,
    }),
    Lead.count({
      where: {
        assignedToUserId: userId,
        status: LeadStatus.WON,
        updatedAt: { [Op.gte]: startOfMonth },
      } as any,
    }),
  ]);

  res.json({
    success: true,
    data: { needsFollowUp, expiring, activePipeline, wonThisMonth },
  });
}

/**
 * Open leads that need calling on insurance grounds today: the carrier is already
 * running with nothing on file, or a cancellation lands inside the week. Counted
 * from FMCSA rather than the save-time snapshot, which goes stale the moment the
 * carrier re-insures — and which never marked the already-bare ones at all.
 */
async function countUrgentInsurance(userId: string, today: string, weekOut: string): Promise<number> {
  const open = await Lead.findAll({
    where: {
      assignedToUserId: userId,
      status: { [Op.notIn]: [LeadStatus.WON, LeadStatus.DEAD, LeadStatus.NOT_INTERESTED] },
    } as any,
    attributes: ['dotNumber', 'insuranceCancellationSnapshot'],
    limit: LIVE_INSURANCE_CAP,
  });
  if (open.length === 0) return 0;

  const snapshots = await fmcsaLeadsService.insuranceStatusFor(open.map((l) => String(l.dotNumber)));
  if (!snapshots) {
    // FMCSA unreachable — fall back to the stored dates rather than showing zero.
    return open.filter((l) => {
      // DATEONLY comes back as a 'YYYY-MM-DD' string, but is typed as a Date.
      const d = l.insuranceCancellationSnapshot
        ? String(l.insuranceCancellationSnapshot).slice(0, 10)
        : null;
      return !!d && d >= today && d <= weekOut;
    }).length;
  }

  return open.filter((l) => {
    const snap = snapshots.get(String(l.dotNumber));
    if (!snap) return false;
    if (snap.status === 'COVERAGE_LAPSED') return true;
    return (
      snap.status === 'CANCELLATION_SCHEDULED' &&
      !!snap.cancellationDate &&
      snap.cancellationDate >= today &&
      snap.cancellationDate <= weekOut
    );
  }).length;
}

// DELETE /api/admin/leads/:id
export async function deleteLead(req: Request, res: Response) {
  const { id } = req.params;
  const lead = await Lead.findByPk(id);
  if (!lead) return res.status(404).json({ success: false, error: 'Lead not found' });
  await lead.destroy();
  res.json({ success: true });
}

// GET /api/admin/leads/reps - list admin users (for assignment dropdown)
export async function listReps(_req: Request, res: Response) {
  const reps = await User.findAll({
    where: { role: UserRole.ADMIN },
    attributes: ['id', 'name', 'email'],
    order: [['name', 'ASC']],
  });
  res.json({ success: true, data: reps });
}

// ---------------------------------------------------------------------------
// New Carriers — brand-new DOT registrations from the FMCSA census, with email.
// ---------------------------------------------------------------------------

function newCarrierFiltersFrom(q: Request['query']): NewCarrierFilters {
  const flag = (v: unknown) => v === 'true' || v === '1';
  return {
    days: q.days ? parseInt10(q.days, 30) : 30,
    state: q.state ? String(q.state) : null,
    name: q.name ? String(q.name) : null,
    forHireOnly: flag(q.forHireOnly),
    withMcOnly: flag(q.withMcOnly),
    // Default on: the point of the tab is carriers you can email.
    emailOnly: q.emailOnly == null ? true : flag(q.emailOnly),
  };
}

// GET /api/admin/leads/new-carriers?days=30&state=&name=&forHireOnly=&withMcOnly=&emailOnly=&offset=&limit=
export async function searchNewCarriers(req: Request, res: Response) {
  const result = await fmcsaNewCarriersService.search(
    newCarrierFiltersFrom(req.query),
    parseInt10(req.query.offset, 0),
    parseInt10(req.query.limit, 50)
  );
  if (!result) {
    return res.status(502).json({ success: false, error: 'FMCSA census is unavailable right now — try again shortly' });
  }
  res.json({ success: true, data: result });
}

// GET /api/admin/leads/new-carriers/export.csv?...same filters  (&format=emails → one email per line)
export async function exportNewCarriersCsv(req: Request, res: Response) {
  const rows = await fmcsaNewCarriersService.exportAll(newCarrierFiltersFrom(req.query));
  if (!rows) {
    return res.status(502).json({ success: false, error: 'FMCSA census is unavailable right now — try again shortly' });
  }
  const date = new Date().toISOString().slice(0, 10);

  if (req.query.format === 'emails') {
    const emails = Array.from(new Set(rows.map((r) => r.email).filter((e): e is string => !!e)));
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.send(emails.join('\n'));
  }

  const headers = [
    'dot_number', 'mc_number', 'legal_name', 'dba_name', 'registered_date', 'city', 'state',
    'power_units', 'drivers', 'for_hire', 'officer', 'phone', 'email',
  ];
  const escape = (v: unknown) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) {
    lines.push([
      r.dotNumber, r.mcNumber, r.legalName, r.dbaName, r.registeredDate, r.city, r.state,
      r.powerUnits, r.drivers, r.forHire ? 'yes' : 'no', r.officer, r.phone, r.email,
    ].map(escape).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="new-carriers-${date}.csv"`);
  res.send(lines.join('\n'));
}
