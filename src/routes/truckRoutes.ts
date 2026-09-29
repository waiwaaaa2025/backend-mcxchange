import { Router } from 'express';
import {
  listTrucks,
  getEquipment,
  browseEquipment,
  createMarketItem,
  myMarketItems,
  setMarketItemStatus,
  adminListMarketItems,
  adminApproveMarketItem,
  adminRejectMarketItem,
  startEquipmentCheckout,
  askEquipmentQuestion,
  myEquipmentOrders,
  payoutStatus,
  payoutSetup,
  payoutDashboard,
  createTruck,
  updateTruck,
  deleteTruck,
  uploadTruckPhotos as uploadTruckPhotosHandler,
  deleteTruckPhoto,
} from '../controllers/truckController';
import { authenticate, optionalAuth, adminOnly } from '../middleware/auth';
import { uploadTruckPhotos, getPresignedUrl } from '../middleware/upload';

const router = Router();

// Public: anyone can view trucks attached to a listing (respects listing visibility elsewhere)
router.get('/listings/:listingId/trucks', optionalAuth, listTrucks);

// Equipment & parts marketplace — any signed-in account may list (authorities
// stay seller-only). Static paths before `/equipment/:truckId`.
router.get('/equipment', optionalAuth, browseEquipment);
router.get('/equipment/mine', authenticate, myMarketItems);
router.get('/equipment/orders', authenticate, myEquipmentOrders);
router.post('/equipment/:truckId/checkout', authenticate, startEquipmentCheckout);
router.post('/equipment/:truckId/question', authenticate, askEquipmentQuestion);

// Stripe Connect payout setup for any account that sells equipment/parts
// (sellers also have /seller/connect/*; this path isn't role-gated).
router.get('/payouts/status', authenticate, payoutStatus);
router.post('/payouts/setup', authenticate, payoutSetup);
router.get('/payouts/dashboard', authenticate, payoutDashboard);
router.post('/equipment', authenticate, createMarketItem);
router.put('/equipment/:truckId/status', authenticate, setMarketItemStatus);
router.get('/admin/equipment', authenticate, adminOnly, adminListMarketItems);
router.post('/admin/equipment/:truckId/approve', authenticate, adminOnly, adminApproveMarketItem);
router.post('/admin/equipment/:truckId/reject', authenticate, adminOnly, adminRejectMarketItem);

// Public: equipment photos live in a private S3 bucket — bounce to a
// short-lived signed URL (see TruckPhoto.url getter).
router.get('/truck-photos/:key', async (req, res) => {
  const key = req.params.key;
  if (!/^[\w-]+\.[A-Za-z0-9]+$/.test(key)) {
    res.status(400).end();
    return;
  }
  const signed = await getPresignedUrl(`trucks/${key}`, 3600).catch(() => null);
  if (!signed) {
    res.status(404).end();
    return;
  }
  res.set('Cache-Control', 'public, max-age=1800');
  res.redirect(302, signed);
});

// Public: a single piece of equipment, trailer or part — its own listing page
router.get('/equipment/:truckId', optionalAuth, getEquipment);

// Seller (own listings) or admin: manage equipment
router.post('/listings/:listingId/trucks', authenticate, createTruck);
router.put('/trucks/:truckId', authenticate, updateTruck);
router.delete('/trucks/:truckId', authenticate, deleteTruck);

// Seller-only: photo upload / delete
router.post(
  '/trucks/:truckId/photos',
  authenticate,
  uploadTruckPhotos,
  uploadTruckPhotosHandler
);
router.delete('/trucks/:truckId/photos/:photoId', authenticate, deleteTruckPhoto);

export default router;
