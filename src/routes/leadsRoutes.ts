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
