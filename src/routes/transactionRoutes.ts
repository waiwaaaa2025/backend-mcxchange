import { Router } from 'express';
import {
  getTransaction,
  getMyTransactions,
  buyerAcceptTerms,
  sellerAcceptTerms,
  payDeposit,
  verifyDeposit,
  buyerApprove,
  sellerApprove,
  adminApprove,
  payFinal,
  verifyFinalPayment,
  cancelTransaction,
  openDispute,
  sendMessage,
  updateStatus,
  paymentValidation,
  messageValidation,
  createDepositCheckout,
  createFinalPaymentCheckout,
  verifyDepositStatus,
  adminCreateTransaction,
  adminCreateTransactionValidation,
  getAvailableBuyers,
  getAvailableListings,
  adminDeleteTransaction,
  adminSendTransactionEmails,
  adminConfirmEscrow,
  confirmEscrowValidation,
} from '../controllers/transactionController';
import { authenticate, adminOnly, requireIdentityVerification } from '../middleware/auth';
import validate from '../middleware/validate';

const router = Router();

// All transaction routes require authentication
router.use(authenticate);

// Admin create transaction routes (must be before /:id routes to avoid conflict)
router.get('/admin/available-buyers', adminOnly, getAvailableBuyers);
router.get('/admin/available-listings', adminOnly, getAvailableListings);
router.post('/admin/create', adminOnly, validate(adminCreateTransactionValidation), adminCreateTransaction);

// Get transactions
router.get('/', getMyTransactions);
router.get('/:id', getTransaction);

// Buyer actions — buying the business (after the seller accepted the offer)
// requires a verified identity. These, plus the offer deposit checkout, are the
// only places identity verification is enforced.
router.post('/:id/buyer/accept-terms', requireIdentityVerification, buyerAcceptTerms);
router.post('/:id/buyer/approve', requireIdentityVerification, buyerApprove);
router.post('/:id/deposit', requireIdentityVerification, validate(paymentValidation), payDeposit);
router.post('/:id/deposit-checkout', requireIdentityVerification, createDepositCheckout);
router.post('/:id/verify-deposit-status', verifyDepositStatus);
router.post('/:id/final-payment', requireIdentityVerification, validate(paymentValidation), payFinal);
router.post('/:id/final-payment-checkout', requireIdentityVerification, createFinalPaymentCheckout);

// Seller actions
router.post('/:id/seller/accept-terms', sellerAcceptTerms);
router.post('/:id/seller/approve', sellerApprove);

// Both parties
router.post('/:id/cancel', cancelTransaction);
router.post('/:id/dispute', openDispute);
router.post('/:id/messages', validate(messageValidation), sendMessage);

// Admin actions on existing transactions
router.post('/:id/admin/approve', adminOnly, adminApprove);
router.post('/:id/admin/verify-deposit/:paymentId', adminOnly, verifyDeposit);
router.post('/:id/admin/verify-payment/:paymentId', adminOnly, verifyFinalPayment);
router.put('/:id/admin/status', adminOnly, updateStatus);
router.post('/:id/admin/send-emails', adminOnly, adminSendTransactionEmails);
router.post('/:id/admin/confirm-escrow', adminOnly, validate(confirmEscrowValidation), adminConfirmEscrow);
router.delete('/:id/admin', adminOnly, adminDeleteTransaction);

export default router;
