import { Router } from 'express';
import {
  createOffer,
  getOffer,
  getBuyerOffers,
  getSellerOffers,
  acceptOffer,
  rejectOffer,
  counterOffer,
  acceptCounterOffer,
  withdrawOffer,
  getListingOffers,
  createDepositCheckout,
  createOfferValidation,
  counterOfferValidation,
} from '../controllers/offerController';
import { authenticate, sellerOnly, buyerOnly, adminOnly, requireIdentityVerification } from '../middleware/auth';
import validate from '../middleware/validate';

const router = Router();

// All offer routes require authentication
router.use(authenticate);

// Identity verification (Stripe Identity) is required for buyers to make or
// accept an offer and pay the deposit (they already verified to unlock the
// listing), and for sellers to accept or counter one.

// Buyer routes
router.post('/', buyerOnly, requireIdentityVerification, validate(createOfferValidation), createOffer);
router.get('/my-offers', buyerOnly, getBuyerOffers);
router.post('/:id/accept-counter', buyerOnly, requireIdentityVerification, acceptCounterOffer);
router.post('/:id/withdraw', buyerOnly, withdrawOffer);
router.post('/:id/deposit-checkout', buyerOnly, requireIdentityVerification, createDepositCheckout);

// Seller routes
router.get('/received', sellerOnly, getSellerOffers);
router.post('/:id/accept', sellerOnly, requireIdentityVerification, acceptOffer);
router.post('/:id/reject', sellerOnly, rejectOffer);
router.post('/:id/counter', sellerOnly, requireIdentityVerification, validate(counterOfferValidation), counterOffer);

// Get single offer (buyer, seller, or admin)
router.get('/:id', getOffer);

// Admin routes
router.get('/listing/:listingId', adminOnly, getListingOffers);

export default router;
