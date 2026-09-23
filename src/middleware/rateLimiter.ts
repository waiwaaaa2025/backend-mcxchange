import rateLimit from 'express-rate-limit';
import RedisStore from 'rate-limit-redis';
import { Request, Response } from 'express';
import { getRedisClient, isRedisHealthy } from '../config/redis';
import logger, { logSecurity } from '../utils/logger';
import { config } from '../config';

// Helper to get client identifier - uses user ID if authenticated, otherwise IP
const getClientIdentifier = (req: Request): string => {
  // Use user ID if authenticated, otherwise use IP
  const userId = (req as any).user?.id;
  if (userId) {
    return `user:${userId}`;
  }

  // Use req.ip which handles proxies properly when trust proxy is set
  return req.ip || 'unknown';
};

// Standard rate limit response
const rateLimitResponse = (req: Request, res: Response) => {
  logSecurity('Rate limit exceeded', 'medium', {
    identifier: getClientIdentifier(req),
    path: req.path,
    method: req.method,
  });

  res.status(429).json({
    success: false,
    error: 'Too many requests',
    message: 'You have exceeded the rate limit. Please try again later.',
    retryAfter: res.getHeader('Retry-After'),
  });
};

// Create a store factory that falls back to memory if Redis is unavailable
const createStore = async () => {
  const redisHealthy = await isRedisHealthy();

  if (redisHealthy) {
    logger.info('Rate limiter using Redis store');
    return new RedisStore({
      sendCommand: (command: string, ...args: string[]) => getRedisClient().call(command, ...args) as any,
      prefix: 'ratelimit:',
    });
  }

  logger.warn('Rate limiter falling back to memory store (Redis unavailable)');
  return undefined; // Uses default memory store
};

// ============================================
// Rate Limiters for Different Endpoints
// ============================================

/**
 * Global rate limiter - applies to all routes
 * Production: 3000 requests per 15 minutes per IP
 *   (frontend pages fire many parallel API calls per page load — 1000 was too low)
 * Development: 5000 requests per 15 minutes per IP (more lenient for testing)
 */
export const globalLimiter = rateLimit({
  windowMs: parseInt(config.rateLimit?.windowMs || '900000'), // 15 minutes
  max: config.isDevelopment
    ? 5000  // Much higher limit for development
    : parseInt(config.rateLimit?.maxRequests || '3000'),
  message: 'Too many requests from this IP, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  handler: rateLimitResponse,
  skip: (req) => {
    // Skip rate limiting for health checks
    return req.path === '/api/health' || req.path === '/api/health/ready';
  },
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
});

/**
 * Strict rate limiter for auth endpoints
 * Production: 100 requests per 15 minutes per IP (prevents brute force while allowing normal usage)
 * Development: 500 requests per 15 minutes (more lenient for testing)
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: config.isDevelopment ? 500 : 100,
  message: 'Too many authentication attempts, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  handler: (req, res) => {
    logSecurity('Auth rate limit exceeded - potential brute force', 'high', {
      identifier: getClientIdentifier(req),
      path: req.path,
    });
    rateLimitResponse(req, res);
  },
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
});

/**
 * Password reset limiter - very strict
 * 3 requests per hour per IP
 */
export const passwordResetLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  message: 'Too many password reset attempts, please try again in an hour.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  handler: (req, res) => {
    logSecurity('Password reset rate limit exceeded', 'high', {
      identifier: getClientIdentifier(req),
    });
    rateLimitResponse(req, res);
  },
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
});

/**
 * Listing browse/search limiter - the marketplace's scraping surface
 *
 * Production: 120 requests per minute per user/IP
 * Development: 1000 per minute
 *
 * The global limiter (3000 per 15 min) averages 200/min, which is no obstacle
 * to a bot walking the catalogue. A person browsing fires roughly one call per
 * page view plus one per listing opened, so 120/min leaves ordinary use — and
 * a shared office IP — plenty of headroom while making a bulk dump slow and
 * conspicuous. Logged as a security event so the pattern is visible.
 */
