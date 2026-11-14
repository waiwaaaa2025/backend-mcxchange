import { CarrierSnapshot, CarrierChangeEvent, CarrierChangeSeverity, ManagedCompany } from '../models';
import morproLinqService from '../services/morproLinqService';
import logger from '../utils/logger';
import { applyFmcsaSafetyFallback } from './fmcsaSafetyFallback';
import { applyViolationDetail, VIOLATION_DETAIL_MARKER } from './fmcsaViolationDetail';

/**
 * Fills inspections from FMCSA when LINQ has none, then attaches the cited
 * violation codes so the compliance workspace can offer DataQs challenges.
 * Mutates `report`; returns true when anything was added or marked.
 */
export async function applyInspectionDetail(report: any, dotNumber: string): Promise<boolean> {
  if (!report || report[VIOLATION_DETAIL_MARKER] !== undefined) return false;
  await applyFmcsaSafetyFallback(report, dotNumber).catch((err) =>
    logger.warn(`Compliance FMCSA safety fallback failed for DOT ${dotNumber}: ${(err as Error).message}`)
  );
  await applyViolationDetail(report, dotNumber).catch((err) =>
    logger.warn(`Compliance violation detail failed for DOT ${dotNumber}: ${(err as Error).message}`)
  );
  return report[VIOLATION_DETAIL_MARKER] !== undefined;
}

/**
 * Pulls a fresh LINQ /report for a managed company, extracts hot scalars,
 * diffs against the prior snapshot, persists the new state, and writes
 * change events for any meaningful field deltas.
 *
 * This is the only path that should call LINQ for managed companies.
 * Page loads read from carrier_snapshots, not LINQ.
 */
export async function refreshCarrierSnapshot(managedCompanyId: string, dotNumber: string): Promise<{
  snapshot: CarrierSnapshot | null;
  changesDetected: number;
  source: 'fresh' | 'failed';
}> {
  if (!morproLinqService.isConfigured()) {
    logger.warn('refreshCarrierSnapshot: LINQ not configured');
    return { snapshot: null, changesDetected: 0, source: 'failed' };
  }

  const report = await morproLinqService.getFullReport(dotNumber);
  if (!report) {
    logger.warn(`refreshCarrierSnapshot: LINQ returned null for DOT ${dotNumber}`);
    return { snapshot: null, changesDetected: 0, source: 'failed' };
  }

  await applyInspectionDetail(report, dotNumber);

  const prior = await CarrierSnapshot.findByPk(managedCompanyId);
  const extracted = extractHotScalars(report);

  // Diff vs prior payload — only when we have something to compare against.
  const changes: ChangeEntry[] = prior ? diffPayloads((prior.payloadJson as any) || {}, report) : [];

  const now = new Date();

  if (prior) {
    await prior.update({
      lastFetchedAt: now,
      payloadJson: report as any,
      ...extracted,
    } as any);
  } else {
    await CarrierSnapshot.create({
      managedCompanyId,
      lastFetchedAt: now,
      payloadJson: report as any,
      ...extracted,
    } as any);
  }

  if (changes.length > 0) {
    await CarrierChangeEvent.bulkCreate(
      changes.map(c => ({
        managedCompanyId,
        field: c.field,
        oldValue: c.oldValue ?? null,
        newValue: c.newValue ?? null,
        severity: c.severity,
        description: c.description || null,
        detectedAt: now,
        acknowledged: false,
      })) as any,
    );
  }

  return {
    snapshot: (await CarrierSnapshot.findByPk(managedCompanyId)) as CarrierSnapshot,
    changesDetected: changes.length,
    source: 'fresh',
  };
}

// ==================== HELPERS ====================

interface ChangeEntry {
  field: string;
  oldValue?: unknown;
  newValue?: unknown;
  severity: CarrierChangeSeverity;
  description?: string;
}

function extractHotScalars(report: any) {
  const profile = report?.profile || {};
  const authority = report?.authority || {};
  const safety = report?.safety || {};
  const insurance = report?.insurance || {};
  const fleet = report?.fleet || {};
  const cham = report?.chameleon || {};
  const crashes = report?.crashes || {};

  return {
    legalName: profile.legal_name || null,
    dbaName: profile.dba_name || null,
    mcDocket: authority.docket_number || (profile.operating_authority?.docket1
      ? `${profile.operating_authority.docket1prefix || ''}${profile.operating_authority.docket1}`
      : null),
    operatingStatus: profile.operating_status || null,
    safetyRating: safety.safety_rating || null,
    powerUnits: typeof fleet.power_units === 'number' ? fleet.power_units : null,
    totalDrivers: typeof fleet.total_drivers === 'number' ? fleet.total_drivers : null,
    state: profile.physical_address?.state || null,
    city: profile.physical_address?.city || null,
    phone: profile.phone || profile.cell_phone || null,
    email: profile.email || null,
    earliestCancellationDate: insurance.summary?.earliest_cancellation_date || null,
    totalActiveCoverage: insurance.summary?.total_active_coverage ?? null,
    chameleonRiskLevel: cham.risk_level || null,
    chameleonScore: typeof cham.score === 'number' ? cham.score : null,
    crashes24mo: crashes.total ?? null,
    inspections24mo: safety.total_inspections ?? null,
    driverOosRate: safety.driver_oos_rate ?? null,
    vehicleOosRate: safety.vehicle_oos_rate ?? null,
  };
}

