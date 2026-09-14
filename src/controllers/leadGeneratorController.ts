import { Response } from 'express';
import { Op } from 'sequelize';
import { AuthRequest } from '../types';
import { LeadGeneratorSave, User, UserRole } from '../models';
import morproLinqService, {
  safetyLabel,
  splitLocalFilters,
  type LinqSearchFilters,
  type LinqSearchResult,
} from '../services/morproLinqService';
import { getLeadGeneratorAccess } from '../services/entitlementService';
import logger from '../utils/logger';

// GET /api/lead-generator/access — authoritative access check for the UI.
// Resolves access purely from the user's subscription/entitlement, with NO
// dependency on the external carrier-data provider. The tool page gates on this
// so a data-provider outage (which makes /search return 502) can never make a
// paying subscriber look like they have no access. Always 200 for an
// authenticated user — { hasAccess:false, tier:null } when they lack a plan.
export async function getAccess(req: AuthRequest, res: Response) {
  if (!req.user) {
    return res.status(401).json({ success: false, error: 'Not authenticated.' });
  }
  const access = await getLeadGeneratorAccess(req.user.id, {
    isAdmin: req.user.role === UserRole.ADMIN,
  });
  return res.json({
    success: true,
    data: { hasAccess: access.hasAccess, tier: access.tier },
  });
}

// Upper bound on a single batch-contact request. The results table asks for the
// 25 rows it is showing; this only exists so a hand-rolled request can't fan out
// into an unbounded number of per-carrier LINQ calls.
const MAX_CONTACT_BATCH = 100;

// Buyer tier filters — anything not in this set is silently dropped for BUYER
// callers so the client can't sneak in advanced filters by hand-rolling the URL.
const BUYER_FILTER_KEYS = new Set([
  'state',
  'authorityStatus',
  'safetyRating',
  'name',
  'insuranceExpiresWithinDays',
]);

// Broker / Admin tiers get these on top of the buyer set.
const BROKER_FILTER_KEYS = new Set([
  ...BUYER_FILTER_KEYS,
  'minFleet',
  'maxFleet',
  'cargoType',
  'addedBefore',
  'addedAfter',
]);

function parseInt10(v: unknown, fallback: number): number {
  const n = parseInt(String(v ?? ''), 10);
  return Number.isFinite(n) ? n : fallback;
}

function isoDateOffset(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

function filterByTier(
  raw: Record<string, unknown>,
  tier: 'BUYER' | 'BROKER' | 'ADMIN'
): Record<string, unknown> {
  const allowed = tier === 'BUYER' ? BUYER_FILTER_KEYS : BROKER_FILTER_KEYS;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (allowed.has(k)) out[k] = v;
  }
  return out;
}

function buildLinqFilters(q: Record<string, unknown>): LinqSearchFilters {
  const f: LinqSearchFilters = {};
  if (q.state) f.state = String(q.state).toUpperCase();
  if (q.authorityStatus) f.status = String(q.authorityStatus).toUpperCase();
  if (q.safetyRating) f.safety_rating = String(q.safetyRating);
  if (q.name) f.name_contains = String(q.name);
  if (q.minFleet) f.min_fleet_size = parseInt10(q.minFleet, 0);
  if (q.maxFleet) f.max_fleet_size = parseInt10(q.maxFleet, Number.MAX_SAFE_INTEGER);
  if (q.cargoType) f.cargo_type = String(q.cargoType);
  if (q.addedBefore) f.added_before = String(q.addedBefore);
  if (q.addedAfter) f.added_after = String(q.addedAfter);
  if (q.insuranceExpiresWithinDays) {
    const days = parseInt10(q.insuranceExpiresWithinDays, 30);
    f.insurance_cancels_after = isoDateOffset(0);
    f.insurance_cancels_before = isoDateOffset(days);
    f.has_active_insurance = true;
  }
  return f;
}

// Map a raw LINQ carrier record to the light row shape we return to the client.
function toRow(c: any) {
  return {
    dotNumber: String(c.dot_number),
    legalName: c.legal_name,
    dba: c.dba_name || null,
    state: c.state,
    totalPowerUnits: c.power_units,
    totalDrivers: c.drivers || null,
    authorityStatus: c.status,
    safetyRating: safetyLabel(c.safety_rating),
  };
}

