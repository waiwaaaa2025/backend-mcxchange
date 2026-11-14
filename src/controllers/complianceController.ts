import { Request, Response } from 'express';
import { Op, fn, col } from 'sequelize';
import {
  ManagedCompany, ComplianceDocument, Driver, DriverDocument,
  ComplianceDocumentKind, DriverStatus, DriverDocumentKind, UserRole,
  CarrierSnapshot, CarrierChangeEvent,
} from '../models';
import morproLinqService from '../services/morproLinqService';
import { refreshCarrierSnapshot, applyInspectionDetail } from '../services/carrierSnapshot.service';
import logger from '../utils/logger';

interface AuthedRequest extends Request {
  user?: { id: string; role: UserRole };
}

function isoDateOffset(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

// Helper: load a company the caller owns, or return null.
async function findOwnedCompany(userId: string, id: string) {
  return ManagedCompany.findOne({ where: { id, userId } });
}

// Helper: load a document whose parent company the caller owns.
async function findOwnedDocument(userId: string, id: string) {
  const doc = await ComplianceDocument.findByPk(id, {
    include: [{ model: ManagedCompany, as: 'company', attributes: ['id', 'userId'] }],
  });
  if (!doc || (doc as any).company?.userId !== userId) return null;
  return doc;
}

// Helper: load a driver whose parent company the caller owns.
async function findOwnedDriver(userId: string, id: string) {
  const driver = await Driver.findByPk(id, {
    include: [{ model: ManagedCompany, as: 'company', attributes: ['id', 'userId'] }],
  });
  if (!driver || (driver as any).company?.userId !== userId) return null;
  return driver;
}

// Helper: load a driver document via two-hop ownership check.
async function findOwnedDriverDocument(userId: string, id: string) {
  const doc = await DriverDocument.findByPk(id, {
    include: [{
      model: Driver, as: 'driver', attributes: ['id', 'managedCompanyId'],
      include: [{ model: ManagedCompany, as: 'company', attributes: ['id', 'userId'] }],
    }],
  });
  if (!doc || (doc as any).driver?.company?.userId !== userId) return null;
  return doc;
}

// ==================== COMPANIES ====================

// GET /api/compliance/companies
// Returns each managed company with a summary snapshot (operating status, safety
// rating, chameleon/health signals, MC docket, days since last MCS-150) plus a
// count of unacknowledged carrier_change_events — everything the list table needs
// in one round-trip.
export async function listCompanies(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const companies = await ManagedCompany.findAll({
    where: { userId },
    order: [['createdAt', 'DESC']],
    include: [{
      model: CarrierSnapshot,
      as: 'snapshot',
      required: false,
      attributes: [
        'operatingStatus', 'safetyRating', 'chameleonScore', 'chameleonRiskLevel',
        'mcDocket', 'lastFetchedAt', 'payloadJson',
      ],
    }],
  });

  const ids = companies.map(c => c.id);
  const alertRows = ids.length === 0 ? [] : await CarrierChangeEvent.findAll({
    where: { managedCompanyId: { [Op.in]: ids }, acknowledged: false },
    attributes: ['managedCompanyId', [fn('COUNT', col('id')), 'count']],
    group: ['managedCompanyId'],
    raw: true,
  });
  const alertCount = new Map<string, number>(
    (alertRows as any[]).map(r => [r.managedCompanyId, Number(r.count)])
  );

  const enriched = companies.map(c => {
    const snap = (c as any).snapshot;
    const payload = snap?.payloadJson;
    const mcs150Date =
      payload?.documents?.mcs150?.date ||
      payload?.profile?.mcs_150_date ||
      payload?.profile?.mcs150FormDate ||
      null;
    const mcs150DaysAgo = mcs150Date
      ? Math.max(0, Math.floor((Date.now() - new Date(mcs150Date).getTime()) / 86_400_000))
      : null;
    return {
      id: c.id,
      userId: c.userId,
      dotNumber: c.dotNumber,
      label: c.label,
      notes: c.notes,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      mcDocket: snap?.mcDocket || null,
      snapshot: snap ? {
        operatingStatus: snap.operatingStatus,
        safetyRating: snap.safetyRating,
        chameleonScore: snap.chameleonScore,
        chameleonRiskLevel: snap.chameleonRiskLevel,
        lastFetchedAt: snap.lastFetchedAt,
        mcs150DaysAgo,
      } : null,
      alertsCount: alertCount.get(c.id) ?? 0,
    };
  });

  res.json({ success: true, data: enriched });
}

// POST /api/compliance/companies — body: { dotNumber, label?, notes? }
// Validates the DOT against LINQ before saving so we never store a phantom carrier.
export async function addCompany(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const { dotNumber, label, notes } = req.body as { dotNumber?: string; label?: string; notes?: string };
  if (!dotNumber) return res.status(400).json({ success: false, error: 'dotNumber required' });

  // Dedupe
  const existing = await ManagedCompany.findOne({ where: { userId, dotNumber } });
  if (existing) return res.status(409).json({ success: false, error: 'You already manage this carrier', data: existing });

  // Validate against LINQ
  if (!morproLinqService.isConfigured()) {
    return res.status(503).json({ success: false, error: 'LINQ not configured — cannot validate DOT' });
  }
  const carrier = await morproLinqService.getCarrier(dotNumber);
  if (!carrier) return res.status(404).json({ success: false, error: `DOT ${dotNumber} not found in FMCSA records` });

  const inferredLabel = label || (carrier as any).legal_name || `DOT ${dotNumber}`;

  const company = await ManagedCompany.create({
    userId, dotNumber, label: inferredLabel, notes,
  } as any);

  // Pull initial snapshot from LINQ in the background — don't block the response.
  // The workspace page will load the snapshot when the user opens the company.
  refreshCarrierSnapshot(company.id, dotNumber).catch(err =>
    logger.warn(`Initial snapshot refresh failed for company ${company.id}`, { error: err.message })
  );

  res.status(201).json({ success: true, data: company });
}

// GET /api/compliance/companies/:id — returns managed row + cached snapshot.
// Reads from carrier_snapshots — no LINQ call on page load.
// If snapshot is missing (race after add), trigger a synchronous refresh.
export async function getCompany(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const company = await findOwnedCompany(userId, req.params.id);
  if (!company) return res.status(404).json({ success: false, error: 'Company not found' });

  let snapshot = await CarrierSnapshot.findByPk(company.id);
  if (!snapshot) {
    // First-time view race: snapshot hasn't landed yet. Pull live, then return.
    const result = await refreshCarrierSnapshot(company.id, company.dotNumber);
    snapshot = result.snapshot;
  }

  const payload = (snapshot?.payloadJson as any) || null;
  // Snapshots saved before violation detail existed get it filled once.
  if (snapshot && payload && (await applyInspectionDetail(payload, company.dotNumber))) {
    snapshot.set('payloadJson', { ...payload } as any);
    snapshot.changed('payloadJson', true);
    await snapshot.save().catch((err: Error) => logger.warn(`Snapshot detail save failed: ${err.message}`));
  }
  res.json({
    success: true,
    data: {
      company,
      snapshot: snapshot ? {
        lastFetchedAt: snapshot.lastFetchedAt,
        legalName: snapshot.legalName,
        dbaName: snapshot.dbaName,
        operatingStatus: snapshot.operatingStatus,
        safetyRating: snapshot.safetyRating,
        powerUnits: snapshot.powerUnits,
        totalDrivers: snapshot.totalDrivers,
        state: snapshot.state,
        city: snapshot.city,
        phone: snapshot.phone,
        email: snapshot.email,
        earliestCancellationDate: snapshot.earliestCancellationDate,
        totalActiveCoverage: snapshot.totalActiveCoverage,
        chameleonRiskLevel: snapshot.chameleonRiskLevel,
        chameleonScore: snapshot.chameleonScore,
      } : null,
      // For backward compat with LinqCarrierProfile component (expects carrier/insurance/report shape)
      linq: payload ? {
        carrier: payload.profile || null,
        insurance: payload.insurance || null,
        report: payload,
      } : { carrier: null, insurance: null, report: null },
    },
  });
}

// POST /api/compliance/companies/:id/refresh — manual refresh trigger.
export async function refreshCompany(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const company = await findOwnedCompany(userId, req.params.id);
  if (!company) return res.status(404).json({ success: false, error: 'Company not found' });

  const result = await refreshCarrierSnapshot(company.id, company.dotNumber);
  if (result.source === 'failed') {
    return res.status(502).json({ success: false, error: 'LINQ refresh failed' });
  }
  res.json({
    success: true,
    data: { lastFetchedAt: result.snapshot?.lastFetchedAt, changesDetected: result.changesDetected },
  });
}

// GET /api/compliance/companies/:id/changes — recent change events (the "pulse").
export async function getCompanyChanges(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const company = await findOwnedCompany(userId, req.params.id);
  if (!company) return res.status(404).json({ success: false, error: 'Company not found' });

  const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? '100'), 10)));
  const events = await CarrierChangeEvent.findAll({
    where: { managedCompanyId: company.id },
    order: [['detectedAt', 'DESC']],
    limit,
  });
  res.json({ success: true, data: events });
}

