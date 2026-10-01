import { config } from '../config';
import { FMCSACarrierData, FMCSAAuthorityHistory, FMCSAInsuranceHistory } from '../types';
import carrierDataService from './carrierDataService';
import logger from '../utils/logger';

function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 15000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// SMS (Safety Measurement System) data types
export interface FMCSASMSBasic {
  basicName: string;
  basicCode: string;
  percentile: number;
  totalInspections: number;
  totalViolations: number;
  oosInspections: number;
  oosRate: number;
  thresholdPercent: number;
  exceedsThreshold: boolean;
}

export interface FMCSASMSData {
  dotNumber: string;
  totalInspections: number;
  totalDriverInspections: number;
  totalVehicleInspections: number;
  totalHazmatInspections: number;
  totalIepInspections: number;
  driverOosRate: number;
  vehicleOosRate: number;
  driverOosInspections: number;
  vehicleOosInspections: number;
  totalCrashes: number;
  fatalCrashes: number;
  injuryCrashes: number;
  towCrashes: number;
  basics: FMCSASMSBasic[];
  safetyRating: string;
  safetyRatingDate?: string;
  snapshotDate?: string;
}

interface FMCSACarrierRaw {
  dotNumber: number | string;
  legalName: string;
  dbaName?: string | null;
  carrierOperation?: {
    carrierOperationCode?: string;
    carrierOperationDesc?: string;
  };
  phyCity: string;
  phyState: string;
  phyStreet: string;
  phyZipcode?: string;
  phone?: string;
  safetyRating?: string | null;
  safetyRatingDate?: string | null;
  totalDrivers: number;
  totalPowerUnits: number;
  mcs150FormDate?: string;
  allowedToOperate: string;
  bipdRequiredAmount?: number | string;
  cargoRequiredAmount?: number | string;
  bondRequiredAmount?: number | string;
  bipdInsuranceOnFile?: number | string;
  cargoInsuranceOnFile?: number | string;
  bondInsuranceOnFile?: number | string;
  // Additional fields from actual API
  ein?: number;
  commonAuthorityStatus?: string;
  contractAuthorityStatus?: string;
  brokerAuthorityStatus?: string;
  // Inspection data
  driverInsp?: number;
  driverOosInsp?: number;
  driverOosRate?: number;
  vehicleInsp?: number;
  vehicleOosInsp?: number;
  vehicleOosRate?: number;
  hazmatInsp?: number;
  hazmatOosInsp?: number;
  hazmatOosRate?: number;
  // Crash data
  crashTotal?: number;
  fatalCrash?: number;
  injuryCrash?: number;
  towCrash?: number;
  // BASIC scores
  unsafeDrivingBasic?: number;
  hoursOfServiceBasic?: number;
  driverFitnessBasic?: number;
  controlledSubstancesBasic?: number;
  vehicleMaintenanceBasic?: number;
  hazmatBasic?: number;
  crashIndicatorBasic?: number;
}

// Response for single carrier lookup (by DOT)
interface FMCSASingleResponse {
  content?: {
    carrier?: FMCSACarrierRaw;
  };
}

// Response for docket-number lookup (by MC) - returns array
interface FMCSAArrayResponse {
  content?: Array<{
    carrier?: FMCSACarrierRaw;
  }>;
}

class FMCSAService {
  private apiKey: string;
  private baseUrl: string;

  constructor() {
    this.apiKey = config.fmcsa.apiKey;
    this.baseUrl = config.fmcsa.baseUrl;
  }