// GET /api/lead-generator/search
export async function searchCarriers(req: AuthRequest, res: Response) {
  const tier = req.leadGenTier ?? 'BUYER';
  // LINQ pages by cursor (it ignores `page`) and rejects limit > 50.
  const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
  const limit = Math.min(50, Math.max(1, parseInt10(req.query.limit, 25)));

  const allowedRaw = filterByTier(req.query as Record<string, unknown>, tier);
  const userFilters = buildLinqFilters(allowedRaw);
  const filters: LinqSearchFilters = {
    ...(Object.keys(userFilters).length === 0 ? { status: 'ACTIVE' } : userFilters),
    limit,
    ...(cursor ? { cursor } : {}),
  };

  // Safety rating, and status when combined with state, are matched on our side
  // (LINQ ignores / 500s on them) — see splitLocalFilters.
  const result = await morproLinqService.searchCarriersFiltered(filters);
  if (!result) {
    return res.status(502).json({ success: false, error: 'Carrier search unavailable' });
  }

  // LINQ /v1/carriers/search can return the same DOT multiple times (one row per
  // insurance policy / authority record), so collapse to one row per DOT here.
  const byDot = new Map<string, ReturnType<typeof toRow>>();
  for (const c of result.carriers) {
    const row = toRow(c);
    if (!byDot.has(row.dotNumber)) byDot.set(row.dotNumber, row);
  }
  const carriers = [...byDot.values()];

  res.json({
    success: true,
    data: {
      carriers,
      limit,
      hasMore: result.hasMore,
      nextCursor: result.nextCursor != null ? String(result.nextCursor) : null,
      tier,
    },
  });
}

// GET /api/lead-generator/carrier/:dot/contact — phone/email for one carrier.
// Available to ANY Lead Generator tier (Buyer + Broker) so subscribers can call
// a lead directly. Phone is NOT in the search response (kept light for speed);
// it lives on the per-carrier LINQ detail record, so we fetch it on demand here.
export async function getCarrierContact(req: AuthRequest, res: Response) {
  const dot = String(req.params.dot || '').trim();
  if (!dot) {
    return res.status(400).json({ success: false, error: 'dot is required' });
  }

  if (!morproLinqService.isConfigured()) {
    return res.status(502).json({ success: false, error: 'Carrier data unavailable' });
  }

  const carrier = (await morproLinqService.getCarrier(dot)) as any;
  if (!carrier) {
    return res.status(404).json({ success: false, error: 'Carrier not found' });
  }

  res.json({
    success: true,
    data: {
      dotNumber: dot,
      phone: carrier.phone || carrier.cell_phone || null,
      email: carrier.email || null,
    },
  });
}

// POST /api/lead-generator/contacts — phone/email for a batch of DOTs.
// Broker/Admin only (see requireLeadGeneratorBroker on the route): the Buyer tier
// still reveals one carrier at a time through the endpoint above. Contact data is
// not in the search response, so the table would otherwise need one round-trip per
// row to show it; this collapses a page of rows into a single request, enriched
// with the same bounded concurrency the CSV export uses.
export async function getCarrierContactsBatch(req: AuthRequest, res: Response) {
  const raw = (req.body || {}).dots;
  if (!Array.isArray(raw)) {
    return res.status(400).json({ success: false, error: 'dots must be an array' });
  }

  if (!morproLinqService.isConfigured()) {
    return res.status(502).json({ success: false, error: 'Carrier data unavailable' });
  }

  // De-dupe and cap. MAX_CONTACT_BATCH is well above the 25-row page the UI asks
  // for, but keeps a hand-rolled request from fanning out into thousands of LINQ
  // detail calls.
  const dots = [...new Set(raw.map((d: unknown) => String(d).trim()).filter(Boolean))].slice(
    0,
    MAX_CONTACT_BATCH
  );

  // One carrier failing (or missing at LINQ) must not fail the whole page — those
  // rows come back with nulls and the UI just shows no contact for them.
  const results = await mapLimit(dots, 12, async (dot) => {
    try {
      const c = (await morproLinqService.getCarrier(dot)) as any;
      return { dot, phone: c?.phone || c?.cell_phone || null, email: c?.email || null };
    } catch {
      return { dot, phone: null, email: null };
    }
  });

  const contacts: Record<string, { phone: string | null; email: string | null }> = {};
  for (const r of results) {
    contacts[r.dot] = { phone: r.phone, email: r.email };
  }

  res.json({ success: true, data: { contacts } });
}

// GET /api/lead-generator/saves — current user's own saves
export async function listSaves(req: AuthRequest, res: Response) {
  if (!req.user) return res.status(401).json({ success: false, error: 'Not authenticated.' });
  const saves = await LeadGeneratorSave.findAll({
    where: { userId: req.user.id },
    order: [['createdAt', 'DESC']],
  });
  res.json({ success: true, data: saves });
}

