import { Listing, Truck, TruckPhoto, TruckCondition } from '../models';
import { NotFoundError, ForbiddenError, BadRequestError } from '../middleware/errorHandler';
import { config } from '../config';
import fs from 'fs';
import path from 'path';

export type EquipmentType = 'TRUCK' | 'TRAILER' | 'PART';
const EQUIPMENT_TYPES: EquipmentType[] = ['TRUCK', 'TRAILER', 'PART'];

export interface TruckInput {
  equipmentType?: EquipmentType | null;
  make: string;
  model?: string | null;
  year?: number | null;
  mileage?: number | null;
  vin?: string | null;
  condition?: TruckCondition | null;
  description?: string | null;
  price?: number | null;
  trailerType?: string | null;
  lengthFt?: number | null;
  engine?: string | null;
  transmission?: string | null;
  city?: string | null;
  state?: string | null;
  name?: string | null;
  partCategory?: string | null;
  partNumber?: string | null;
  quantity?: number | null;
  fitment?: string | null;
}

const str = (v: unknown, max: number): string | null => {
  if (v == null) return null;
  const s = String(v).trim();
  return s ? s.slice(0, max) : null;
};

const num = (v: unknown, { int = false, max = 1e9 } = {}): number | null => {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s]/g, ''));
  if (!isFinite(n) || n < 0 || n > max) return null;
  return int ? Math.round(n) : Math.round(n * 100) / 100;
};

const condition = (v: unknown): TruckCondition | null => {
  const c = String(v || '').toUpperCase();
  return (Object.values(TruckCondition) as string[]).includes(c) ? (c as TruckCondition) : null;
};

/**
 * Clean untrusted equipment input into model fields. Only the keys present in
 * `data` are returned, so it serves partial updates as well as creates.
 */
export function normalizeTruckInput(data: Partial<TruckInput>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const has = (k: keyof TruckInput) => Object.prototype.hasOwnProperty.call(data, k);
  if (has('equipmentType')) {
    const t = String(data.equipmentType || '').toUpperCase() as EquipmentType;
    out.equipmentType = EQUIPMENT_TYPES.includes(t) ? t : 'TRUCK';
  }
  if (has('make')) out.make = str(data.make, 100) || '';
  if (has('model')) out.model = str(data.model, 100) || '';
  if (has('year')) out.year = num(data.year, { int: true, max: 2100 });
  if (has('mileage')) out.mileage = num(data.mileage, { int: true, max: 5_000_000 });
  if (has('vin')) out.vin = str(data.vin, 32)?.toUpperCase() ?? null;
  if (has('condition')) out.condition = condition(data.condition);
  if (has('description')) out.description = str(data.description, 5000);
  if (has('price')) out.price = num(data.price, { max: 10_000_000 });
  if (has('trailerType')) out.trailerType = str(data.trailerType, 50);
  if (has('lengthFt')) out.lengthFt = num(data.lengthFt, { int: true, max: 100 });
  if (has('engine')) out.engine = str(data.engine, 100);
  if (has('transmission')) out.transmission = str(data.transmission, 50);
  if (has('city')) out.city = str(data.city, 100);
  if (has('state')) {
    const st = String(data.state ?? '').trim().toUpperCase();
    out.state = /^[A-Z]{2}$/.test(st) ? st : null;
  }
  if (has('name')) out.name = str(data.name, 200);
  if (has('partCategory')) out.partCategory = str(data.partCategory, 50);
  if (has('partNumber')) out.partNumber = str(data.partNumber, 100);
  if (has('quantity')) out.quantity = num(data.quantity, { int: true, max: 100_000 });
  if (has('fitment')) out.fitment = str(data.fitment, 255);
  return out;
}

const assertListingOwner = async (listingId: string, userId: string, isAdmin = false): Promise<Listing> => {
  const listing = await Listing.findByPk(listingId);
  if (!listing) throw new NotFoundError('Listing');
  if (!isAdmin && listing.sellerId !== userId) {
    throw new ForbiddenError('You do not own this listing');
  }
  return listing;
};

