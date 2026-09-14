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
import { authenticate, sellerOnly, buyerOnly, adminOnly } from '../middleware/auth';
import validate from '../middleware/validate';

const router = Router();

// All offer routes require authentication
router.use(authenticate);

// Buyer routes
router.post('/', buyerOnly, validate(createOfferValidation), createOffer);
router.get('/my-offers', buyerOnly, getBuyerOffers);
router.post('/:id/accept-counter', buyerOnly, acceptCounterOffer);
router.post('/:id/withdraw', buyerOnly, withdrawOffer);
router.post('/:id/deposit-checkout', buyerOnly, createDepositCheckout);

// Seller routes
router.get('/received', sellerOnly, getSellerOffers);
router.post('/:id/accept', sellerOnly, acceptOffer);
router.post('/:id/reject', sellerOnly, rejectOffer);
router.post('/:id/counter', sellerOnly, validate(counterOfferValidation), counterOffer);

// Get single offer (buyer, seller, or admin)
router.get('/:id', getOffer);

// Admin routes
router.get('/listing/:listingId', adminOnly, getListingOffers);

export default router;
