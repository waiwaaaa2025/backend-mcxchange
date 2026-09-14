import { Request, Response } from 'express';
import { Op, WhereOptions, fn, col, literal } from 'sequelize';
import { Lead, LeadStatus, User, UserRole, AgentAction } from '../models';
import morproLinqService, {
  safetyLabel,
  splitLocalFilters,
  type LinqSearchFilters,
  type LinqCarrierRow,
} from '../services/morproLinqService';
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

// Map a LINQ search row to the list-page shape — no extra HTTP calls. Search rows
// carry insurance_summary, so the cancellation date comes along for free.
function rowToListShape(
  c: LinqCarrierRow,
  insuranceCancel: string | null = c.insurance_summary?.earliest_cancellation_date ?? null
) {
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

// Used by CSV export (small, bounded). NEVER use on the list page —
// the per-row /carrier hydration is the slowness culprit. Phone/email live on
// the LINQ detail record, not /search; the cancellation date is on the row.
async function hydrateForCsv(rows: LinqCarrierRow[]) {
  return Promise.all(rows.map(async (c) => {
    const carrier = (await morproLinqService.getCarrier(String(c.dot_number))) as any;
    return {
      ...rowToListShape(c),
      phone: carrier?.phone || carrier?.cell_phone || null,
      email: carrier?.email || null,
    };
  }));
}

// GET /api/admin/leads/carriers/search?state=TX&insuranceExpiresWithinDays=30&cursor=…&limit=25
export async function searchCarriers(req: Request, res: Response) {
  // LINQ pages by cursor (it ignores `page`) and rejects limit > 50.
  const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
  const limit = Math.min(50, Math.max(1, parseInt10(req.query.limit, 25)));

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

  // No per-row hydration — search response only (it already includes the
  // insurance cancellation date). Safety rating, and status when combined with
  // state, are matched on our side — see splitLocalFilters.
  const carriers = result.carriers.map((c) => rowToListShape(c));

  // Echo back the active insurance horizon so the UI can show a banner like
  // "Showing carriers with insurance expiring by YYYY-MM-DD"
  const insuranceHorizon = filters.insurance_cancels_before || null;

  res.json({
    success: true,
    data: {
      carriers,
      limit,
      hasMore: result.hasMore,
      nextCursor: result.nextCursor != null ? String(result.nextCursor) : null,
      insuranceHorizon,
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

  const csvHeaders = [
    'dot_number', 'legal_name', 'dba', 'state', 'total_power_units', 'total_drivers',
    'authority_status', 'safety_rating', 'insurance_cancellation_date', 'phone', 'email',
  ];
  const escape = (v: unknown) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [csvHeaders.join(',')];
  for (const r of collected) {
    lines.push([
      r.dotNumber, r.legalName, r.dba, r.state, r.totalPowerUnits, r.totalDrivers,
      r.authorityStatus, r.safetyRating, r.insuranceCancellationDate, r.phone, r.email,
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
  res.json({ success: true, data: leads });
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

  // Pull a one-shot snapshot from LINQ to denormalize onto the Lead row.
  // This is a fixed cost per save (not a mirror). Scout's enrich_lead refreshes
  // these same fields when it runs (and adds the AI summary to notes).
  let carrierName: string | null = null;
  let phone: string | null = null;
  let email: string | null = null;
  let insuranceCancel: string | null = null;
  if (morproLinqService.isConfigured()) {
    const [carrier, insurance] = await Promise.all([
      morproLinqService.getCarrier(dotNumber),
      morproLinqService.getInsurance(dotNumber),
    ]);
    const cj: any = carrier || {};
    carrierName = cj.legal_name || null;
    phone = cj.phone || cj.cell_phone || null;
    email = cj.email || null;
    insuranceCancel = insurance?.summary?.earliest_cancellation_date || null;
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
    Lead.count({
      where: {
        assignedToUserId: userId,
        insuranceCancellationSnapshot: { [Op.between]: [today, weekOut] },
        status: { [Op.notIn]: [LeadStatus.WON, LeadStatus.DEAD, LeadStatus.NOT_INTERESTED] },
      } as any,
    }),
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
