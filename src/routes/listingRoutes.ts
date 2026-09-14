import { Router } from 'express';
import {
  getListings,
  getListing,
  createListing,
  updateListing,
  submitForReview,
  deleteListing,
  saveListing,
  unsaveListing,
  getSavedListings,
  getMyListings,
  unlockListing,
  getUnlockedListings,
  createListingValidation,
} from '../controllers/listingController';
import { authenticate, optionalAuth, sellerOnly, buyerOnly, requireEnterpriseSubscription, requireActiveBilling } from '../middleware/auth';
import validate from '../middleware/validate';

const router = Router();

// Public routes (with optional auth for personalized data)
router.get('/', optionalAuth, getListings);
router.get('/search', optionalAuth, getListings); // Alias

// Protected routes - must come before :id routes
router.get('/vip', authenticate, requireEnterpriseSubscription, getListings);
router.get('/saved', authenticate, getSavedListings);
router.get('/my-listings', authenticate, sellerOnly, getMyListings);
router.get('/unlocked', authenticate, buyerOnly, getUnlockedListings);

// Single listing — optional auth: anonymous viewers get a masked public preview,
// authenticated users get personalized/unlocked data (handled in the controller).
router.get('/:id', optionalAuth, getListing);

// Seller routes
router.post('/', authenticate, sellerOnly, validate(createListingValidation), createListing);
router.put('/:id', authenticate, sellerOnly, updateListing);
router.post('/:id/submit', authenticate, sellerOnly, submitForReview);
router.delete('/:id', authenticate, sellerOnly, deleteListing);

// Save/unsave listing (any authenticated user)
router.post('/:id/save', authenticate, saveListing);
router.delete('/:id/save', authenticate, unsaveListing);

// Unlock listing (buyer uses credit) — blocked while billing is delinquent.
router.post('/:id/unlock', authenticate, buyerOnly, requireActiveBilling, unlockListing);

export default router;
