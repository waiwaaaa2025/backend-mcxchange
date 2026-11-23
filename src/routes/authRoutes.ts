import { Router } from 'express';
import {
  register,
  login,
  switchRole,
  refreshToken,
  logout,
  logoutAll,
  getCurrentUser,
  changePassword,
  requestPasswordReset,
  resetPassword,
  verifyEmail,
  resendVerificationEmail,
  registerValidation,
  loginValidation,
  switchRoleValidation,
} from '../controllers/authController';
import { authenticate } from '../middleware/auth';
import { getTermsSignatureStatus, signTerms } from '../controllers/termsSignatureController';
import validate from '../middleware/validate';
import { authLimiter, passwordResetLimiter } from '../middleware/rateLimiter';

const router = Router();

// Public routes (with rate limiting)
router.post('/register', authLimiter, validate(registerValidation), register);
router.post('/login', authLimiter, validate(loginValidation), login);
router.post('/refresh-token', authLimiter, refreshToken);
router.post('/logout', logout);
router.post('/forgot-password', passwordResetLimiter, requestPasswordReset);
router.post('/reset-password', passwordResetLimiter, resetPassword);
router.post('/verify-email', authLimiter, verifyEmail);

// Protected routes
router.get('/me', authenticate, getCurrentUser);
router.post('/logout-all', authenticate, logoutAll);
router.post('/change-password', authenticate, changePassword);
router.post('/resend-verification', authenticate, resendVerificationEmail);
router.post('/switch-role', authenticate, validate(switchRoleValidation), switchRole);

// Typed-signature Terms of Service agreement (asked once of every member)
router.get('/terms-signature', authenticate, getTermsSignatureStatus);
router.post('/terms-signature', authenticate, signTerms);

export default router;
