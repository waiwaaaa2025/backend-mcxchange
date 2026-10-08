import { Router } from 'express';
import { authenticate, adminOnly } from '../middleware/auth';
import {
  searchCarriers,
  getCarrierDetail,
  exportCarriersCsv,
  listLeads,
  createLead,
  updateLead,
  deleteLead,
  listReps,
  getLeadActivity,
  logLeadActivityHttp,
  getPipelineStats,
  searchNewCarriers,
  exportNewCarriersCsv,
  chameleonScan,
  exportChameleonScanCsv,
  vinTransfers,
  exportVinTransfersCsv,
} from '../controllers/leadsController';

const router = Router();

router.use(authenticate);
router.use(adminOnly);

// Carrier discovery (against local LINQ snapshot)
router.get('/carriers/search', searchCarriers);
router.get('/carriers/export.csv', exportCarriersCsv);
router.get('/carriers/:dot', getCarrierDetail);

// Brand-new DOT registrations (FMCSA census) with contact email
router.get('/new-carriers', searchNewCarriers);
router.get('/new-carriers/export.csv', exportNewCarriersCsv);

// New DOTs tied to shut-down carriers (bulk chameleon search, FMCSA census)
router.get('/chameleon-scan', chameleonScan);
router.get('/chameleon-scan/export.csv', exportChameleonScanCsv);
router.get('/vin-transfers', vinTransfers);
router.get('/vin-transfers/export.csv', exportVinTransfersCsv);

// Saved leads
router.get('/', listLeads);
router.post('/', createLead);
router.patch('/:id', updateLead);
router.delete('/:id', deleteLead);

// CRM polish — activity timeline + pipeline widgets
router.get('/pipeline/stats', getPipelineStats);
router.get('/:id/activity', getLeadActivity);
router.post('/:id/activity', logLeadActivityHttp);

// Helpers
router.get('/meta/reps', listReps);

export default router;
