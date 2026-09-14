import { Response, NextFunction } from 'express';
import { Op } from 'sequelize';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { AuthRequest, JWTPayload } from '../types';
import { User, UserRole, Subscription, SubscriptionPlan } from '../models';
import { hasActiveBundlePromo } from '../utils/bundlePromo';
import { getLeadGeneratorAccess, LeadGeneratorTier } from '../services/entitlementService';

// Pick the role the current session should run as. Honors the JWT's role claim
// (which can differ from the primary role when a buyer toggled to compliance,
// or vice-versa) but falls back to the stored primary role if access was
// revoked since the token was issued.
function resolveSessionRole(
  claimedRole: UserRole | undefined,
  user: { role: UserRole; carrierPulseAccess?: boolean }
): UserRole {
  if (!claimedRole || claimedRole === user.role) return user.role;
  if (claimedRole === UserRole.COMPLIANCE_MANAGER && user.carrierPulseAccess) {
    return UserRole.COMPLIANCE_MANAGER;
  }
  return user.role;
}

// Verify JWT token
export const authenticate = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        error: 'Access denied. No token provided.',
      });
      return;
    }

    const token = authHeader.split(' ')[1];

    if (!token) {
      res.status(401).json({
        success: false,
        error: 'Access denied. Invalid token format.',
      });
      return;
    }

    const decoded = jwt.verify(token, config.jwt.secret) as JWTPayload;

    // Verify user still exists and is active
    const user = await User.findByPk(decoded.id, {
      attributes: ['id', 'email', 'role', 'name', 'status', 'stripeCustomerId', 'identityVerified', 'carrierPulseAccess'],
    });

    if (!user) {
      res.status(401).json({
        success: false,
        error: 'User not found.',
      });
      return;
    }

    if (user.status === 'BLOCKED' || user.status === 'SUSPENDED') {
      res.status(403).json({
        success: false,
        error: 'Account is suspended or blocked.',
      });
      return;
    }

    // Honor the role claim on the JWT (set at login/switch-role time) when the
    // user still has access to that role. Otherwise fall back to the stored
    // primary role — handles e.g. compliance subscription cancellation.
    const sessionRole = resolveSessionRole(decoded.role, user);

    req.user = {
      id: user.id,
      email: user.email,
      role: sessionRole,
      name: user.name,
      stripeCustomerId: user.stripeCustomerId,
      identityVerified: user.identityVerified,
      promoAccessType: user.promoAccessType,
      promoAccessExpiresAt: user.promoAccessExpiresAt,
    };

    next();
  } catch (error) {
    if (error instanceof jwt.JsonWebTokenError) {
      res.status(401).json({
        success: false,
        error: 'Invalid token.',
      });
      return;
    }
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({
        success: false,
        error: 'Token expired.',
      });
      return;
    }
    console.error('Authentication middleware error:', (error as Error)?.message, (error as Error)?.stack);
    res.status(500).json({
      success: false,
      error: 'Authentication error.',
    });
  }
};

// Role-based authorization
export const authorize = (...allowedRoles: UserRole[]) => {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Not authenticated.',
      });
      return;
    }

    if (!allowedRoles.includes(req.user.role)) {
      res.status(403).json({
        success: false,
        error: 'Access denied. Insufficient permissions.',
      });
      return;
    }

    next();
  };
};

// Optional authentication (doesn't fail if no token)
export const optionalAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      next();
      return;
    }

    const token = authHeader.split(' ')[1];
    if (!token) {
      next();
      return;
    }

    const decoded = jwt.verify(token, config.jwt.secret) as JWTPayload;

    const user = await User.findByPk(decoded.id, {
      attributes: ['id', 'email', 'role', 'name', 'status', 'carrierPulseAccess'],
    });

    if (user && user.status === 'ACTIVE') {
      req.user = {
        id: user.id,
        email: user.email,
        role: resolveSessionRole(decoded.role, user),
        name: user.name,
      };
    }

    next();
  } catch {
    // Silently continue without auth for optional routes
    next();
  }
};