// POST /api/compliance/changes/:id/acknowledge — mark a change event read
export async function acknowledgeChange(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const event = await CarrierChangeEvent.findByPk(req.params.id, {
    include: [{ model: ManagedCompany, as: 'company', attributes: ['userId'] }],
  });
  if (!event || (event as any).company?.userId !== userId) {
    return res.status(404).json({ success: false, error: 'Event not found' });
  }
  await event.update({ acknowledged: true, acknowledgedAt: new Date() } as any);
  res.json({ success: true });
}

// PATCH /api/compliance/companies/:id
export async function updateCompany(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const company = await findOwnedCompany(userId, req.params.id);
  if (!company) return res.status(404).json({ success: false, error: 'Company not found' });

  const { label, notes } = req.body as { label?: string; notes?: string };
  const patch: any = {};
  if (label !== undefined) patch.label = label;
  if (notes !== undefined) patch.notes = notes;
  await company.update(patch);
  res.json({ success: true, data: company });
}

// DELETE /api/compliance/companies/:id  (cascades to documents + drivers via FK rules)
export async function deleteCompany(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const company = await findOwnedCompany(userId, req.params.id);
  if (!company) return res.status(404).json({ success: false, error: 'Company not found' });
  await company.destroy();
  res.json({ success: true });
}

