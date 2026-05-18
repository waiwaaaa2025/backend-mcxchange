import { Router } from 'express';
import {
  getDashboardStats,
  getPendingListings,
  approveListing,
  rejectListing,
  getListingById,
  updateListing,
  getUsers,
  getUserDetails,
  blockUser,
  unblockUser,
  verifySeller,
  getPremiumRequests,
  updatePremiumRequest,
  getBrokerOutreachRequests,
  updateBrokerOutreachRequest,
  getAllListings,
  getAllTransactions,
  getActionLog,
  getSettings,
  updateSettings,
  getRevenueAnalytics,
  getUserAnalytics,
  getListingAnalytics,
  broadcastMessage,
  rejectListingValidation,
  blockUserValidation,
  getAllOffers,
  adminApproveOffer,
  adminForwardOffer,
  adminRejectOffer,
  adminAcceptOfferOnBehalf,
  adminRejectOfferOnBehalf,
  adminDeleteOffer,
  createUser,
  createUserValidation,
  createListing,
  createListingValidation,
  createUserWithListing,
  updateUser,
  updateUserValidation,
  updateUserRole,
  updateUserRoleValidation,
  getPricingConfig,
  updatePricingConfig,
  getStripeTransactions,
  getStripeBalance,
  getStripeBalanceTransactions,
  adjustUserCredits,
  adjustCreditsValidation,
  recordManualDeposit,
  recordManualDepositValidation,
  getUserListingsForDeposit,
  cancelUserSubscription,
  resetUserPassword,
  resetUserPasswordValidation,
  deleteUser,
  getSubscriptionAnalytics,
  getAdminUserPreferences,
  updateAdminUserPreferences,
  getAdminUserMatches,
  blockUserForMismatch,
  blockUserMismatchValidation,
  getAllDisputes,
  resolveDispute,
  rejectDispute,
  processAutoUnblock,
  getNotificationSettings,
  updateNotificationSettings,
  getUserActivityLog,
  getActivityLog,
  createAndSendInvoice,
  createInvoiceValidation,
  getAdminInvoices,
  getAdminInvoice,
  sendAdminInvoice,
  voidAdminInvoice,
  releasePayoutToSeller,
  checkSellerInstantPayoutEligibility,
} from '../controllers/adminController';
import { authenticate, adminOnly } from '../middleware/auth';
import validate from '../middleware/validate';

const router = Router();

// All admin routes require authentication and admin role
router.use(authenticate);
router.use(adminOnly);

// Dashboard
router.get('/dashboard', getDashboardStats);

// Listings
router.get('/listings', getAllListings);
router.post('/listings', validate(createListingValidation), createListing);
router.get('/listings/pending', getPendingListings);
router.get('/listings/:id', getListingById);
router.put('/listings/:id', updateListing);
router.post('/listings/:id/approve', approveListing);
router.post('/listings/:id/reject', validate(rejectListingValidation), rejectListing);

// Users
router.get('/users', getUsers);
router.post('/users', validate(createUserValidation), createUser);
router.post('/users/with-listing', createUserWithListing);
router.get('/users/:id', getUserDetails);
router.put('/users/:id', validate(updateUserValidation), updateUser);
router.get('/users/:id/activity-log', getUserActivityLog);
router.put('/users/:id/role', validate(updateUserRoleValidation), updateUserRole);
router.post('/users/:id/block', validate(blockUserValidation), blockUser);
router.post('/users/:id/unblock', unblockUser);
router.post('/users/:id/verify-seller', verifySeller);
router.post('/users/:id/credits', validate(adjustCreditsValidation), adjustUserCredits);
router.get('/users/:id/listings-for-deposit', getUserListingsForDeposit);
router.post('/users/:id/manual-deposit', validate(recordManualDepositValidation), recordManualDeposit);
router.post('/users/:id/cancel-subscription', cancelUserSubscription);
router.post('/users/:id/reset-password', validate(resetUserPasswordValidation), resetUserPassword);
router.delete('/users/:id', deleteUser);

// Buyer preferences (admin view/edit) + match suggestions
router.get('/users/:id/preferences', getAdminUserPreferences);
router.put('/users/:id/preferences', updateAdminUserPreferences);
router.get('/users/:id/matches', getAdminUserMatches);

// Subscription analytics (live from Stripe)
router.get('/analytics/subscriptions', getSubscriptionAnalytics);

// Premium requests
router.get('/premium-requests', getPremiumRequests);
router.put('/premium-requests/:id', updatePremiumRequest);

// Broker outreach (Pending Insurance Leads)
router.get('/broker-outreach', getBrokerOutreachRequests);
router.put('/broker-outreach/:id', updateBrokerOutreachRequest);

// Transactions
router.get('/transactions', getAllTransactions);
router.post('/transactions/:id/release-payout', releasePayoutToSeller);
router.get('/transactions/:id/instant-payout-eligibility', checkSellerInstantPayoutEligibility);

// Offers
router.get('/offers', getAllOffers);
router.post('/offers/:id/approve', adminApproveOffer);
router.post('/offers/:id/forward', adminForwardOffer);
router.post('/offers/:id/reject', adminRejectOffer);
router.post('/offers/:id/accept-on-behalf', adminAcceptOfferOnBehalf);
router.post('/offers/:id/reject-on-behalf', adminRejectOfferOnBehalf);
router.delete('/offers/:id', adminDeleteOffer);

// Action log
router.get('/action-log', getActionLog);
router.get('/activity-log', getActivityLog);

// Settings
router.get('/settings', getSettings);
router.put('/settings', updateSettings);

// Analytics
router.get('/analytics/revenue', getRevenueAnalytics);
router.get('/analytics/users', getUserAnalytics);
router.get('/analytics/listings', getListingAnalytics);

// Broadcast
router.post('/broadcast', broadcastMessage);

// Pricing Configuration
router.get('/pricing', getPricingConfig);
router.put('/pricing', updatePricingConfig);

// Stripe Transactions (payment history from Stripe)
router.get('/stripe/transactions', getStripeTransactions);
router.get('/stripe/balance', getStripeBalance);
router.get('/stripe/balance-transactions', getStripeBalanceTransactions);

// Account Disputes
router.get('/disputes', getAllDisputes);
router.post('/disputes/block-mismatch', validate(blockUserMismatchValidation), blockUserForMismatch);
router.post('/disputes/:id/resolve', resolveDispute);
router.post('/disputes/:id/reject', rejectDispute);
router.post('/disputes/process-auto-unblock', processAutoUnblock);

// Notification Settings
router.get('/settings/notifications', getNotificationSettings);
router.put('/settings/notifications', updateNotificationSettings);

// Invoices (Stripe)
router.get('/invoices', getAdminInvoices);
router.post('/invoices', validate(createInvoiceValidation), createAndSendInvoice);
router.get('/invoices/:id', getAdminInvoice);
router.post('/invoices/:id/send', sendAdminInvoice);
router.post('/invoices/:id/void', voidAdminInvoice);

export default router;
