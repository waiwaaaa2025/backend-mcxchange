import { Router } from 'express';
import {
  getProfile,
  updateProfile,
  getPublicProfile,
  getUserReviews,
  getUserListings,
  uploadAvatar,
  deactivateAccount,
  getDashboardStats,
  updateProfileValidation,
} from '../controllers/userController';
import { authenticate, optionalAuth } from '../middleware/auth';
import validate from '../middleware/validate';
import { avatarUpload } from '../middleware/upload';
import { listingBrowseLimiter } from '../middleware/rateLimiter';
import { blockFlaggedIps } from '../middleware/ipBlock';

const router = Router();

// Protected routes (current user)
router.get('/me', authenticate, getProfile);
router.put('/me', authenticate, validate(updateProfileValidation), updateProfile);
router.post('/me/avatar', authenticate, avatarUpload, uploadAvatar);
router.delete('/me', authenticate, deactivateAccount);

// Dashboard stats
router.get('/dashboard', authenticate, getDashboardStats);

// Public routes (any user)
router.get('/:id', optionalAuth, getPublicProfile);
router.get('/:id/reviews', getUserReviews);
router.get('/:id/listings', optionalAuth, blockFlaggedIps, listingBrowseLimiter, getUserListings);

export default router;
