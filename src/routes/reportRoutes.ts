import { Router, Response } from 'express';
import { body } from 'express-validator';
import validate from '../middleware/validate';
import { asyncHandler } from '../middleware/errorHandler';
import { authenticate } from '../middleware/auth';
import { AuthRequest } from '../types';
import contentReportService, { REPORT_REASONS } from '../services/contentReportService';

const router = Router();

// Reason options for the report form
router.get('/reasons', (_req, res) => {
  res.json({ success: true, data: Object.entries(REPORT_REASONS).map(([value, label]) => ({ value, label })) });
});

// Report an MC listing or equipment item (logged-in users only)
router.post(
  '/',
  authenticate,
  validate([
    body('targetType').isIn(['LISTING', 'EQUIPMENT']).withMessage('Invalid report target'),
    body('targetId').isUUID().withMessage('Invalid listing'),
    body('reason').isString().notEmpty().withMessage('Pick a reason for the report'),
    body('details').optional().isString().isLength({ max: 2000 }),
  ]),
  asyncHandler(async (req: AuthRequest, res: Response) => {
    const { duplicate } = await contentReportService.createReport(req.user!.id, req.body);
    res.status(duplicate ? 200 : 201).json({
      success: true,
      message: duplicate
        ? 'You already reported this listing. Our team is reviewing it.'
        : 'Thanks — our team will review this listing.',
    });
  })
);

export default router;