// Seller only middleware
export const sellerOnly = authorize(UserRole.SELLER, UserRole.ADMIN);

// Buyer only middleware
export const buyerOnly = authorize(UserRole.BUYER, UserRole.ADMIN);

// Admin only middleware
export const adminOnly = authorize(UserRole.ADMIN);

// Compliance manager only middleware (admins also pass — they can support users)
export const complianceManagerOnly = authorize(UserRole.COMPLIANCE_MANAGER, UserRole.ADMIN);

// Require active subscription for buyers
export const requireSubscription = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Not authenticated.',
      });
      return;
    }

    // Admins bypass subscription check
    if (req.user.role === UserRole.ADMIN) {
      next();
      return;
    }

    // Check for active subscription
    const subscription = await Subscription.findOne({
      where: {
        userId: req.user.id,
        status: 'ACTIVE',
      },
    });

    if (!subscription) {
      res.status(403).json({
        success: false,
        error: 'Active subscription required.',
        code: 'SUBSCRIPTION_REQUIRED',
      });
      return;
    }

    // Check if subscription is expired
    if (subscription.endDate && new Date(subscription.endDate) < new Date()) {
      res.status(403).json({
        success: false,
        error: 'Your subscription has expired.',
        code: 'SUBSCRIPTION_EXPIRED',
      });
      return;
    }

    next();
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Error checking subscription status.',
    });
  }
};

// Block value-delivering actions when the user's subscription has fallen behind on
// payment (PAST_DUE) or lapsed (EXPIRED). Stripe flips the subscription to past_due
// the moment a renewal charge fails, and our webhooks mirror that onto the DB row.
// The account can still log in and reach billing to fix their card — access is
// restored automatically once Stripe reports a successful payment (invoice.paid or
// subscription back to active). Prepaid credit buyers with no subscription row are
// unaffected, since their payment is already final.
export const requireActiveBilling = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Not authenticated.',
      });
      return;
    }

    // Admins bypass billing checks
    if (req.user.role === UserRole.ADMIN) {
      next();
      return;
    }

    const delinquent = await Subscription.findOne({
      where: {
        userId: req.user.id,
        status: { [Op.in]: ['PAST_DUE', 'EXPIRED'] },
      },
    });

    if (delinquent) {
      res.status(403).json({
        success: false,
        error: 'Your account is suspended due to a failed payment. Please update your payment method to restore access.',
        code: 'PAYMENT_SUSPENDED',
      });
      return;
    }

    next();
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Error checking billing status.',
    });
  }
};

// Require active Professional (or higher) subscription
export const requireProfessionalSubscription = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Not authenticated.',
      });
      return;
    }

    // Admins bypass subscription check
    if (req.user.role === UserRole.ADMIN) {
      next();
      return;
    }

    // Buyer's-Guide 60-day bundle grants Premium-equivalent access during its window
    if (hasActiveBundlePromo(req.user)) {
      next();
      return;
    }

    // Check for active Professional or Enterprise subscription
    const subscription = await Subscription.findOne({
      where: {
        userId: req.user.id,
        status: 'ACTIVE',
      },
    });

    if (!subscription) {
      res.status(403).json({
        success: false,
        error: 'Premium subscription required.',
        code: 'PREMIUM_REQUIRED',
      });
      return;
    }

    // Check if subscription is expired
    if (subscription.endDate && new Date(subscription.endDate) < new Date()) {
      res.status(403).json({
        success: false,
        error: 'Your subscription has expired.',
        code: 'SUBSCRIPTION_EXPIRED',
      });
      return;
    }

    // Only Premium, Enterprise, and VIP Access have access
    if (subscription.plan !== SubscriptionPlan.PREMIUM && subscription.plan !== SubscriptionPlan.ENTERPRISE && subscription.plan !== SubscriptionPlan.VIP_ACCESS) {
      res.status(403).json({
        success: false,
        error: 'Premium subscription required.',
        code: 'PREMIUM_REQUIRED',
      });
      return;
    }

    next();
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Error checking subscription status.',
    });
  }
};

