// MorPro Carrier API response types
// Using `any` initially — will tighten once real response shapes are confirmed

export interface MorProCarrierReport {
  carrier: any;       // 49 fields — core profile
  authority: any;     // statuses, pendingFlags, revocations, timeline
  safety: any;        // basicScores[], basicAlerts{}, violationBreakdown{}, inspectionTotals{}
  inspections: any;   // summary{}, topViolations[], records[], pagination{}
  violations: any;    // violations[], trend[]
  crashes: any;       // summary{}, records[]
  insurance: any;     // activePolicies[], renewalTimeline[], history[], gaps[]
  fleet: any;         // trucks[], trailers[], sharedEquipment{}
  cargo: any;         // 30+ boolean flags
  documents: any;     // dockets[], insuranceOnFile[], boc3{}, mcs150{}, safetyRating{}, verificationChecks[]
  related: any;       // relatedCarriers[]
  percentiles: any;   // percentiles[]
  monitoring: any;    // null placeholders (future)
  compliance: any;    // null placeholders (future)
}

// Pending Insurance Leads — cross-carrier search (LINQ POST /v1/carriers/search)
export interface InsuranceLeadFilters {
  insuranceStatus?: 'pending' | 'expiring';
  expiringWithinDays?: number;
  state?: string;
  minUnits?: number;
  maxUnits?: number;
  minSafety?: string;
  // Prospecting filters the Leads / Lead Generator tools pass through.
  nameContains?: string;
  addedAfter?: string;   // YYYY-MM-DD or YYYYMMDD
  addedBefore?: string;  // YYYY-MM-DD or YYYYMMDD
  sort?: string;
}

/** What FMCSA says about one carrier's liability coverage right now. */
export interface InsuranceSnapshot {
  status: 'COVERAGE_LAPSED' | 'CANCELLATION_SCHEDULED' | 'COVERED';
  cancellationDate: string | null;   // ISO; null unless a cancellation actually bites
  daysUntilCancellation: number | null;
  insuranceCompany: string | null;   // insurer on that policy; null when COVERED
}

/** Public FMCSA census contact for a carrier. */
export interface CarrierContact {
  phone: string | null;
  email: string | null;
}

export interface InsuranceLead {
  dotNumber: string;
  mcNumber: string | null;
  legalName: string;
  state: string | null;
  powerUnits: number | null;
  safetyRating: string | null;
  // Public FMCSA census contact for the carrier — null when the census has none.
  phone: string | null;
  email: string | null;
  insuranceStatus: 'pending' | 'expiring';
  insuranceExpiryDate: string | null;
  daysUntilExpiry: number | null;
  pendingReason: string | null;
  // Insurer on the policy being cancelled.
  insuranceCompany: string | null;
}

export interface InsuranceLeadsResult {
  total: number;      // rows in this response — LINQ gives no overall count
  limit: number;
  hasMore: boolean;
  nextCursor: string | null;  // pass back as ?cursor= for the next page
  results: InsuranceLead[];
}