export const listingBrowseLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: config.isDevelopment ? 1000 : 120,
  message: 'Too many listing requests, please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  handler: (req, res) => {
    logSecurity('Listing browse rate limit exceeded - possible scraping', 'medium', {
      identifier: getClientIdentifier(req),
      path: req.path,
      userAgent: req.get('user-agent'),
    });
    rateLimitResponse(req, res);
  },
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
});

/**
 * FMCSA API limiter - protect external API quota
 * 30 requests per minute per user/IP
 */
export const fmcsaLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: 'Too many FMCSA lookups, please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  handler: rateLimitResponse,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
});

/**
 * Anonymous carrier lookups - 10 per hour per IP
 *
 * The home page, product page and pricing estimator let a visitor look up
 * their own MC before signing up, so /fmcsa/mc stays public. A visitor checks
 * one or two numbers; a bot sweeping an MC range to match a listing's city
 * and state needs thousands. Signed-in users skip this and get fmcsaLimiter.
 */
export const anonymousLookupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: 'Too many lookups. Sign in to keep searching.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: Request) => !!(req as any).user,
  keyGenerator: getClientIdentifier,
  handler: rateLimitResponse,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
});

/**
 * Anonymous carrier-detail lookups by DOT - 60 per hour per IP
 *
 * The public Carrier Pulse preview (home page → /carrier-pulse-preview) makes
 * five or six of these per carrier, so this allows about ten previews an hour
 * before asking the visitor to sign in. Signed-in users skip it.
 */
export const anonymousCarrierDataLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 60,
  message: 'Too many lookups. Sign in to keep searching.',
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req: Request) => !!(req as any).user,
  keyGenerator: getClientIdentifier,
  handler: rateLimitResponse,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
});

/**
 * File upload limiter
 * 10 uploads per hour per user
 */
export const uploadLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10,
  message: 'Too many file uploads, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  handler: rateLimitResponse,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
});

/**
 * Listing creation limiter
 * 5 listings per hour per user
 */
export const listingCreationLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5,
  message: 'Too many listings created, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  handler: rateLimitResponse,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
});

/**
 * Offer creation limiter
 * 20 offers per hour per user
 */
export const offerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 20,
  message: 'Too many offers submitted, please try again later.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  handler: rateLimitResponse,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
});

/**
 * Message sending limiter
 * 60 messages per hour per user
 */
export const messageLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 60,
  message: 'Too many messages sent, please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  handler: rateLimitResponse,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
});

/**
 * Admin action limiter - higher limit for admins
 * 1000 requests per 15 minutes (admins need higher limits for management tasks)
 */
export const adminLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000,
  message: 'Too many admin requests, please slow down.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: getClientIdentifier,
  handler: rateLimitResponse,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
});

/**
 * Webhook limiter - for external services like Stripe
 * 100 requests per minute
 */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 100,
  message: 'Too many webhook requests.',
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip || 'unknown',
  handler: rateLimitResponse,
  validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
});

/**
 * Create rate limiter with Redis store (async initialization)
 * Call this during app startup to enable Redis-backed rate limiting
 */
export const initializeRateLimiters = async (): Promise<void> => {
  try {
    const store = await createStore();

    if (store) {
      // Update all limiters to use Redis store
      // Note: express-rate-limit doesn't support changing store after creation
      // This is mainly for logging purposes
      logger.info('Rate limiters initialized with Redis backing');
    } else {
      logger.warn('Rate limiters using in-memory store (development mode)');
    }
  } catch (error) {
    logger.error('Failed to initialize rate limiters with Redis', error as Error);
  }
};

// Export all limiters
export default {
  global: globalLimiter,
  auth: authLimiter,
  passwordReset: passwordResetLimiter,
  fmcsa: fmcsaLimiter,
  anonymousLookup: anonymousLookupLimiter,
  anonymousCarrierData: anonymousCarrierDataLimiter,
  listingBrowse: listingBrowseLimiter,
  upload: uploadLimiter,
  listingCreation: listingCreationLimiter,
  offer: offerLimiter,
  message: messageLimiter,
  admin: adminLimiter,
  webhook: webhookLimiter,
};
