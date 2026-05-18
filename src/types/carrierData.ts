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

// Pending Insurance Leads — cross-carrier search (MorPro /api/carriers/search)
export interface InsuranceLeadFilters {
  insuranceStatus?: 'pending' | 'expiring';
  expiringWithinDays?: number;
  state?: string;
  minUnits?: number;
  maxUnits?: number;
  minSafety?: string;
  sort?: string;
}

export interface InsuranceLead {
  dotNumber: string;
  mcNumber: string | null;
  legalName: string;
  state: string | null;
  powerUnits: number | null;
  safetyRating: string | null;
  insuranceStatus: 'pending' | 'expiring';
  insuranceExpiryDate: string | null;
  daysUntilExpiry: number | null;
  pendingReason: string | null;
}

export interface InsuranceLeadsResult {
  total: number;
  page: number;
  limit: number;
  results: InsuranceLead[];
}
