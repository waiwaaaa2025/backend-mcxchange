import { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { body } from 'express-validator';
import { authService } from '../services/authService';
import { asyncHandler } from '../middleware/errorHandler';
import { AuthRequest, JWTPayload } from '../types';
import { UserRole } from '../models';
import { recordAccess, recordSession, clientIp } from '../utils/accessLog';

// Validation rules
export const registerValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password')
    .isLength({ min: 8 })
    .withMessage('Password must be at least 8 characters'),
  body('name').trim().notEmpty().withMessage('Name is required'),
  body('role')
    .isIn(['BUYER', 'SELLER', 'ADMIN', 'COMPLIANCE_MANAGER'])
    .withMessage('Role must be BUYER, SELLER, ADMIN, or COMPLIANCE_MANAGER'),
  body('phone').optional().isMobilePhone('any').withMessage('Invalid phone number'),
  body('termsAccepted').optional().isBoolean().withMessage('termsAccepted must be a boolean'),
];

export const loginValidation = [
  body('email').isEmail().normalizeEmail().withMessage('Valid email is required'),
  body('password').notEmpty().withMessage('Password is required'),
  body('roleHint')
    .optional()
    .isIn(['buyer', 'seller', 'compliance_manager'])
    .withMessage('roleHint must be buyer, seller, or compliance_manager'),
];

export const switchRoleValidation = [
  body('role')
    .isIn(['buyer', 'compliance_manager'])
    .withMessage('role must be buyer or compliance_manager'),
];

// Register new user
export const register = asyncHandler(async (req: Request, res: Response) => {
  const { email, password, name, role, phone, companyName, termsAccepted } = req.body;

  const result = await authService.register({
    email,
    password,
    name,
    role: role as UserRole,
    phone,
    companyName,
    termsAccepted: termsAccepted === true || termsAccepted === 'true',
    ipAddress: clientIp(req),
    userAgent: req.headers['user-agent'],
  });

  // Signup IP, recorded whether or not the Terms checkbox was sent.
  recordAccess(result.user.id, 'SIGNUP', req);

  res.status(201).json({
    success: true,
    data: result,
    message: 'Registration successful',
  });
});

// Login
export const login = asyncHandler(async (req: Request, res: Response) => {
  const { email, password, roleHint } = req.body;

  const result = await authService.login({ email, password, roleHint });

  // Access log: record the authenticated login with IP for dispute evidence.
  recordAccess(result.user.id, 'LOGIN', req);

  res.json({
    success: true,
    data: result,
    message: 'Login successful',
  });
});

// Switch active role for the current session. Mints a new token pair with the
// requested role claim if the user actually has access to it.
export const switchRole = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { role } = req.body;
  const result = await authService.switchRole(req.user.id, role);

  res.json({
    success: true,
    data: result,
    message: 'Role switched',
  });
});

// Refresh token
export const refreshToken = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = req.body;

  if (!refreshToken) {
    res.status(400).json({
      success: false,
      error: 'Refresh token is required',
    });
    return;
  }

  const tokens = await authService.refreshToken(refreshToken);

  // Verified by refreshToken above; decode only to learn whose session this is.
  const sessionUserId = (jwt.decode(refreshToken) as JWTPayload | null)?.id;
  if (sessionUserId) recordSession(sessionUserId, req);

  res.json({
    success: true,
    data: tokens,
  });
});

// Logout
export const logout = asyncHandler(async (req: Request, res: Response) => {
  const { refreshToken } = req.body;

  if (refreshToken) {
    await authService.logout(refreshToken);
  }

  res.json({
    success: true,
    message: 'Logged out successfully',
  });
});

// Logout from all devices
export const logoutAll = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  await authService.logoutAll(req.user.id);

  res.json({
    success: true,
    message: 'Logged out from all devices',
  });
});

// Get current user
export const getCurrentUser = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const user = await authService.getUserById(req.user.id);

  res.json({
    success: true,
    data: user,
  });
});

// Change password
export const changePassword = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    res.status(400).json({
      success: false,
      error: 'Current password and new password are required',
    });
    return;
  }

  if (newPassword.length < 8) {
    res.status(400).json({
      success: false,
      error: 'New password must be at least 8 characters',
    });
    return;
  }

  await authService.changePassword(req.user.id, currentPassword, newPassword);

  res.json({
    success: true,
    message: 'Password changed successfully',
  });
});

// Request password reset
export const requestPasswordReset = asyncHandler(async (req: Request, res: Response) => {
  const { email } = req.body;

  if (!email) {
    res.status(400).json({
      success: false,
      error: 'Email is required',
    });
    return;
  }

  await authService.requestPasswordReset(email);

  res.json({
    success: true,
    message: 'If an account exists with this email, a reset link will be sent',
  });
});

// Reset password with token
export const resetPassword = asyncHandler(async (req: Request, res: Response) => {
  const { token, newPassword } = req.body;

  if (!token || !newPassword) {
    res.status(400).json({
      success: false,
      error: 'Token and new password are required',
    });
    return;
  }

  if (newPassword.length < 8) {
    res.status(400).json({
      success: false,
      error: 'New password must be at least 8 characters',
    });
    return;
  }

  const result = await authService.resetPassword(token, newPassword);

  res.json({
    success: true,
    message: result.message,
  });
});

// Verify email
export const verifyEmail = asyncHandler(async (req: Request, res: Response) => {
  const { token } = req.body;

  if (!token) {
    res.status(400).json({
      success: false,
      error: 'Verification token is required',
    });
    return;
  }

  const result = await authService.verifyEmail(token);

  res.json({
    success: true,
    message: result.message,
  });
});

// Resend verification email
export const resendVerificationEmail = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const result = await authService.resendVerificationEmail(req.user.id);

  res.json({
    success: true,
    message: result.message,
  });
});
