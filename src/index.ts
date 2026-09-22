import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import compression from 'compression';
import helmet from 'helmet';
import path from 'path';
import http from 'http';
import { config, validateConfig } from './config';
import { connectDatabase, disconnectDatabase } from './config/database';
import { connectRedis, disconnectRedis, isRedisHealthy } from './config/redis';
import { initializeWebSocket } from './websocket';
import routes from './routes';
import webhookRoutes from './routes/webhookRoutes';
import {
  errorHandler,
  notFoundHandler,
  setupGlobalErrorHandlers
} from './middleware/errorHandler';
import { conditionalRequestLogger, errorLogger } from './middleware/requestLogger';
import { globalLimiter, initializeRateLimiters } from './middleware/rateLimiter';
import logger from './utils/logger';
import { authService } from './services/authService';
import { expireOverdueBundleAccess } from './services/buyerGuideService';
import './agents'; // triggers AgentRegistry.register(...) side effects
import { purgeOldListingAccessLogs } from './utils/listingAccessLog';
import { scrapeWatchService } from './services/scrapeWatchService';
import { startAgentWorker } from './workers/agentJobs.worker';
import { seedAgentCatalog } from './services/agentRegistration.service';
import { registerScoutTasks } from './agents/scout/registerTasks';
import { installScoutHooks } from './agents/scout/hooks';
import { armScoutDigests } from './agents/scout/tasks/weeklyLeadDigest';
import { installDiaHooks } from './agents/dia/hooks';

// ============================================
// Setup Global Error Handlers
// ============================================
setupGlobalErrorHandlers();

// ============================================
// Validate Configuration
// ============================================
validateConfig();

// ============================================
// Create Express App
// ============================================
const app = express();

// ============================================
// Create HTTP Server (for WebSocket)
// ============================================
const httpServer = http.createServer(app);

// ============================================
// Trust Proxy (for correct IP detection behind reverse proxy)
// ============================================
if (config.isProduction) {
  app.set('trust proxy', 1);
}

// ============================================
// Security Middleware
// ============================================
app.use(
  helmet({
    contentSecurityPolicy: config.isProduction ? undefined : false, // Disable in dev for easier debugging
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// ============================================
// CORS Configuration
// ============================================
app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps or curl)
      if (!origin) return callback(null, true);

      if (config.cors.origins.includes(origin)) {
        callback(null, true);
      } else {
        logger.warn('CORS blocked request from origin', { origin });
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: config.cors.credentials,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-ID'],
    exposedHeaders: ['X-Request-ID', 'X-RateLimit-Limit', 'X-RateLimit-Remaining'],
    maxAge: 86400, // 24 hours
  })
);

// ============================================
// Response Compression (gzip/deflate)
// ============================================
app.use(compression());

// ============================================
// Request Logging
// ============================================
app.use(conditionalRequestLogger);

// ============================================
// Rate Limiting (Global)
// ============================================
app.use(globalLimiter);

// ============================================
// Stripe Webhook Route (MUST be before body parsing!)
// Stripe requires raw body for signature verification
// ============================================
app.use(
  '/api/webhooks',
  express.raw({ type: 'application/json' }),
  webhookRoutes
);

