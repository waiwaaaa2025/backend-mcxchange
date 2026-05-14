import { config } from '../config';
import { MorProCarrierReport } from '../types/carrierData';
import cacheService from './cacheService';
import logger from '../utils/logger';

function morproHeaders(): Record<string, string> {
  const key = config.morproCarrier.apiKey;
  return key ? { 'X-API-Key': key } : {};
}

function fetchWithTimeout(url: string, options: RequestInit = {}, timeoutMs = 10000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const headers = { ...morproHeaders(), ...(options.headers || {}) };
  return fetch(url, { ...options, headers, signal: controller.signal }).finally(() => clearTimeout(timer));
}

// Fetch a single endpoint, return null on failure
async function fetchEndpoint(baseUrl: string, dotNumber: string, endpoint: string): Promise<any> {
  try {
    const url = `${baseUrl}/api/carriers/${dotNumber}/${endpoint}`;
    const response = await fetchWithTimeout(url);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

class CarrierDataService {
  private baseUrl: string;

  constructor() {
    this.baseUrl = config.morproCarrier.baseUrl;
  }

  /**
   * Get full carrier report — checks Redis cache first, fetches from MorPro API if miss.
   * Fetches all endpoints in parallel for speed (the bundled /report endpoint can be slow).
   */
  async getFullReport(dotNumber: string): Promise<MorProCarrierReport | null> {
    try {
      // 1. Check Redis cache
      const cached = await cacheService.getCachedCarrierReport<MorProCarrierReport>(dotNumber);
      if (cached) {
        logger.info(`Carrier report cache HIT for DOT ${dotNumber} — serving instantly`);
        return cached;
      }

      const startTime = Date.now();
      logger.info(`Fetching carrier data from MorPro API for DOT ${dotNumber} (parallel)`);

      // 2. Fetch all endpoints in parallel
      const [
        carrier,
        authority,
        safety,
        inspections,
        violations,
        crashes,
        insurance,
        fleet,
        cargo,
        documents,
        related,
        percentiles,
      ] = await Promise.all([
        // Base carrier endpoint: /api/carriers/:dot (no sub-path)
        (async () => {
          try {
            const url = `${this.baseUrl}/api/carriers/${dotNumber}`;
            const res = await fetchWithTimeout(url);
            if (!res.ok) return null;
            return await res.json();
          } catch { return null; }
        })(),
        fetchEndpoint(this.baseUrl, dotNumber, 'authority'),
        fetchEndpoint(this.baseUrl, dotNumber, 'safety'),
        fetchEndpoint(this.baseUrl, dotNumber, 'inspections'),
        fetchEndpoint(this.baseUrl, dotNumber, 'violations'),
        fetchEndpoint(this.baseUrl, dotNumber, 'crashes'),
        fetchEndpoint(this.baseUrl, dotNumber, 'insurance'),
        fetchEndpoint(this.baseUrl, dotNumber, 'fleet'),
        fetchEndpoint(this.baseUrl, dotNumber, 'cargo'),
        fetchEndpoint(this.baseUrl, dotNumber, 'documents'),
        fetchEndpoint(this.baseUrl, dotNumber, 'related'),
        fetchEndpoint(this.baseUrl, dotNumber, 'percentiles'),
      ]);

      if (!carrier) {
        logger.warn(`MorPro API: carrier not found for DOT ${dotNumber}`);
        return null;
      }

      const report: MorProCarrierReport = {
        carrier,
        authority,
        safety,
        inspections,
        violations,
        crashes,
        insurance,
        fleet,
        cargo,
        documents,
        related,
        percentiles,
        monitoring: null,    // Future
        compliance: null,    // Future
      };

      // 3. Cache in Redis (24hr TTL)
      await cacheService.cacheCarrierReport(dotNumber, report);
      logger.info(`Carrier report fetched & cached for DOT ${dotNumber} in ${Date.now() - startTime}ms`);

      return report;
    } catch (error) {
      logger.error('Carrier data fetch error', error as Error, { dotNumber });
      return null;
    }
  }
}

export const carrierDataService = new CarrierDataService();
export default carrierDataService;