// POST /api/lead-generator/saves
export async function createSave(req: AuthRequest, res: Response) {
  if (!req.user) return res.status(401).json({ success: false, error: 'Not authenticated.' });
  const { dotNumber, carrierName, carrierStateCode, notes } = req.body || {};
  if (!dotNumber) {
    return res.status(400).json({ success: false, error: 'dotNumber is required' });
  }

  const [save, created] = await LeadGeneratorSave.findOrCreate({
    where: { userId: req.user.id, dotNumber: String(dotNumber) },
    defaults: {
      userId: req.user.id,
      dotNumber: String(dotNumber),
      carrierName: carrierName ?? null,
      carrierStateCode: carrierStateCode ?? null,
      notes: notes ?? null,
    } as any,
  });

  if (!created && (carrierName || carrierStateCode || notes != null)) {
    await save.update({
      carrierName: carrierName ?? save.carrierName,
      carrierStateCode: carrierStateCode ?? save.carrierStateCode,
      notes: notes ?? save.notes,
    });
  }

  res.status(created ? 201 : 200).json({ success: true, data: save });
}

// DELETE /api/lead-generator/saves/:id
export async function deleteSave(req: AuthRequest, res: Response) {
  if (!req.user) return res.status(401).json({ success: false, error: 'Not authenticated.' });
  const row = await LeadGeneratorSave.findOne({
    where: { id: req.params.id, userId: req.user.id },
  });
  if (!row) return res.status(404).json({ success: false, error: 'Save not found' });
  await row.destroy();
  res.json({ success: true });
}

// Bounded-concurrency map so enrichment doesn't fire hundreds of LINQ calls at once.
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (i < items.length) {
      const cur = i++;
      results[cur] = await fn(items[cur]);
    }
  });
  await Promise.all(workers);
  return results;
}

const BASE_CSV_COLUMNS = [
  'dot_number',
  'legal_name',
  'dba',
  'state',
  'total_power_units',
  'total_drivers',
  'authority_status',
  'safety_rating',
];

function rowFromCarrier(c: any): Record<string, unknown> {
  return {
    dot_number: c.dot_number,
    legal_name: c.legal_name,
    dba: c.dba_name || '',
    state: c.state,
    total_power_units: c.power_units,
    total_drivers: c.drivers || '',
    authority_status: c.status,
    safety_rating: safetyLabel(c.safety_rating),
  };
}

