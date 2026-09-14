import { Request, Response } from 'express';
import { carrierDataService } from '../services/carrierDataService';
import cacheService from '../services/cacheService';
import { asyncHandler } from '../middleware/errorHandler';

export const getCarrierReport = asyncHandler(async (req: Request, res: Response) => {
  const dotNumber = req.params.dotNumber as string;

  if (!dotNumber || isNaN(Number(dotNumber))) {
    return res.status(400).json({ success: false, error: 'Valid DOT number is required' });
  }

  const report = await carrierDataService.getFullReport(dotNumber);

  if (!report) {
    return res.status(404).json({ success: false, error: 'Carrier data not found' });
  }

  res.json({ success: true, data: report });
});

export const refreshCarrierReport = asyncHandler(async (req: Request, res: Response) => {
  const dotNumber = req.params.dotNumber as string;

  if (!dotNumber || isNaN(Number(dotNumber))) {
    return res.status(400).json({ success: false, error: 'Valid DOT number is required' });
  }

  await cacheService.invalidateCarrierReport(dotNumber);
  const report = await carrierDataService.getFullReport(dotNumber);

  if (!report) {
    return res.status(404).json({ success: false, error: 'Carrier data not found' });
  }

  res.json({ success: true, data: report, cached: false });
});
