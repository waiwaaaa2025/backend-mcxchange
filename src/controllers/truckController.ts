import { Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { truckService } from '../services/truckService';
import { config } from '../config';
import { TruckCondition, Listing, UnlockedListing, UserRole } from '../models';
import { stripVins } from '../utils/listingSanitize';

const fileToPublicUrl = (file: Express.Multer.File): string => {
  const s3Url = (file as any).s3Url as string | undefined;
  if (s3Url) return s3Url;
  // Local disk fallback — multer.diskStorage stores with file.filename
  return `${config.apiUrl}/uploads/${file.filename}`;
};

export const listTrucks = asyncHandler(async (req: AuthRequest, res: Response) => {
  const listingId = req.params.listingId;
  const trucks = await truckService.listByListing(listingId);

  // VINs identify the carrier behind a masked listing — owner, admin and
  // buyers who unlocked it only.
  let entitled = req.user?.role === UserRole.ADMIN;
  if (!entitled && req.user) {
    const listing = await Listing.findByPk(listingId, { attributes: ['id', 'sellerId'] });
    entitled = listing?.sellerId === req.user.id
      || !!(await UnlockedListing.findOne({ where: { userId: req.user.id, listingId } }));
  }

  res.json({ success: true, data: entitled ? trucks : stripVins(trucks) });
});

export const createTruck = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }
  const listingId = req.params.listingId;
  const truck = await truckService.create(listingId, req.user.id, req.body);
  res.status(201).json({ success: true, data: truck });
});

export const updateTruck = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }
  const truck = await truckService.update(req.params.truckId, req.user.id, req.body);
  res.json({ success: true, data: truck });
});

export const deleteTruck = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }
  await truckService.remove(req.params.truckId, req.user.id);
  res.json({ success: true });
});

export const uploadTruckPhotos = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }
  const files = (req.files as Express.Multer.File[] | undefined) || [];
  if (files.length === 0) {
    res.status(400).json({ success: false, error: 'No photos uploaded' });
    return;
  }
  const payload = files.map((f) => ({
    url: fileToPublicUrl(f),
    filename: f.filename || null,
  }));
  const photos = await truckService.addPhotos(req.params.truckId, req.user.id, payload);
  res.status(201).json({ success: true, data: photos });
});

export const deleteTruckPhoto = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }
  await truckService.removePhoto(req.params.truckId, req.params.photoId, req.user.id);
  res.json({ success: true });
});

// Validate the condition value from untrusted input.
export const validateCondition = (value: unknown): TruckCondition | null => {
  if (!value) return null;
  const v = String(value).toUpperCase();
  return (Object.values(TruckCondition) as string[]).includes(v) ? (v as TruckCondition) : null;
};