// GET /api/lead-generator/export.csv — available to any Lead Generator tier.
//   Buyer ($49): downloads the current page only (25 carriers), core columns.
//   Broker/Admin: downloads the full result set (paginated up to maxRows) and
//   enriches each row with phone + email (fetched per-carrier from LINQ).
export async function exportCsv(req: AuthRequest, res: Response) {
  const tier = req.leadGenTier ?? 'BUYER';
  const isBrokerTier = tier === 'BROKER' || tier === 'ADMIN';

  const allowedRaw = filterByTier(req.query as Record<string, unknown>, tier);
  const userFilters = buildLinqFilters(allowedRaw);
  // Mirror the search endpoint's empty-filter default. LINQ returns nothing for an
  // empty filter set, so a filterless export hit `!result` → 502, surfacing in the
  // browser as "CSV export failed" (notably on the buyer path, which often exports
  // the default ACTIVE list without applying any filters).
  const baseFilters: LinqSearchFilters =
    Object.keys(userFilters).length === 0 ? { status: 'ACTIVE' } : userFilters;

  const headers = isBrokerTier ? [...BASE_CSV_COLUMNS, 'phone', 'email'] : BASE_CSV_COLUMNS;
  const escape = (v: unknown) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const toLine = (r: Record<string, unknown>) => headers.map((h) => escape(r[h])).join(',');

  if (!isBrokerTier) {
    // Buyer: just the page they're viewing (25 rows). Fast enough to buffer, and
    // fetching first lets us still return a clean 502 if the search backend is down.
    const cursor = req.query.cursor ? String(req.query.cursor) : undefined;
    const result = await morproLinqService.searchCarriersFiltered(
      { ...baseFilters, limit: 25, ...(cursor ? { cursor } : {}) },
      { minRows: 25 }
    );
    if (!result) {
      return res.status(502).json({ success: false, error: 'Carrier search unavailable' });
    }
    if ((result.carriers || []).length === 0) {
      return res
        .status(404)
        .json({ success: false, error: 'No carriers matched those filters. Try widening them.' });
    }
    const lines = [headers.join(',')];
    for (const c of (result.carriers || []).slice(0, 25)) lines.push(toLine(rowFromCarrier(c)));
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="lead-generator-${new Date().toISOString().slice(0, 10)}.csv"`
    );
    return res.send(lines.join('\n'));
  }

  // Broker/Admin: large, slow export (up to maxRows + a per-carrier LINQ detail call
  // each for phone/email). Stream the CSV page-by-page so the first byte goes out within
  // a few seconds and rows keep flowing — otherwise the whole job runs past Heroku's hard
  // 30s request timeout (H12), which drops the connection and surfaces in the browser as
  // "Failed to fetch". With streaming, only the rolling 55s gap-between-writes limit applies.
  const maxRows = Math.min(5000, Math.max(1, parseInt10(req.query.limit, 1000)));

  // Fetch page 1 BEFORE sending any bytes. Once the CSV headers are on the wire we
  // can no longer switch to an error status, so a first-page failure used to be
  // indistinguishable from "no matches" — the browser saved a file containing just
  // the header row. Probing first means a broken/empty search returns a real 502
  // and the UI shows "CSV export failed" instead of downloading an empty sheet.
  //
  // LINQ rejects limit > 50 with a 400 and pages by cursor (it ignores `page`).
  const pageSize = 50;
  // Safety (and status alongside state) can't go to LINQ — match rows here, and
  // cap the scan so a sparse match can't walk an entire state.
  const { linq: brokerFilters, matches, hasLocal } = splitLocalFilters(baseFilters);
  const maxScanPages = Math.ceil(maxRows / pageSize) * (hasLocal ? 4 : 1);
  const firstPage = await morproLinqService.searchCarriers({ ...brokerFilters, limit: pageSize });
  if (!firstPage) {
    logger.warn('LG export: first search page failed', { filters: baseFilters });
    return res.status(502).json({ success: false, error: 'Carrier search unavailable' });
  }
  if ((firstPage.carriers || []).length === 0) {
    return res
      .status(404)
      .json({ success: false, error: 'No carriers matched those filters. Try widening them.' });
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="lead-generator-${new Date().toISOString().slice(0, 10)}.csv"`
  );
  res.write(headers.join(',') + '\n');
  // Force the compression middleware to flush so the header row hits the wire immediately.
  if (typeof (res as any).flush === 'function') (res as any).flush();

  // Page 1 is already in hand from the probe above; later pages follow next_cursor.
  let result: LinqSearchResult | null = firstPage;
  let written = 0;
  let pagesRead = 1;
  while (written < maxRows) {
    if (!result || (result.carriers || []).length === 0) break;

    const remaining = maxRows - written;
    const rows: Array<Record<string, unknown>> = (result.carriers || [])
      .filter(matches)
      .slice(0, remaining)
      .map((c) => ({ ...rowFromCarrier(c), phone: '', email: '' }));

    // Enrich this page's rows with phone + email from the per-carrier LINQ detail.
    const contacts = await mapLimit(rows, 12, async (row) => {
      try {
        const d = (await morproLinqService.getCarrier(String(row.dot_number))) as any;
        return { phone: d?.phone || d?.cell_phone || '', email: d?.email || '' };
      } catch {
        return { phone: '', email: '' };
      }
    });

    let chunk = '';
    rows.forEach((row, idx) => {
      row.phone = contacts[idx].phone;
      row.email = contacts[idx].email;
      chunk += toLine(row) + '\n';
    });
    res.write(chunk);
    if (typeof (res as any).flush === 'function') (res as any).flush();
    written += rows.length;

    if (!result.has_more || result.next_cursor == null || pagesRead++ >= maxScanPages) break;
    try {
      result = await morproLinqService.searchCarriers({
        ...brokerFilters,
        limit: pageSize,
        cursor: result.next_cursor,
      });
    } catch {
      // Headers already sent — can't switch to an error status. Stop with a partial file.
      break;
    }
  }

  res.end();
}

// GET /api/admin/lead-generator/saves — admin only, all users' saves
export async function adminListAllSaves(req: AuthRequest, res: Response) {
  const userId = req.query.userId ? String(req.query.userId) : undefined;
  const dotNumber = req.query.dotNumber ? String(req.query.dotNumber) : undefined;
  const fromRaw = req.query.from ? String(req.query.from) : undefined;
  const toRaw = req.query.to ? String(req.query.to) : undefined;
  const page = Math.max(1, parseInt10(req.query.page, 1));
  const limit = Math.min(200, Math.max(1, parseInt10(req.query.limit, 50)));

  const where: Record<string, unknown> = {};
  if (userId) where.userId = userId;
  if (dotNumber) where.dotNumber = dotNumber;
  if (fromRaw || toRaw) {
    const range: Record<symbol, Date> = {};
    if (fromRaw) range[Op.gte] = new Date(fromRaw);
    if (toRaw) range[Op.lte] = new Date(toRaw);
    (where as any).createdAt = range;
  }

  const { rows, count } = await LeadGeneratorSave.findAndCountAll({
    where: where as any,
    order: [['createdAt', 'DESC']],
    offset: (page - 1) * limit,
    limit,
    include: [{ model: User, as: 'user', attributes: ['id', 'name', 'email'], required: false }],
  });

  res.json({
    success: true,
    data: {
      saves: rows,
      page,
      limit,
      total: count,
      totalPages: Math.ceil(count / limit),
    },
  });
}