// ============================================
// Body Parsing
// ============================================
app.use(express.json({
  limit: '10mb',
  verify: (req: Request, _res: Response, buf: Buffer) => {
    // Store raw body for Stripe webhooks (already handled above, but keep for safety)
    (req as any).rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ============================================
// Static Files for Uploads
// ============================================
app.use('/uploads', express.static(path.join(__dirname, '../uploads'), {
  maxAge: config.isProduction ? '1d' : 0,
  etag: true,
}));

// ============================================
// API Routes
// ============================================
app.use('/api', routes);

// ============================================
// Error Logging Middleware
// ============================================
app.use(errorLogger);

// ============================================
// 404 Handler
// ============================================
app.use(notFoundHandler);

// ============================================
// Error Handler
// ============================================
app.use(errorHandler);

// ============================================
// Start Server
// ============================================
const startServer = async () => {
  try {
    logger.info('Starting Domilea API Server...');

    // Connect to database
    logger.info('Connecting to database...');
    await connectDatabase();
    logger.info('Database connected successfully');

    // Connect to Redis (optional, graceful degradation)
    logger.info('Connecting to Redis...');
    try {
      await connectRedis();
    } catch (error) {
      logger.warn('Redis connection failed - continuing without caching');
    }

    // Initialize rate limiters with Redis
    await initializeRateLimiters();

    // Initialize WebSocket server
    logger.info('Initializing WebSocket server...');
    initializeWebSocket(httpServer);

    // Seed the agent catalog (idempotent)
    try {
      await seedAgentCatalog();
    } catch (err) {
      logger.warn('Agent catalog seed failed (continuing)', { error: (err as Error).message });
    }

    // Register Scout's heavy tasks (kept out of the agent module to avoid circular imports)
    registerScoutTasks();

    // Install Scout reactive hooks (Lead.afterCreate → enrich_lead)
    installScoutHooks();

    // Install Dia reactive hooks (ComplianceDocument/DriverDocument.afterCreate → expiry alerts)
    installDiaHooks();

    // Arm the weekly digest for every active admin (idempotent — won't double-enqueue)
    try {
      const armed = await armScoutDigests();
      logger.info(`Scout digests armed: ${armed.armed} of ${armed.checked} admins`);
    } catch (err) {
      logger.warn('armScoutDigests failed (continuing)', { error: (err as Error).message });
    }

    // Start the agent worker if enabled
    startAgentWorker();

    // Schedule token cleanup (every hour)
    setInterval(async () => {
      try {
        await authService.cleanupExpiredTokens();
      } catch (error) {
        logger.error('Token cleanup failed', { error });
      }
    }, 60 * 60 * 1000); // 1 hour

    // Schedule expired buyer-bundle promo-access cleanup (every 6 hours)
    setInterval(async () => {
      try {
        const expired = await expireOverdueBundleAccess();
        if (expired.length > 0) {
          logger.info('Expired buyer-bundle promo access batch', { count: expired.length });
        }
      } catch (error) {
        logger.error('Bundle promo expiry sweep failed', { error });
      }
    }, 6 * 60 * 60 * 1000); // 6 hours

    // Purge catalogue access logs past retention (every 24 hours). These rows
    // arrive once per page view, so they outgrow everything else we store.
    setInterval(async () => {
      try {
        const removed = await purgeOldListingAccessLogs();
        if (removed > 0) {
          logger.info('Purged expired listing access logs', { count: removed });
        }
      } catch (error) {
        logger.error('Listing access log purge failed', { error });
      }
    }, 24 * 60 * 60 * 1000); // 24 hours

    // Daily scrape watch. Asks the question the admin panel answers on demand,
    // so a slow scrape nobody thinks to check for still surfaces. Silent unless
    // a client trips the heuristic. Ticks every three hours and lets the service
    // decide whether a day has passed — Heroku cycles dynos about daily, so a
    // 24h interval would rarely live long enough to fire.
    setInterval(async () => {
      try {
        const { flagged, scanned } = await scrapeWatchService.runDailyCheck();
        if (flagged > 0) {
          logger.warn('Scrape watch flagged clients', { flagged, scanned });
        }
      } catch (error) {
        logger.error('Daily scrape watch failed', { error });
      }
    }, 3 * 60 * 60 * 1000); // every 3h; the service itself enforces once-a-day

    // Start listening
    httpServer.listen(config.port, () => {
      const banner = `
╔═══════════════════════════════════════════════════════════════╗
║                                                               ║
║   🚚 Domilea API Server                                   ║
║                                                               ║
║   Environment: ${config.nodeEnv.padEnd(46)}║
║   Port: ${String(config.port).padEnd(54)}║
║   Frontend URL: ${config.frontendUrl.padEnd(44)}║
║                                                               ║
║   Features:                                                   ║
║   ✅ REST API                                                  ║
║   ✅ WebSocket (Socket.io)                                     ║
║   ${config.resend.apiKey ? '✅' : '⚠️ '} Email Service (Resend)${' '.repeat(config.resend.apiKey ? 35 : 34)}║
║   ${config.stripe.secretKey ? '✅' : '⚠️ '} Payment Processing (Stripe)${' '.repeat(config.stripe.secretKey ? 30 : 29)}║
║   ${(config.redis.url || config.redis.host) ? '✅' : '⚠️ '} Caching (Redis)${' '.repeat((config.redis.url || config.redis.host) ? 42 : 41)}║
║   ✅ Rate Limiting                                             ║
║   ✅ Structured Logging                                        ║
║                                                               ║
║   API Endpoints:                                              ║
║   - GET  /api/health          - Health check                  ║
║   - GET  /api/health/ready    - Readiness check               ║
║   - POST /api/auth/register   - Register user                 ║
║   - POST /api/auth/login      - Login user                    ║
║   - GET  /api/listings        - Browse listings               ║
║   - POST /api/webhooks/stripe - Stripe webhooks               ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
      `;

      console.log(banner);
      logger.info('Server started successfully', {
        port: config.port,
        environment: config.nodeEnv,
      });
    });
  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
};

// ============================================
// Graceful Shutdown
// ============================================
const shutdown = async (signal: string) => {
  logger.info(`${signal} received - initiating graceful shutdown...`);

  // Stop accepting new connections
  httpServer.close(() => {
    logger.info('HTTP server closed');
  });

  // Set a timeout for forceful shutdown
  const forceTimeout = setTimeout(() => {
    logger.error('Forceful shutdown due to timeout');
    process.exit(1);
  }, 30000); // 30 seconds

  try {
    // Disconnect from Redis
    logger.info('Disconnecting from Redis...');
    await disconnectRedis();

    // Disconnect from database
    logger.info('Disconnecting from database...');
    await disconnectDatabase();

    clearTimeout(forceTimeout);
    logger.info('Graceful shutdown completed');
    process.exit(0);
  } catch (error) {
    logger.error('Error during shutdown', { error });
    process.exit(1);
  }
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ============================================
// Start the Server
// ============================================
startServer();

// ============================================
// Export for Testing
// ============================================
export { app, httpServer };
export default app;
