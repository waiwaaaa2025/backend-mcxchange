import { Op, WhereOptions } from 'sequelize';
import { Listing, ListingStatus, Notification, NotificationType, Truck, TruckPhoto, User } from '../models';
import { BadRequestError, ForbiddenError, NotFoundError } from '../middleware/errorHandler';
import { EquipmentType, TruckInput, normalizeTruckInput } from './truckService';

/**
 * Equipment & parts marketplace. Items live in the `trucks` table:
 *  - attached: sold with an authority (listingId set), public while that
 *    listing is ACTIVE; status/owner come from the listing.
 *  - standalone: listingId null, owned by sellerId, with their own review
 *    lifecycle PENDING_REVIEW → ACTIVE | REJECTED, and ACTIVE ↔ SOLD.
 */
export const ItemStatus = {
  PENDING_REVIEW: 'PENDING_REVIEW',
  ACTIVE: 'ACTIVE',
  SOLD: 'SOLD',
  REJECTED: 'REJECTED',
} as const;

export const PUBLIC_ITEM_STATUSES: string[] = [ItemStatus.ACTIVE, ItemStatus.SOLD];

export interface BrowseFilters {
  type?: string; // TRUCK | TRAILER | PART | EQUIPMENT (trucks + trailers)
  search?: string;
  state?: string;
  minPrice?: number;
  maxPrice?: number;
  page?: number;
  limit?: number;
}

const firstPhotos = async (ids: string[]) => {
  if (ids.length === 0) return new Map<string, string>();
  const photos = await TruckPhoto.findAll({
    where: { truckId: ids },
    attributes: ['truckId', 'url', 'displayOrder'],
    order: [['displayOrder', 'ASC'], ['createdAt', 'ASC']],
  });
  const map = new Map<string, string>();
  for (const p of photos) if (!map.has(p.truckId)) map.set(p.truckId, p.url);
  return map;
};

/** Card-sized view of an item — no VIN, no description, no carrier identity. */
const toCard = (t: Truck, photo: string | undefined) => ({
  id: t.id,
  equipmentType: t.equipmentType,
  make: t.make,
  model: t.model,
  name: t.name ?? null,
  year: t.year ?? null,
  mileage: t.mileage ?? null,
  price: t.price ?? null,
  condition: t.condition ?? null,
  trailerType: t.trailerType ?? null,
  lengthFt: t.lengthFt ?? null,
  partCategory: t.partCategory ?? null,
  partNumber: t.partNumber ?? null,
  quantity: t.quantity ?? null,
  city: t.city ?? t.listing?.city ?? null,
  state: t.state ?? t.listing?.state ?? null,
  status: t.listingId ? ItemStatus.ACTIVE : t.status,
  withAuthority: !!t.listingId,
  listingId: t.listingId,
  photo: photo ?? null,
  createdAt: t.createdAt,
});

const notifySeller = (userId: string | null | undefined, title: string, message: string, id: string) =>
  userId
    ? Notification.create({
        userId,
        type: NotificationType.SYSTEM,
        title,
        message,
        link: `/equipment/${id}`,
      }).catch(() => undefined)
    : undefined;

const itemLabel = (t: Truck) => t.name || [t.year, t.make, t.model].filter(Boolean).join(' ') || 'Your item';