  // Lookup carrier by DOT number
  async lookupByDOT(dotNumber: string): Promise<FMCSACarrierData | null> {
    try {
      const url = `${this.baseUrl}/carriers/${dotNumber}?webKey=${this.apiKey}`;
      logger.debug('FMCSA DOT lookup URL:', url);
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        console.error(`FMCSA API error: ${response.status}`);
        return null;
      }

      const data = await response.json() as FMCSASingleResponse;
      logger.debug('FMCSA DOT response:', JSON.stringify(data).substring(0, 500));

      if (!data.content?.carrier) {
        return null;
      }

      return this.mapCarrierData(data.content.carrier);
    } catch (error) {
      logger.warn('FMCSA lookup error:', error);
      return null;
    }
  }

  // Lookup carrier by MC number
  async lookupByMC(mcNumber: string): Promise<FMCSACarrierData | null> {
    try {
      // MC lookup requires a different endpoint - returns array
      const url = `${this.baseUrl}/carriers/docket-number/${mcNumber}?webKey=${this.apiKey}`;
      logger.debug('FMCSA MC lookup URL:', url);
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        console.error(`FMCSA API error: ${response.status}`);
        return null;
      }

      const data = await response.json() as FMCSAArrayResponse;
      logger.debug('FMCSA MC response:', JSON.stringify(data).substring(0, 500));

      // MC lookup returns an array in content
      if (!data.content || !Array.isArray(data.content) || data.content.length === 0) {
        logger.debug('FMCSA: No carriers found for MC number');
        return null;
      }

      // Get the first carrier from the array
      const carrierData = data.content[0]?.carrier;
      if (!carrierData) {
        logger.debug('FMCSA: Carrier data missing from response');
        return null;
      }

      return this.mapCarrierData(carrierData);
    } catch (error) {
      logger.warn('FMCSA lookup error:', error);
      return null;
    }
  }

  // Get authority history
  async getAuthorityHistory(dotNumber: string): Promise<FMCSAAuthorityHistory | null> {
    try {
      const url = `${this.baseUrl}/carriers/${dotNumber}/authority?webKey=${this.apiKey}`;
      const response = await fetchWithTimeout(url);

      if (!response.ok) {
        return null;
      }

      const data = await response.json() as { content?: any };

      if (!data.content) {
        return null;
      }

      // FMCSA returns content as an array (one entry per authority type)
      // or as a single object. Normalize to work with both.
      if (Array.isArray(data.content)) {
        // Array format: each element has authTypeCd (C=Common, E=Contract, B=Broker),
        // authActCd (status), authGrantDt, etc.
        const result: FMCSAAuthorityHistory = {
          commonAuthorityStatus: 'N/A',
          contractAuthorityStatus: 'N/A',
          brokerAuthorityStatus: 'N/A',
        };

        for (const entry of data.content) {
          // QCMobile wraps each docket as { carrierAuthority: { commonAuthorityStatus: 'A', ... } }
          // with flat per-type statuses — no authTypeCd.
          const ca = entry?.carrierAuthority;
          if (ca) {
            // A=Active, I=Inactive, N=None. Any docket being active wins.
            const word = (s: unknown) =>
              ({ A: 'ACTIVE', I: 'INACTIVE', N: 'NONE' } as Record<string, string>)[String(s || '').toUpperCase()];
            const merge = (cur: string, next: unknown) =>
              cur === 'ACTIVE' ? cur : word(next) || cur;
            result.commonAuthorityStatus = merge(result.commonAuthorityStatus, ca.commonAuthorityStatus);
            result.contractAuthorityStatus = merge(result.contractAuthorityStatus, ca.contractAuthorityStatus);
            result.brokerAuthorityStatus = merge(result.brokerAuthorityStatus, ca.brokerAuthorityStatus);
            continue;
          }

          const item = entry;
          const type = String(item.authTypeCd || item.authorityType || '').toUpperCase();
          const status = item.authActCd || item.authStatus || item.status || 'N/A';
          const grantDate = item.authGrantDt || item.grantDate || item.grantDt;
          const revokedDate = item.authRevokedDt || item.revokedDate;
          const reinstatedDate = item.authReinstatedDt || item.reinstatedDate;
          const appDate = item.applicationDt || item.applDt;
          const effDate = item.effectiveDt || item.effDt;

          if (type === 'C' || type === 'COMMON') {
            result.commonAuthorityStatus = status;
            result.commonAuthorityGrantDate = grantDate;
            result.commonAuthorityRevokedDate = revokedDate;
            result.commonAuthorityReinstatedDate = reinstatedDate;
            result.applicationDate = result.applicationDate || appDate;
            result.effectiveDate = result.effectiveDate || effDate;
          } else if (type === 'E' || type === 'CONTRACT') {
            result.contractAuthorityStatus = status;
            result.contractAuthorityGrantDate = grantDate;
          } else if (type === 'B' || type === 'BROKER') {
            result.brokerAuthorityStatus = status;
            result.brokerAuthorityGrantDate = grantDate;
          }

          // Capture grant/effective dates from any entry as fallback
          if (!result.grantDate && grantDate) result.grantDate = grantDate;
          if (!result.effectiveDate && effDate) result.effectiveDate = effDate;
        }

        return result;
      }

      // Single object format (legacy)
      return {
        commonAuthorityStatus: data.content.commonAuthorityStatus || 'N/A',
        commonAuthorityGrantDate: data.content.commonAuthorityGrantDate,
        commonAuthorityReinstatedDate: data.content.commonAuthorityReinstatedDate,
        commonAuthorityRevokedDate: data.content.commonAuthorityRevokedDate,
        contractAuthorityStatus: data.content.contractAuthorityStatus || 'N/A',
        contractAuthorityGrantDate: data.content.contractAuthorityGrantDate,
        brokerAuthorityStatus: data.content.brokerAuthorityStatus || 'N/A',
        brokerAuthorityGrantDate: data.content.brokerAuthorityGrantDate,
        applicationDate: data.content.applicationDt || undefined,
        grantDate: data.content.grantDt || undefined,
        effectiveDate: data.content.effectiveDt || undefined,
        revocationDate: data.content.revssnDt || undefined,
      };
    } catch (error) {
      logger.warn('FMCSA authority history error:', error);
      return null;
    }
  }

  // Get insurance history
  //
  // FMCSA's QCMobile API has no insurance endpoint — filings live in the
  // separate L&I system, which exposes no JSON API — so this sources from the
  // MorPro carrier report (its insurance section is itself derived from L&I)
  // and normalizes it into the FMCSA-shaped history clients already consume.
  // getFullReport is Redis-cached for 24h and the pages calling this have
  // usually fetched the same report already, so this is normally a cache hit.
  async getInsuranceHistory(dotNumber: string): Promise<FMCSAInsuranceHistory[] | null> {
    let report;
    try {
      report = await carrierDataService.getFullReport(dotNumber);
    } catch (error) {
      logger.warn('Insurance history lookup failed:', error);
      return null;
    }

    // Only a missing carrier report is a "not found" — a carrier with no
    // filings on record legitimately has an empty history.
    if (!report) {
      return null;
    }

    interface MorProPolicy {
      insurer?: string;
      insurerName?: string;
      policyNumber?: string;
      type?: string;
      typeLabel?: string;
      insuranceType?: string;
      coverage?: number;
      coverageAmount?: number;
      effectiveDate?: string;
      expirationDate?: string;
      cancelDate?: string;
      cancellationDate?: string;
      status?: string;
    }

    interface MorProPolicyEvent extends MorProPolicy {
      date?: string;
      event?: string;
    }

    const insurance = (report.insurance || {}) as {
      activePolicies?: MorProPolicy[];
      history?: MorProPolicyEvent[];
    };
    const activePolicies = Array.isArray(insurance.activePolicies) ? insurance.activePolicies : [];
    const history = Array.isArray(insurance.history) ? insurance.history : [];

    const active: FMCSAInsuranceHistory[] = activePolicies.map((p) => ({
      insurerName: p.insurerName || p.insurer || '',
      policyNumber: p.policyNumber || '',
      insuranceType: p.insuranceType || p.typeLabel || p.type || '',
      coverageAmount: p.coverageAmount ?? p.coverage ?? 0,
      effectiveDate: p.effectiveDate || '',
      // A cancel date on an active policy is a *pending* cancellation — the
      // signal buyers care about most.
      cancellationDate: p.cancelDate || p.cancellationDate || p.expirationDate || undefined,
      status: p.status || 'active',
    }));

    // Past filings: every history entry is a closed policy, so it carries the
    // date it was cancelled/replaced.
    const past: FMCSAInsuranceHistory[] = history.map((h) => ({
      insurerName: h.insurerName || h.insurer || '',
      policyNumber: h.policyNumber || '',
      insuranceType: h.insuranceType || h.typeLabel || h.type || '',
      coverageAmount: h.coverageAmount ?? h.coverage ?? 0,
      effectiveDate: h.effectiveDate || h.date || '',
      cancellationDate: h.cancelDate || h.cancellationDate || undefined,
      status: (h.event || h.status || 'cancelled').toLowerCase(),
    }));

    return [...active, ...past];
  }

  // Get SMS (Safety Measurement System) data - includes inspections, crashes, and BASIC scores
  async getSMSData(dotNumber: string): Promise<FMCSASMSData | null> {
    try {
      // The FMCSA API provides basics, OOS, and carrier endpoints
      const basicsUrl = `${this.baseUrl}/carriers/${dotNumber}/basics?webKey=${this.apiKey}`;
      const oosUrl = `${this.baseUrl}/carriers/${dotNumber}/oos?webKey=${this.apiKey}`;
      const carrierUrl = `${this.baseUrl}/carriers/${dotNumber}?webKey=${this.apiKey}`;

      logger.debug('FMCSA SMS lookup URLs:', basicsUrl, oosUrl);

      const [basicsResponse, oosResponse, carrierResponse] = await Promise.all([
        fetchWithTimeout(basicsUrl).catch(() => null),
        fetchWithTimeout(oosUrl).catch(() => null),
        fetchWithTimeout(carrierUrl).catch(() => null),
      ]);

      // Parse BASIC scores
      interface BasicRaw {
        basicsId?: number;
        basBasicCd?: string;
        basBasicDesc?: string;
        basMeasure?: number;
        basTotInsp?: number;
        basTotViol?: number;
        basOosInsp?: number;
        basOosRate?: number;
        basThreshPct?: number;
        basExceedFlag?: string;
      }

      let basics: FMCSASMSBasic[] = [];
      if (basicsResponse?.ok) {
        const basicsData = await basicsResponse.json() as { content?: BasicRaw[] };
        if (basicsData.content && Array.isArray(basicsData.content)) {
          basics = basicsData.content.map((b: BasicRaw) => ({
            basicName: b.basBasicDesc || 'Unknown',
            basicCode: b.basBasicCd || '',
            percentile: b.basMeasure || 0,
            totalInspections: b.basTotInsp || 0,
            totalViolations: b.basTotViol || 0,
            oosInspections: b.basOosInsp || 0,
            oosRate: b.basOosRate || 0,
            thresholdPercent: b.basThreshPct || 0,
            exceedsThreshold: b.basExceedFlag === 'Y',
          }));
        }
      }

      // Parse OOS (Out of Service) data
      interface OOSRaw {
        oosDriverInsp?: number;
        oosDriverOos?: number;
        oosDriverOosRate?: number;
        oosVehicleInsp?: number;
        oosVehicleOos?: number;
        oosVehicleOosRate?: number;
        oosHazmatInsp?: number;
        oosHazmatOos?: number;
        oosIepInsp?: number;
        oosTotInsp?: number;
        oosTotCrashes?: number;
        oosFatalCrashes?: number;
        oosInjCrashes?: number;
        oosTowCrashes?: number;
      }

      let oosData: OOSRaw = {};
      if (oosResponse?.ok) {
        const oosResult = await oosResponse.json() as { content?: OOSRaw | { carrier?: OOSRaw } };
        if (oosResult.content) {
          // FMCSA may nest under content.carrier or return flat under content
          const raw = oosResult.content;
          oosData = (raw as any).carrier || raw;
        }
      }

      // Parse carrier data for crash counts and safety rating fallback
      let carrierData: FMCSACarrierRaw | null = null;
      if (carrierResponse?.ok) {
        const carrierResult = await carrierResponse.json() as { content?: { carrier?: FMCSACarrierRaw } };
        carrierData = carrierResult?.content?.carrier || null;
      }

      // Calculate totals — prefer OOS data, fall back to carrier data
      const totalInspections = oosData.oosTotInsp ||
        (oosData.oosDriverInsp || 0) + (oosData.oosVehicleInsp || 0) ||
        ((carrierData?.driverInsp || 0) + (carrierData?.vehicleInsp || 0));

      return {
        dotNumber,
        totalInspections,
        totalDriverInspections: oosData.oosDriverInsp || carrierData?.driverInsp || 0,
        totalVehicleInspections: oosData.oosVehicleInsp || carrierData?.vehicleInsp || 0,
        totalHazmatInspections: oosData.oosHazmatInsp || carrierData?.hazmatInsp || 0,
        totalIepInspections: oosData.oosIepInsp || 0,
        driverOosRate: oosData.oosDriverOosRate || carrierData?.driverOosRate || 0,
        vehicleOosRate: oosData.oosVehicleOosRate || carrierData?.vehicleOosRate || 0,
        driverOosInspections: oosData.oosDriverOos || carrierData?.driverOosInsp || 0,
        vehicleOosInspections: oosData.oosVehicleOos || carrierData?.vehicleOosInsp || 0,
        totalCrashes: oosData.oosTotCrashes || carrierData?.crashTotal || 0,
        fatalCrashes: oosData.oosFatalCrashes || carrierData?.fatalCrash || 0,
        injuryCrashes: oosData.oosInjCrashes || carrierData?.injuryCrash || 0,
        towCrashes: oosData.oosTowCrashes || carrierData?.towCrash || 0,
        basics,
        safetyRating: carrierData?.safetyRating || 'N/A',
        snapshotDate: new Date().toISOString().split('T')[0],
      };
    } catch (error) {
      logger.warn('FMCSA SMS data error:', error);
      return null;
    }
  }

  // Get full carrier snapshot
  async getCarrierSnapshot(identifier: string, type: 'MC' | 'DOT' = 'DOT'): Promise<{
    carrier: FMCSACarrierData | null;
    authority: FMCSAAuthorityHistory | null;
    insurance: FMCSAInsuranceHistory[] | null;
  }> {
    let carrier: FMCSACarrierData | null = null;

    if (type === 'MC') {
      carrier = await this.lookupByMC(identifier);
    } else {
      carrier = await this.lookupByDOT(identifier);
    }

    if (!carrier) {
      return { carrier: null, authority: null, insurance: null };
    }

    const [authority, insurance] = await Promise.all([
      this.getAuthorityHistory(carrier.dotNumber),
      this.getInsuranceHistory(carrier.dotNumber),
    ]);

    return { carrier, authority, insurance };
  }

  // Map raw API response to our data structure
  private mapCarrierData(rawCarrier: FMCSACarrierRaw): FMCSACarrierData {
    if (!rawCarrier) {
      throw new Error('Invalid carrier data');
    }

    // Helper to parse numbers from string or number
    const toNumber = (val: string | number | undefined | null): number => {
      if (val === null || val === undefined) return 0;
      const num = typeof val === 'string' ? parseFloat(val) : val;
      return isNaN(num) ? 0 : num;
    };

    return {
      dotNumber: String(rawCarrier.dotNumber),
      legalName: rawCarrier.legalName,
      dbaName: rawCarrier.dbaName || undefined,
      carrierOperation: rawCarrier.carrierOperation?.carrierOperationDesc || 'Unknown',
      hqCity: rawCarrier.phyCity,
      hqState: rawCarrier.phyState,
      physicalAddress: rawCarrier.phyStreet,
      phone: rawCarrier.phone || '',
      safetyRating: rawCarrier.safetyRating || 'None',
      safetyRatingDate: rawCarrier.safetyRatingDate || undefined,
      totalDrivers: rawCarrier.totalDrivers || 0,
      totalPowerUnits: rawCarrier.totalPowerUnits || 0,
      mcs150Date: rawCarrier.mcs150FormDate,
      allowedToOperate: rawCarrier.allowedToOperate,
      bipdRequired: toNumber(rawCarrier.bipdRequiredAmount),
      cargoRequired: toNumber(rawCarrier.cargoRequiredAmount),
      bondRequired: toNumber(rawCarrier.bondRequiredAmount),
      insuranceOnFile: toNumber(rawCarrier.bipdInsuranceOnFile) > 0,
      bipdOnFile: toNumber(rawCarrier.bipdInsuranceOnFile),
      cargoOnFile: toNumber(rawCarrier.cargoInsuranceOnFile),
      bondOnFile: toNumber(rawCarrier.bondInsuranceOnFile),
      cargoTypes: [], // Would need additional API call to get cargo types
      // Inspection data
      driverInsp: rawCarrier.driverInsp || 0,
      driverOosInsp: rawCarrier.driverOosInsp || 0,
      driverOosRate: rawCarrier.driverOosRate || 0,
      vehicleInsp: rawCarrier.vehicleInsp || 0,
      vehicleOosInsp: rawCarrier.vehicleOosInsp || 0,
      vehicleOosRate: rawCarrier.vehicleOosRate || 0,
      hazmatInsp: rawCarrier.hazmatInsp || 0,
      hazmatOosInsp: rawCarrier.hazmatOosInsp || 0,
      hazmatOosRate: rawCarrier.hazmatOosRate || 0,
      // Crash data
      crashTotal: rawCarrier.crashTotal || 0,
      fatalCrash: rawCarrier.fatalCrash || 0,
      injuryCrash: rawCarrier.injuryCrash || 0,
      towCrash: rawCarrier.towCrash || 0,
      // BASIC scores
      unsafeDrivingBasic: rawCarrier.unsafeDrivingBasic || 0,
      hoursOfServiceBasic: rawCarrier.hoursOfServiceBasic || 0,
      driverFitnessBasic: rawCarrier.driverFitnessBasic || 0,
      controlledSubstancesBasic: rawCarrier.controlledSubstancesBasic || 0,
      vehicleMaintenanceBasic: rawCarrier.vehicleMaintenanceBasic || 0,
      hazmatBasic: rawCarrier.hazmatBasic || 0,
      crashIndicatorBasic: rawCarrier.crashIndicatorBasic || 0,
    };
  }

  // Get cargo carried by a carrier from FMCSA
  async getCargoCarried(dotNumber: string): Promise<string[]> {
    try {
      const url = `${this.baseUrl}/carriers/${dotNumber}/cargo-carried?webKey=${this.apiKey}`;
      const response = await fetchWithTimeout(url);
      if (!response.ok) return [];

      const data = await response.json() as { content?: Array<{ cargoClassDesc?: string; cargoClassId?: number }> };
      if (!data.content || !Array.isArray(data.content)) return [];

      return data.content
        .map(c => c.cargoClassDesc || '')
        .filter(Boolean);
    } catch (error) {
      logger.warn('FMCSA cargo-carried error:', error);
      return [];
    }
  }

  // Verify MC number is valid and active
  async verifyMC(mcNumber: string): Promise<{
    valid: boolean;
    active: boolean;
    reason?: string;
  }> {
    const carrier = await this.lookupByMC(mcNumber);

    if (!carrier) {
      return { valid: false, active: false, reason: 'MC number not found' };
    }

    const isActive = carrier.allowedToOperate === 'Y';

    return {
      valid: true,
      active: isActive,
      reason: isActive ? undefined : 'Carrier is not allowed to operate',
    };
  }
}

export const fmcsaService = new FMCSAService();
export default fmcsaService;
