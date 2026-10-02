import Redis, { RedisOptions } from 'ioredis';
import { config } from './index';
import logger from '../utils/logger';

// Redis connection options
const redisOptions: RedisOptions = {
  host: config.redis?.host || 'localhost',
  port: config.redis?.port || 6379,
  password: config.redis?.password || undefined,
  db: config.redis?.db || 0,
  retryStrategy: (times: number) => {
    if (times > 10) {
      logger.error('Redis connection failed after 10 retries');
      return null; // Stop retrying
    }
    const delay = Math.min(times * 100, 3000);
    logger.warn(`Redis connection attempt ${times}, retrying in ${delay}ms`);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: true,
};

// Create Redis client
let redis: Redis | null = null;

export const getRedisClient = (): Redis => {
  if (!redis) {
    if (config.redis?.url) {
      // Heroku Redis uses self-signed certificates, so we need to disable TLS verification
      // Also handle both redis:// and rediss:// URLs
      const url = config.redis.url;
      const useTls = url.startsWith('rediss://');

      redis = new Redis(url, {
        tls: useTls ? { rejectUnauthorized: false } : undefined,
        maxRetriesPerRequest: 3,
        lazyConnect: true, // connectRedis() opens the connection; without this ioredis connects on construction

        retryStrategy: (times: number) => {
          if (times > 10) {
            logger.error('Redis connection failed after 10 retries');
            return null;
          }
          const delay = Math.min(times * 100, 3000);
          logger.warn(`Redis connection attempt ${times}, retrying in ${delay}ms`);
          return delay;
        },
      });
    } else {
      redis = new Redis(redisOptions);
    }

    redis.on('connect', () => {
      logger.info('Redis client connecting...');
    });

    redis.on('ready', () => {
      logger.info('Redis client ready');
    });

    redis.on('error', (err) => {
      logger.error('Redis client error', err);
    });

    redis.on('close', () => {
      logger.warn('Redis connection closed');
    });

    redis.on('reconnecting', () => {
      logger.info('Redis client reconnecting...');
    });
  }

  return redis;
};

// Connect to Redis
export const connectRedis = async (): Promise<void> => {
  try {
    const client = getRedisClient();
    // Only a fresh lazy client is in 'wait'; connecting again otherwise throws "already connecting/connected"
    if (client.status === 'wait') {
      await client.connect();
    }
    // Test connection
    await client.ping();
    logger.info('Redis connected successfully');
  } catch (error) {
    logger.error('Failed to connect to Redis', error as Error);
    // Don't throw - allow app to start without Redis (graceful degradation)
  }
};

// Disconnect from Redis
export const disconnectRedis = async (): Promise<void> => {
  if (redis) {
    await redis.quit();
    redis = null;
    logger.info('Redis disconnected');
  }
};

// Check Redis health
export const isRedisHealthy = async (): Promise<boolean> => {
  try {
    if (!redis) return false;
    const pong = await redis.ping();
    return pong === 'PONG';
  } catch {
    return false;
  }
};

// Export default client getter
export default getRedisClient;