export const equipmentMarketService = {
  /** Public browse: live standalone items plus equipment on ACTIVE authority listings. */
  async browse(filters: BrowseFilters) {
    const limit = Math.min(Math.max(Number(filters.limit) || 24, 1), 60);
    const page = Math.max(Number(filters.page) || 1, 1);
    const type = String(filters.type || '').toUpperCase();
    const types: EquipmentType[] =
      type === 'PART' ? ['PART'] : type === 'TRUCK' ? ['TRUCK'] : type === 'TRAILER' ? ['TRAILER'] : ['TRUCK', 'TRAILER'];

    const and: WhereOptions[] = [
      { equipmentType: types },
      {
        [Op.or]: [
          { listingId: null, status: ItemStatus.ACTIVE },
          { '$listing.status$': ListingStatus.ACTIVE },
        ],
      },
    ];
    const search = String(filters.search || '').trim().slice(0, 100);
    if (search) {
      const like = { [Op.like]: `%${search.replace(/[%_\\]/g, '\\$&')}%` };
      and.push({
        [Op.or]: [
          { make: like },
          { model: like },
          { name: like },
          { partNumber: like },
          { partCategory: like },
          { fitment: like },
          { trailerType: like },
        ],
      });
    }
    const state = String(filters.state || '').trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(state)) {
      and.push({ [Op.or]: [{ state }, { state: null, '$listing.state$': state }] });
    }
    const min = Number(filters.minPrice);
    const max = Number(filters.maxPrice);
    if (isFinite(min) && min > 0) and.push({ price: { [Op.gte]: min } });
    if (isFinite(max) && max > 0) and.push({ price: { [Op.lte]: max } });

    const { rows, count } = await Truck.findAndCountAll({
      where: { [Op.and]: and },
      include: [{ model: Listing, as: 'listing', attributes: ['id', 'status', 'city', 'state'], required: false }],
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
      subQuery: false,
      distinct: true,
    });
    const photos = await firstPhotos(rows.map((r) => r.id));
    return {
      items: rows.map((r) => toCard(r, photos.get(r.id))),
      pagination: { page, limit, total: count, totalPages: Math.ceil(count / limit) },
    };
  },

  /** Seller lists a standalone truck, trailer or part. Admins publish directly. */
  async create(user: { id: string; role: string }, data: TruckInput) {
    const fields = normalizeTruckInput({ equipmentType: 'TRUCK', ...data });
    const isPart = fields.equipmentType === 'PART';
    if (isPart && !fields.name) throw new BadRequestError('Part name is required');
    if (!isPart && !fields.make) throw new BadRequestError('Make is required');
    if (!fields.state) throw new BadRequestError('State is required');
    if (fields.price == null) throw new BadRequestError('Price is required');

    const isAdmin = user.role === 'ADMIN';
    return Truck.create({
      ...fields,
      make: fields.make || '',
      model: fields.model || '',
      listingId: null,
      sellerId: user.id,
      status: isAdmin ? ItemStatus.ACTIVE : ItemStatus.PENDING_REVIEW,
      displayOrder: 0,
    });
  },

  /** A seller's own standalone items, every status. */
  async mine(userId: string) {
    const rows = await Truck.findAll({
      where: { sellerId: userId, listingId: null },
      order: [['createdAt', 'DESC']],
    });
    const photos = await firstPhotos(rows.map((r) => r.id));
    return rows.map((r) => ({ ...toCard(r, photos.get(r.id)), reviewNote: r.reviewNote ?? null }));
  },

  /**
   * Owner status changes on a standalone item: mark SOLD, relist a SOLD item,
   * or resubmit a REJECTED one for review. Approval itself is admin-only.
   */
  async setStatus(itemId: string, user: { id: string; role: string }, next: string) {
    const item = await Truck.findByPk(itemId);
    if (!item || item.listingId) throw new NotFoundError('Item');
    const isAdmin = user.role === 'ADMIN';
    if (!isAdmin && item.sellerId !== user.id) throw new ForbiddenError('You do not own this item');

    const allowed: Record<string, string[]> = {
      [ItemStatus.ACTIVE]: [ItemStatus.SOLD],
      [ItemStatus.SOLD]: [ItemStatus.ACTIVE],
      [ItemStatus.REJECTED]: [ItemStatus.PENDING_REVIEW],
    };
    if (!isAdmin && !(allowed[item.status] || []).includes(next)) {
      throw new BadRequestError(`Can't change this item from ${item.status} to ${next}`);
    }
    await item.update({ status: next, ...(next === ItemStatus.PENDING_REVIEW && { reviewNote: null }) });
    return item;
  },

  /** Admin review queue (standalone items). */
  async adminList(status: string = ItemStatus.PENDING_REVIEW) {
    const rows = await Truck.findAll({
      where: { listingId: null, ...(status !== 'ALL' && { status }) },
      include: [{ model: User, as: 'seller', attributes: ['id', 'name', 'email'] }],
      order: [['createdAt', status === ItemStatus.PENDING_REVIEW ? 'ASC' : 'DESC']],
      limit: 200,
    });
    const photos = await firstPhotos(rows.map((r) => r.id));
    return rows.map((r) => ({
      ...toCard(r, photos.get(r.id)),
      description: r.description ?? null,
      vin: r.vin ?? null,
      fitment: r.fitment ?? null,
      reviewNote: r.reviewNote ?? null,
      seller: r.seller ? { id: r.seller.id, name: r.seller.name, email: r.seller.email } : null,
    }));
  },

  async approve(itemId: string) {
    const item = await Truck.findByPk(itemId);
    if (!item || item.listingId) throw new NotFoundError('Item');
    await item.update({ status: ItemStatus.ACTIVE, reviewNote: null });
    await notifySeller(item.sellerId, 'Listing Approved', `${itemLabel(item)} is now live in the marketplace.`, item.id);
    return item;
  },

  async reject(itemId: string, reason: string) {
    const item = await Truck.findByPk(itemId);
    if (!item || item.listingId) throw new NotFoundError('Item');
    const note = String(reason || '').trim().slice(0, 500) || null;
    await item.update({ status: ItemStatus.REJECTED, reviewNote: note });
    await notifySeller(
      item.sellerId,
      'Listing Not Approved',
      `${itemLabel(item)} was not approved${note ? `: ${note}` : '.'}`,
      item.id
    );
    return item;
  },

  async pendingCount() {
    return Truck.count({ where: { listingId: null, status: ItemStatus.PENDING_REVIEW } });
  },
};