/**
 * Walks the curated set of fields we care about and emits a ChangeEntry
 * for each delta. Intentionally narrow — we don't diff the whole JSON,
 * only the signals that are alert-worthy for a compliance manager.
 */
function diffPayloads(prev: any, next: any): ChangeEntry[] {
  const out: ChangeEntry[] = [];

  // Operating status flips (authority changes)
  cmp(out, 'profile.operating_status', prev?.profile?.operating_status, next?.profile?.operating_status, CarrierChangeSeverity.CRITICAL, 'Operating authority changed');

  // Safety rating
  cmp(out, 'safety.safety_rating', prev?.safety?.safety_rating, next?.safety?.safety_rating, CarrierChangeSeverity.CRITICAL, 'Safety rating updated');

  // Insurance — earliest cancellation date moved (renewal or new policy expiring sooner)
  const prevCancel = prev?.insurance?.summary?.earliest_cancellation_date;
  const nextCancel = next?.insurance?.summary?.earliest_cancellation_date;
  if (prevCancel !== nextCancel) {
    const sev = !nextCancel || (new Date(nextCancel).getTime() - Date.now()) > 30 * 86_400_000
      ? CarrierChangeSeverity.INFO
      : CarrierChangeSeverity.WARN;
    out.push({
      field: 'insurance.summary.earliest_cancellation_date',
      oldValue: prevCancel, newValue: nextCancel,
      severity: sev,
      description: 'Insurance cancellation date changed',
    });
  }

  // Insurance — total active coverage
  cmp(out, 'insurance.summary.total_active_coverage',
    prev?.insurance?.summary?.total_active_coverage,
    next?.insurance?.summary?.total_active_coverage,
    CarrierChangeSeverity.INFO, 'Total active coverage changed');

  // Active policy count
  cmp(out, 'insurance.summary.active_policies',
    prev?.insurance?.summary?.active_policies,
    next?.insurance?.summary?.active_policies,
    CarrierChangeSeverity.INFO, 'Active policy count changed');

  // BASIC alerts flipping on/off
  const prevBasics: any[] = prev?.safety?.basics || [];
  const nextBasics: any[] = next?.safety?.basics || [];
  for (const nb of nextBasics) {
    const pb = prevBasics.find((b: any) => b.category === nb.category);
    if (!pb) continue;
    if (pb.alert !== nb.alert) {
      out.push({
        field: `safety.basics.${nb.category}.alert`,
        oldValue: pb.alert, newValue: nb.alert,
        severity: nb.alert ? CarrierChangeSeverity.CRITICAL : CarrierChangeSeverity.INFO,
        description: `${nb.category}: BASIC alert ${nb.alert ? 'TRIPPED' : 'cleared'}`,
      });
    } else if (typeof pb.measure === 'number' && typeof nb.measure === 'number') {
      const delta = nb.measure - pb.measure;
      if (Math.abs(delta) >= 1) {
        out.push({
          field: `safety.basics.${nb.category}.measure`,
          oldValue: pb.measure, newValue: nb.measure,
          severity: Math.abs(delta) >= 5 ? CarrierChangeSeverity.WARN : CarrierChangeSeverity.INFO,
          description: `${nb.category}: measure ${delta > 0 ? '+' : ''}${delta.toFixed(2)}`,
        });
      }
    }
  }

  // Fleet size deltas (>10% change)
  const pPU = prev?.fleet?.power_units;
  const nPU = next?.fleet?.power_units;
  if (typeof pPU === 'number' && typeof nPU === 'number' && pPU > 0) {
    const pct = Math.abs((nPU - pPU) / pPU);
    if (pct >= 0.1) {
      out.push({
        field: 'fleet.power_units',
        oldValue: pPU, newValue: nPU,
        severity: CarrierChangeSeverity.INFO,
        description: `Fleet size shifted ${((nPU - pPU) / pPU * 100).toFixed(0)}% (${pPU} → ${nPU})`,
      });
    }
  }

  // Crash count goes up
  const pCrash = prev?.crashes?.total || 0;
  const nCrash = next?.crashes?.total || 0;
  if (nCrash > pCrash) {
    out.push({
      field: 'crashes.total',
      oldValue: pCrash, newValue: nCrash,
      severity: CarrierChangeSeverity.WARN,
      description: `New crash(es) on record (${pCrash} → ${nCrash})`,
    });
  }

  // Chameleon risk level escalation
  cmp(out, 'chameleon.risk_level',
    prev?.chameleon?.risk_level,
    next?.chameleon?.risk_level,
    CarrierChangeSeverity.WARN, 'Chameleon / fraud risk level changed');

  return out;
}

function cmp(out: ChangeEntry[], field: string, prev: any, next: any, severity: CarrierChangeSeverity, description: string) {
  if (prev !== next && (prev || next)) {
    out.push({ field, oldValue: prev, newValue: next, severity, description });
  }
}