// ==================== DOCUMENTS (per company) ====================

// GET /api/compliance/companies/:id/documents
export async function listCompanyDocuments(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const company = await findOwnedCompany(userId, req.params.id);
  if (!company) return res.status(404).json({ success: false, error: 'Company not found' });

  const docs = await ComplianceDocument.findAll({
    where: { managedCompanyId: company.id },
    order: [['expiresOn', 'ASC'], ['createdAt', 'DESC']],
  });
  res.json({ success: true, data: docs });
}

// POST /api/compliance/companies/:id/documents
export async function createDocument(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const company = await findOwnedCompany(userId, req.params.id);
  if (!company) return res.status(404).json({ success: false, error: 'Company not found' });

  const { kind, title, expiresOn, notes } = req.body as any;
  if (!kind || !Object.values(ComplianceDocumentKind).includes(kind)) {
    return res.status(400).json({ success: false, error: 'Invalid kind' });
  }
  if (!title) return res.status(400).json({ success: false, error: 'title required' });

  const doc = await ComplianceDocument.create({
    managedCompanyId: company.id, kind, title, expiresOn: expiresOn || null, notes: notes || null,
  } as any);
  res.status(201).json({ success: true, data: doc });
}

// PATCH /api/compliance/documents/:id
export async function updateDocument(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const doc = await findOwnedDocument(userId, req.params.id);
  if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });

  const { kind, title, expiresOn, notes } = req.body as any;
  const patch: any = {};
  if (kind !== undefined) patch.kind = kind;
  if (title !== undefined) patch.title = title;
  if (expiresOn !== undefined) patch.expiresOn = expiresOn || null;
  if (notes !== undefined) patch.notes = notes;
  await doc.update(patch);
  res.json({ success: true, data: doc });
}

// DELETE /api/compliance/documents/:id
export async function deleteDocument(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const doc = await findOwnedDocument(userId, req.params.id);
  if (!doc) return res.status(404).json({ success: false, error: 'Document not found' });
  await doc.destroy();
  res.json({ success: true });
}

