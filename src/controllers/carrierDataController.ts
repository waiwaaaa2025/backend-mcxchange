import { Request, Response } from 'express';
import { carrierDataService } from '../services/carrierDataService';
import cacheService from '../services/cacheService';
import { asyncHandler } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { stripVins } from '../utils/listingSanitize';
import { chameleonIntelService } from '../services/chameleonIntelService';

export const getCarrierReport = asyncHandler(async (req: AuthRequest, res: Response) => {
  const dotNumber = req.params.dotNumber as string;

  if (!dotNumber || isNaN(Number(dotNumber))) {
    return res.status(400).json({ success: false, error: 'Valid DOT number is required' });
  }

  const report = await carrierDataService.getFullReport(dotNumber);

  if (!report) {
    return res.status(404).json({ success: false, error: 'Carrier data not found' });
  }

  // Fleet VINs are paid Carrier Pulse data; anonymous preview visitors don't get them.
  res.json({ success: true, data: req.user ? report : stripVins(report) });
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

// Chameleon Check evidence: other DOTs running the same VINs, shared contact /
// officer / address details, and identity changes over time.
export const getChameleonIntel = asyncHandler(async (req: AuthRequest, res: Response) => {
  const dotNumber = req.params.dotNumber as string;

  if (!dotNumber || isNaN(Number(dotNumber))) {
    return res.status(400).json({ success: false, error: 'Valid DOT number is required' });
  }

  const intel = await chameleonIntelService.getIntel(dotNumber);

  if (!intel) {
    return res.status(404).json({ success: false, error: 'Carrier not found in FMCSA census' });
  }

  res.json({ success: true, data: intel });
});