// Require active Enterprise subscription
export const requireEnterpriseSubscription = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Not authenticated.',
      });
      return;
    }

    // Admins bypass subscription check
    if (req.user.role === UserRole.ADMIN) {
      next();
      return;
    }

    // Buyer's-Guide 60-day bundle grants Enterprise-equivalent access during its window
    if (hasActiveBundlePromo(req.user)) {
      next();
      return;
    }

    // Check for active Enterprise subscription
    const subscription = await Subscription.findOne({
      where: {
        userId: req.user.id,
        status: 'ACTIVE',
      },
    });

    if (!subscription) {
      res.status(403).json({
        success: false,
        error: 'Enterprise subscription required.',
        code: 'ENTERPRISE_REQUIRED',
      });
      return;
    }

    // Check if subscription is expired
    if (subscription.endDate && new Date(subscription.endDate) < new Date()) {
      res.status(403).json({
        success: false,
        error: 'Your subscription has expired.',
        code: 'SUBSCRIPTION_EXPIRED',
      });
      return;
    }

    // Only Premium, Enterprise (grandfathered), or VIP / Deal Access Pass has access
    if (
      subscription.plan !== SubscriptionPlan.PREMIUM &&
      subscription.plan !== SubscriptionPlan.ENTERPRISE &&
      subscription.plan !== SubscriptionPlan.VIP_ACCESS
    ) {
      res.status(403).json({
        success: false,
        error: 'Premium subscription required.',
        code: 'PREMIUM_REQUIRED',
      });
      return;
    }

    next();
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Error checking subscription status.',
    });
  }
};

// Require active Lead Generator access (BUYER, BROKER, VIP, or admin).
// Populates req.leadGenTier so handlers can gate broker-only features.
export const requireLeadGeneratorAccess = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Not authenticated.' });
      return;
    }

    const access = await getLeadGeneratorAccess(req.user.id, {
      isAdmin: req.user.role === UserRole.ADMIN,
    });

    if (!access.hasAccess || !access.tier) {
      res.status(403).json({
        success: false,
        error: 'Lead Generator subscription required.',
        code: 'LEAD_GENERATOR_REQUIRED',
      });
      return;
    }

    req.leadGenTier = access.tier as Exclude<LeadGeneratorTier, null>;
    next();
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Error checking Lead Generator access.',
    });
  }
};

// Same as requireLeadGeneratorAccess but additionally requires BROKER tier
// (or ADMIN). Used for advanced filters and bulk CSV export.
export const requireLeadGeneratorBroker = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Not authenticated.' });
      return;
    }

    const access = await getLeadGeneratorAccess(req.user.id, {
      isAdmin: req.user.role === UserRole.ADMIN,
    });

    if (!access.hasAccess || (access.tier !== 'BROKER' && access.tier !== 'ADMIN')) {
      res.status(403).json({
        success: false,
        error: 'Lead Generator Broker tier required.',
        code: 'LEAD_GENERATOR_BROKER_REQUIRED',
      });
      return;
    }

    req.leadGenTier = access.tier as Exclude<LeadGeneratorTier, null>;
    next();
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Error checking Lead Generator Broker access.',
    });
  }
};

// Require a verified identity (Stripe Identity). Only used on the buyer's purchase
// steps after a seller accepts their offer — deposit, terms, approval and final
// payment (offerRoutes, transactionRoutes). Browsing, unlocking, offers, messages,
// subscriptions and tools never require it.
export const requireIdentityVerification = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: 'Not authenticated.',
      });
      return;
    }

    // Admins bypass identity verification
    if (req.user.role === UserRole.ADMIN) {
      next();
      return;
    }

    if (!req.user.identityVerified) {
      res.status(403).json({
        success: false,
        error: 'Verify your identity to continue with this purchase.',
        code: 'IDENTITY_VERIFICATION_REQUIRED',
      });
      return;
    }

    next();
  } catch (error) {
    res.status(500).json({
      success: false,
      error: 'Error checking identity verification status.',
    });
  }
};