// GET /api/compliance/documents — flat list across all the caller's companies.
// Sorted by expiresOn ascending; null expiry at the end.
export async function listAllDocuments(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const docs = await ComplianceDocument.findAll({
    include: [{ model: ManagedCompany, as: 'company', where: { userId }, attributes: ['id', 'dotNumber', 'label'] }],
    order: [['expiresOn', 'ASC NULLS LAST' as any], ['createdAt', 'DESC']],
  }).catch(() =>
    // MySQL doesn't support NULLS LAST — fall back to default order with manual sort.
    ComplianceDocument.findAll({
      include: [{ model: ManagedCompany, as: 'company', where: { userId }, attributes: ['id', 'dotNumber', 'label'] }],
      order: [['expiresOn', 'ASC']],
    })
  );
  res.json({ success: true, data: docs });
}

// ==================== DRIVERS (per company) ====================

// GET /api/compliance/companies/:id/drivers
export async function listCompanyDrivers(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const company = await findOwnedCompany(userId, req.params.id);
  if (!company) return res.status(404).json({ success: false, error: 'Company not found' });

  const drivers = await Driver.findAll({
    where: { managedCompanyId: company.id },
    order: [['createdAt', 'DESC']],
  });
  res.json({ success: true, data: drivers });
}

// POST /api/compliance/companies/:id/drivers
export async function createDriver(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const company = await findOwnedCompany(userId, req.params.id);
  if (!company) return res.status(404).json({ success: false, error: 'Company not found' });

  const { fullName, cdlNumber, cdlState, cdlExpiresOn, hireDate, status, notes } = req.body as any;
  if (!fullName) return res.status(400).json({ success: false, error: 'fullName required' });

  const driver = await Driver.create({
    managedCompanyId: company.id,
    fullName,
    cdlNumber: cdlNumber || null,
    cdlState: cdlState || null,
    cdlExpiresOn: cdlExpiresOn || null,
    hireDate: hireDate || null,
    status: status || DriverStatus.ACTIVE,
    notes: notes || null,
  } as any);
  res.status(201).json({ success: true, data: driver });
}

// GET /api/compliance/drivers/:id
export async function getDriver(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const driver = await findOwnedDriver(userId, req.params.id);
  if (!driver) return res.status(404).json({ success: false, error: 'Driver not found' });
  res.json({ success: true, data: driver });
}

// PATCH /api/compliance/drivers/:id
export async function updateDriver(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const driver = await findOwnedDriver(userId, req.params.id);
  if (!driver) return res.status(404).json({ success: false, error: 'Driver not found' });

  const { fullName, cdlNumber, cdlState, cdlExpiresOn, hireDate, status, notes } = req.body as any;
  const patch: any = {};
  if (fullName !== undefined) patch.fullName = fullName;
  if (cdlNumber !== undefined) patch.cdlNumber = cdlNumber || null;
  if (cdlState !== undefined) patch.cdlState = cdlState || null;
  if (cdlExpiresOn !== undefined) patch.cdlExpiresOn = cdlExpiresOn || null;
  if (hireDate !== undefined) patch.hireDate = hireDate || null;
  if (status !== undefined) patch.status = status;
  if (notes !== undefined) patch.notes = notes;
  await driver.update(patch);
  res.json({ success: true, data: driver });
}

// DELETE /api/compliance/drivers/:id
export async function deleteDriver(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const driver = await findOwnedDriver(userId, req.params.id);
  if (!driver) return res.status(404).json({ success: false, error: 'Driver not found' });
  await driver.destroy();
  res.json({ success: true });
}

// GET /api/compliance/drivers — flat list across all companies for the caller
export async function listAllDrivers(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const drivers = await Driver.findAll({
    include: [{ model: ManagedCompany, as: 'company', where: { userId }, attributes: ['id', 'dotNumber', 'label'] }],
    order: [['createdAt', 'DESC']],
  });
  res.json({ success: true, data: drivers });
}

// ==================== DRIVER DOCUMENTS ====================

// GET /api/compliance/drivers/:id/documents
export async function listDriverDocuments(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const driver = await findOwnedDriver(userId, req.params.id);
  if (!driver) return res.status(404).json({ success: false, error: 'Driver not found' });

  const docs = await DriverDocument.findAll({
    where: { driverId: driver.id },
    order: [['expiresOn', 'ASC'], ['createdAt', 'DESC']],
  });
  res.json({ success: true, data: docs });
}

