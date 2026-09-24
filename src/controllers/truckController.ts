import { Response } from 'express';
import { asyncHandler } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { truckService } from '../services/truckService';
import { config } from '../config';
import { TruckCondition, Listing, ListingStatus, Truck, TruckPhoto, UnlockedListing, UserRole } from '../models';
import { publicListingTitle, scrubIdentity, stripVins } from '../utils/listingSanitize';
import { NotFoundError } from '../middleware/errorHandler';

const fileToPublicUrl = (file: Express.Multer.File): string => {
  const s3Url = (file as any).s3Url as string | undefined;
  if (s3Url) return s3Url;
  // Local disk fallback — multer.diskStorage stores with file.filename
  return `${config.apiUrl}/uploads/${file.filename}`;
};

const isAdmin = (req: AuthRequest) => req.user?.role === UserRole.ADMIN;

// Admin, the listing's seller, or a buyer who unlocked it sees VINs and the
// carrier's identity; everyone else gets the masked view.
const canSeeIdentity = async (req: AuthRequest, listing: { id: string; sellerId: string }) => {
  if (!req.user) return false;
  if (isAdmin(req) || listing.sellerId === req.user.id) return true;
  return !!(await UnlockedListing.findOne({ where: { userId: req.user.id, listingId: listing.id } }));
};

// Listings whose equipment pages are public. Anything else (draft, pending,
// rejected, suspended) is visible to the seller and admins only.
const PUBLIC_STATUSES: string[] = [ListingStatus.ACTIVE, ListingStatus.RESERVED, ListingStatus.SOLD];

/**
 * One piece of equipment (truck or trailer) with its photos, a masked summary
 * of the authority listing it's sold with, and the listing's other equipment.
 */
export const getEquipment = asyncHandler(async (req: AuthRequest, res: Response) => {
  const truck = await Truck.findByPk(req.params.truckId, {
    include: [
      { model: TruckPhoto, as: 'photos' },
      {
        model: Listing,
        as: 'listing',
        attributes: [
          'id', 'sellerId', 'title', 'status', 'city', 'state', 'authorityType',
          'askingPrice', 'listingPrice', 'mcNumber', 'dotNumber', 'legalName', 'dbaName',
        ],
      },
    ],
    order: [[{ model: TruckPhoto, as: 'photos' }, 'displayOrder', 'ASC']],
  });
  const listing = truck?.listing;
  if (!truck || !listing) throw new NotFoundError('Equipment');

  const entitled = await canSeeIdentity(req, listing);
  const owner = isAdmin(req) || listing.sellerId === req.user?.id;
  if (!owner && !PUBLIC_STATUSES.includes(listing.status)) throw new NotFoundError('Equipment');

  const identity = {
    mcNumber: listing.mcNumber,
    dotNumber: listing.dotNumber,
    legalName: listing.legalName,
    dbaName: listing.dbaName,
  };
  const item: any = truck.toJSON();
  delete item.listing;
  if (!entitled && item.description) item.description = scrubIdentity(item.description, identity);

  const siblings = await Truck.findAll({
    where: { listingId: listing.id },
    attributes: ['id', 'equipmentType', 'make', 'model', 'year', 'price', 'trailerType'],
    include: [{ model: TruckPhoto, as: 'photos', attributes: ['url', 'displayOrder'] }],
    order: [['displayOrder', 'ASC'], ['createdAt', 'ASC']],
  });

  res.json({
    success: true,
    data: {
      equipment: entitled ? item : stripVins(item),
      // A VIN is hidden (not missing) until unlock — lets the page say so.
      vinOnFile: !!truck.vin,
      canEdit: owner,
      listing: {
        id: listing.id,
        title: entitled ? listing.title : publicListingTitle({ ...identity, title: listing.title, state: listing.state }),
        status: listing.status,
        city: listing.city,
        state: listing.state,
        authorityType: listing.authorityType,
        price: Number(listing.listingPrice || listing.askingPrice) || null,
        ...(entitled && { mcNumber: listing.mcNumber }),
      },
      otherEquipment: siblings
        .filter((t) => t.id !== truck.id)
        .map((t) => {
          const photos = [...(t.photos || [])].sort((a, b) => a.displayOrder - b.displayOrder);
          return {
            id: t.id,
            equipmentType: t.equipmentType,
            make: t.make,
            model: t.model,
            year: t.year,
            price: t.price,
            trailerType: t.trailerType,
            photo: photos[0]?.url || null,
          };
        }),
    },
  });
});

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
  const truck = await truckService.create(listingId, req.user.id, req.body, isAdmin(req));
  res.status(201).json({ success: true, data: truck });
});

export const updateTruck = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }
  const truck = await truckService.update(req.params.truckId, req.user.id, req.body, isAdmin(req));
  res.json({ success: true, data: truck });
});

export const deleteTruck = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }
  await truckService.remove(req.params.truckId, req.user.id, isAdmin(req));
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
  const photos = await truckService.addPhotos(req.params.truckId, req.user.id, payload, isAdmin(req));
  res.status(201).json({ success: true, data: photos });
});

export const deleteTruckPhoto = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }
  await truckService.removePhoto(req.params.truckId, req.params.photoId, req.user.id, isAdmin(req));
  res.json({ success: true });
});

// Validate the condition value from untrusted input.
export const validateCondition = (value: unknown): TruckCondition | null => {
  if (!value) return null;
  const v = String(value).toUpperCase();
  return (Object.values(TruckCondition) as string[]).includes(v) ? (v as TruckCondition) : null;
};
