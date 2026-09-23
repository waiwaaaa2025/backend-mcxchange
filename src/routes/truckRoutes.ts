import { Router } from 'express';
import {
  listTrucks,
  createTruck,
  updateTruck,
  deleteTruck,
  uploadTruckPhotos as uploadTruckPhotosHandler,
  deleteTruckPhoto,
} from '../controllers/truckController';
import { authenticate, optionalAuth } from '../middleware/auth';
import { blockFlaggedIps } from '../middleware/ipBlock';
import { uploadTruckPhotos } from '../middleware/upload';

const router = Router();

// Public: anyone can view trucks attached to a listing (respects listing visibility elsewhere)
router.get('/listings/:listingId/trucks', optionalAuth, blockFlaggedIps, listTrucks);

// Seller-only: manage trucks on their own listings
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