// POST /api/compliance/drivers/:id/documents
export async function createDriverDocument(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const driver = await findOwnedDriver(userId, req.params.id);
  if (!driver) return res.status(404).json({ success: false, error: 'Driver not found' });

  const { kind, title, expiresOn, notes } = req.body as any;
  if (!kind || !Object.values(DriverDocumentKind).includes(kind)) {
    return res.status(400).json({ success: false, error: 'Invalid kind' });
  }
  if (!title) return res.status(400).json({ success: false, error: 'title required' });

  const doc = await DriverDocument.create({
    driverId: driver.id, kind, title, expiresOn: expiresOn || null, notes: notes || null,
  } as any);
  res.status(201).json({ success: true, data: doc });
}

// PATCH /api/compliance/driver-documents/:id
export async function updateDriverDocument(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const doc = await findOwnedDriverDocument(userId, req.params.id);
  if (!doc) return res.status(404).json({ success: false, error: 'Driver document not found' });

  const { kind, title, expiresOn, notes } = req.body as any;
  const patch: any = {};
  if (kind !== undefined) patch.kind = kind;
  if (title !== undefined) patch.title = title;
  if (expiresOn !== undefined) patch.expiresOn = expiresOn || null;
  if (notes !== undefined) patch.notes = notes;
  await doc.update(patch);
  res.json({ success: true, data: doc });
}

// DELETE /api/compliance/driver-documents/:id
export async function deleteDriverDocument(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const doc = await findOwnedDriverDocument(userId, req.params.id);
  if (!doc) return res.status(404).json({ success: false, error: 'Driver document not found' });
  await doc.destroy();
  res.json({ success: true });
}

// ==================== DASHBOARD ====================

// GET /api/compliance/dashboard/summary
export async function getDashboardSummary(req: AuthedRequest, res: Response) {
  const userId = req.user!.id;
  const today = new Date().toISOString().slice(0, 10);
  const in30 = isoDateOffset(30);
  const in60 = isoDateOffset(60);
  const in90 = isoDateOffset(90);

  const companies = await ManagedCompany.findAll({ where: { userId }, attributes: ['id'] });
  const companyIds = companies.map(c => c.id);

  if (companyIds.length === 0) {
    return res.json({
      success: true,
      data: {
        totalCompanies: 0, totalDrivers: 0,
        docsExpiring: { in7: 0, in30: 0, in60: 0, in90: 0, expired: 0 },
        cdlExpiring: { in7: 0, in30: 0, in60: 0, in90: 0, expired: 0 },
      },
    });
  }

  const drivers = await Driver.findAll({
    where: { managedCompanyId: { [Op.in]: companyIds } },
    attributes: ['id', 'cdlExpiresOn', 'status'],
  });
  const driverIds = drivers.map(d => d.id);

  const docs = await ComplianceDocument.findAll({
    where: { managedCompanyId: { [Op.in]: companyIds } },
    attributes: ['expiresOn'],
  });
  const driverDocs = driverIds.length
    ? await DriverDocument.findAll({
        where: { driverId: { [Op.in]: driverIds } },
        attributes: ['expiresOn'],
      })
    : [];

  function bucketize(items: Array<{ expiresOn?: Date | string | null }>) {
    const b = { in7: 0, in30: 0, in60: 0, in90: 0, expired: 0 };
    const in7 = isoDateOffset(7);
    for (const it of items) {
      const d = it.expiresOn ? String(it.expiresOn).slice(0, 10) : null;
      if (!d) continue;
      if (d < today) b.expired++;
      else if (d <= in7) b.in7++;
      else if (d <= in30) b.in30++;
      else if (d <= in60) b.in60++;
      else if (d <= in90) b.in90++;
    }
    return b;
  }

  res.json({
    success: true,
    data: {
      totalCompanies: companyIds.length,
      totalDrivers: drivers.filter(d => d.status === DriverStatus.ACTIVE).length,
      docsExpiring: bucketize([...docs, ...driverDocs]),
      cdlExpiring: bucketize(drivers.map(d => ({ expiresOn: d.cdlExpiresOn }))),
    },
  });
}
