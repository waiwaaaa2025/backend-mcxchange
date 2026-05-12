import { Router, Request, Response } from 'express';
import authRoutes from './authRoutes';
import listingRoutes from './listingRoutes';
import offerRoutes from './offerRoutes';
import transactionRoutes from './transactionRoutes';
import adminRoutes from './adminRoutes';
import creditRoutes from './creditRoutes';
import fmcsaRoutes from './fmcsaRoutes';
import creditsafeRoutes from './creditsafeRoutes';
import dueDiligenceRoutes from './dueDiligenceRoutes';
import messageRoutes from './messageRoutes';
import notificationRoutes from './notificationRoutes';
import userRoutes from './userRoutes';
import sellerRoutes from './sellerRoutes';
import buyerRoutes from './buyerRoutes';
import documentRoutes from './documentRoutes';
import credentialRoutes from './credentialRoutes';
import consultationRoutes from './consultationRoutes';
import telegramRoutes from './telegramRoutes';
import facebookRoutes from './facebookRoutes';
import disputeRoutes from './disputeRoutes';
import identityRoutes from './identityRoutes';
import aiChatRoutes from './aiChatRoutes';
import dispatchRoutes from './dispatchRoutes';
import adminServicesRoutes from './adminServicesRoutes';
import safetyServicesRoutes from './safetyServicesRoutes';
import recruitingServicesRoutes from './recruitingServicesRoutes';
import fuelProgramRoutes from './fuelProgramRoutes';
import carrierDataRoutes from './carrierDataRoutes';
import truckRoutes from './truckRoutes';
import guideRoutes from './guideRoutes';
import { sequelize } from '../models';
import { isRedisHealthy } from '../config/redis';
import { config, getPublicConfig } from '../config';
import { getOnlineUsers } from '../websocket';
import cacheService from '../services/cacheService';

const router = Router();

// ============================================
// Health Check Endpoints
// ============================================

/**
 * Basic liveness check
 * Returns 200 if the server is running
 */
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    success: true,
    status: 'healthy',
    message: 'Domilea API is running',
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || '1.0.0',
  });
});

/**
 * Detailed health check
 * Returns status of all dependencies
 */
router.get('/health/ready', async (_req: Request, res: Response) => {
  const startTime = Date.now();

  // Check database connection
  let dbHealthy = false;
  let dbLatency = 0;
  try {
    const dbStart = Date.now();
    await sequelize.authenticate();
    dbLatency = Date.now() - dbStart;
    dbHealthy = true;
  } catch (error) {
    dbHealthy = false;
  }

  // Check Redis connection
  let redisHealthy = false;
  let redisLatency = 0;
  try {
    const redisStart = Date.now();
    redisHealthy = await isRedisHealthy();
    redisLatency = Date.now() - redisStart;
  } catch {
    redisHealthy = false;
  }

  // Overall status
  const isReady = dbHealthy; // Database is required, Redis is optional

  const healthData = {
    success: isReady,
    status: isReady ? 'ready' : 'unhealthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    responseTime: Date.now() - startTime,
    services: {
      database: {
        status: dbHealthy ? 'healthy' : 'unhealthy',
        latency: dbLatency,
      },
      redis: {
        status: redisHealthy ? 'healthy' : 'unavailable',
        latency: redisLatency,
        required: false,
      },
    },
    environment: config.nodeEnv,
    memory: {
      used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      unit: 'MB',
    },
  };

  res.status(isReady ? 200 : 503).json(healthData);
});

/**
 * Kubernetes-style liveness probe
 * Simple check that the process is alive
 */
router.get('/health/live', (_req: Request, res: Response) => {
  res.status(200).json({
    status: 'alive',
    timestamp: new Date().toISOString(),
  });
});

/**
 * Get server statistics (admin only in production)
 */
router.get('/health/stats', async (_req: Request, res: Response) => {
  // In production, this should require admin authentication
  // For now, returning basic stats

  const cacheStats = await cacheService.getStats();
  const onlineUsers = getOnlineUsers();

  res.json({
    success: true,
    stats: {
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      cpu: process.cpuUsage(),
      platform: process.platform,
      nodeVersion: process.version,
      websocket: {
        onlineUsers: onlineUsers.length,
      },
      cache: cacheStats,
    },
    timestamp: new Date().toISOString(),
  });
});

/**
 * Get public configuration
 */
router.get('/config', (_req: Request, res: Response) => {
  res.json({
    success: true,
    config: getPublicConfig(),
  });
});

/**
 * Get public platform settings (for frontend feature flags)
 * Returns settings that control frontend behavior without requiring authentication
 */
router.get('/settings/public', async (_req: Request, res: Response) => {
  try {
    const { adminService } = await import('../services/adminService');
    const listingPaymentRequired = await adminService.isListingPaymentRequired();

    res.json({
      success: true,
      data: {
        listingPaymentRequired,
      },
    });
  } catch (error) {
    // Default to true (payment required) on error for safety
    res.json({
      success: true,
      data: {
        listingPaymentRequired: true,
      },
    });
  }
});

// ============================================
// Mount API Routes
// ============================================

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/listings', listingRoutes);
router.use('/offers', offerRoutes);
router.use('/transactions', transactionRoutes);
router.use('/messages', messageRoutes);
router.use('/notifications', notificationRoutes);
router.use('/seller', sellerRoutes);
router.use('/buyer', buyerRoutes);
router.use('/documents', documentRoutes);
router.use('/credentials', credentialRoutes);
router.use('/admin', adminRoutes);
router.use('/credits', creditRoutes);
router.use('/fmcsa', fmcsaRoutes);
router.use('/admin/creditsafe', creditsafeRoutes);
router.use('/admin/due-diligence', dueDiligenceRoutes);
router.use('/consultations', consultationRoutes);
router.use('/admin/telegram', telegramRoutes);
router.use('/admin/facebook', facebookRoutes);
router.use('/disputes', disputeRoutes);
router.use('/identity', identityRoutes);
router.use('/ai-chat', aiChatRoutes);
router.use('/dispatch', dispatchRoutes);
router.use('/admin-services', adminServicesRoutes);
router.use('/safety-services', safetyServicesRoutes);
router.use('/recruiting-services', recruitingServicesRoutes);
router.use('/fuel-program', fuelProgramRoutes);
router.use('/carrier-data', carrierDataRoutes);
router.use('/guide', guideRoutes);
// Truck routes live at root because they span /listings/:id/trucks and /trucks/:id
router.use('/', truckRoutes);

export default router;