const assertTruckOwner = async (truckId: string, userId: string, isAdmin = false): Promise<Truck> => {
  const truck = await Truck.findByPk(truckId);
  if (!truck) throw new NotFoundError('Truck');
  if (isAdmin || truck.sellerId === userId) return truck;
  // Equipment sold with an authority belongs to that listing's seller.
  const listing = truck.listingId ? await Listing.findByPk(truck.listingId) : null;
  if (!listing || listing.sellerId !== userId) {
    throw new ForbiddenError('You do not own this equipment');
  }
  return truck;
};

export const truckService = {
  async listByListing(listingId: string) {
    return Truck.findAll({
      where: { listingId },
      include: [{ model: TruckPhoto, as: 'photos' }],
      order: [
        ['displayOrder', 'ASC'],
        ['createdAt', 'ASC'],
      ],
    });
  },

  async create(listingId: string, userId: string, data: TruckInput, isAdmin = false) {
    await assertListingOwner(listingId, userId, isAdmin);
    const fields = normalizeTruckInput({ equipmentType: 'TRUCK', ...data });
    if (!fields.make) throw new BadRequestError('Make is required');
    const count = await Truck.count({ where: { listingId } });
    return Truck.create({ listingId, ...fields, displayOrder: count });
  },

  async createMany(listingId: string, items: TruckInput[]): Promise<Truck[]> {
    if (!items || items.length === 0) return [];
    const rows = items
      .map((t) => normalizeTruckInput({ equipmentType: 'TRUCK', ...t }))
      .filter((f) => f.make)
      .map((f, i) => ({ listingId, ...f, displayOrder: i }));
    if (rows.length === 0) return [];
    return Truck.bulkCreate(rows as any);
  },

  async update(truckId: string, userId: string, data: Partial<TruckInput>, isAdmin = false) {
    const truck = await assertTruckOwner(truckId, userId, isAdmin);
    const fields = normalizeTruckInput(data);
    if ('make' in fields && !fields.make) throw new BadRequestError('Make is required');
    await truck.update(fields);
    return truck;
  },

  async remove(truckId: string, userId: string, isAdmin = false) {
    const truck = await assertTruckOwner(truckId, userId, isAdmin);
    // Clean up local photos on disk if we're not using S3.
    const photos = await TruckPhoto.findAll({ where: { truckId } });
    if (!config.upload.s3.enabled) {
      for (const p of photos) {
        try {
          const uploadDir = config.upload.uploadDir;
          if (p.filename) {
            const full = path.join(uploadDir, p.filename);
            if (fs.existsSync(full)) fs.unlinkSync(full);
          }
        } catch {
          // best-effort cleanup
        }
      }
    }
    await TruckPhoto.destroy({ where: { truckId } });
    await truck.destroy();
  },

  async addPhotos(
    truckId: string,
    userId: string,
    files: Array<{ url: string; filename?: string | null }>,
    isAdmin = false
  ) {
    await assertTruckOwner(truckId, userId, isAdmin);
    if (!files || files.length === 0) return [];
    const existing = await TruckPhoto.count({ where: { truckId } });
    const rows = files.map((f, i) => ({
      truckId,
      url: f.url,
      filename: f.filename ?? null,
      displayOrder: existing + i,
    }));
    return TruckPhoto.bulkCreate(rows as any);
  },

  async removePhoto(truckId: string, photoId: string, userId: string, isAdmin = false) {
    await assertTruckOwner(truckId, userId, isAdmin);
    const photo = await TruckPhoto.findOne({ where: { id: photoId, truckId } });
    if (!photo) throw new NotFoundError('Photo');
    if (!config.upload.s3.enabled && photo.filename) {
      try {
        const full = path.join(config.upload.uploadDir, photo.filename);
        if (fs.existsSync(full)) fs.unlinkSync(full);
      } catch {
        // best-effort cleanup
      }
    }
    await photo.destroy();
  },
};
