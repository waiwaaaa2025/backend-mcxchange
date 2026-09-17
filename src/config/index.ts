import dotenv from 'dotenv';
import path from 'path';

// Load environment variables
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// Environment type
type Environment = 'development' | 'production' | 'test';

const nodeEnv = (process.env.NODE_ENV || 'development') as Environment;
const isProduction = nodeEnv === 'production';
const isDevelopment = nodeEnv === 'development';
const isTest = nodeEnv === 'test';

export const config = {
  // Server
  port: parseInt(process.env.PORT || '3001', 10),
  nodeEnv,
  isProduction,
  isDevelopment,
  isTest,
  frontendUrl: process.env.FRONTEND_URL || 'http://localhost:5173',
  apiUrl: process.env.API_URL || 'http://localhost:3001',

  // Database (MySQL)
  database: {
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '3306', 10),
    name: process.env.DB_NAME || 'mc_exchange',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    // Connection pool settings - JawsDB Leopard allows ~15 max connections
    pool: {
      max: parseInt(process.env.DB_POOL_MAX || '10', 10),     // Use 10, leave 5 for admin/migrations
      min: parseInt(process.env.DB_POOL_MIN || '2', 10),      // Keep 2 warm connections
      acquire: parseInt(process.env.DB_POOL_ACQUIRE || '10000', 10), // 10s acquire timeout
      idle: parseInt(process.env.DB_POOL_IDLE || '30000', 10),  // 30s idle before recycling
    },
    // Logging
    logging: process.env.DB_LOGGING === 'true' || isDevelopment,
  },

  // JWT
  jwt: {
    secret: process.env.JWT_SECRET || 'your-super-secret-jwt-key-change-in-production',
    expiresIn: process.env.JWT_EXPIRES_IN || '15m', // Short-lived access tokens
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'your-refresh-secret-key-change-in-production',
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  // Stripe
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    // Enable Stripe-native Terms-of-Service consent collection on hosted checkout.
    // REQUIRES a Terms-of-Service URL configured in the Stripe Dashboard
    // (Settings → Public details / Checkout branding) — otherwise session
    // creation fails. Keep OFF until that URL is confirmed set, so a bad config
    // can never take checkout down.
    tosConsentEnabled: process.env.STRIPE_TOS_CONSENT_ENABLED === 'true',
  },

  // SMTP Email Configuration (Nodemailer)
  smtp: {
    host: process.env.SMTP_HOST || '',
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
    user: (process.env.SMTP_USER || '').trim(),
    // Google shows app passwords in four spaced groups ("abcd efgh ijkl mnop") and
    // those spaces are display only — pasted in verbatim they reach Gmail as part of
    // the password and AUTH fails with 535-5.7.8. Strip them for Gmail; elsewhere
    // only trim the ends, since another provider's password could contain a space.
    pass: /gmail|googlemail/i.test(process.env.SMTP_HOST || '')
      ? (process.env.SMTP_PASS || '').replace(/\s+/g, '')
      : (process.env.SMTP_PASS || '').trim(),
    fromEmail: process.env.EMAIL_FROM || 'noreply@domilea.com',
    fromName: process.env.EMAIL_FROM_NAME || 'Domilea',
    replyTo: process.env.EMAIL_REPLY_TO || '',
  },

  // Resend Email (legacy/optional)
  resend: {
    apiKey: process.env.RESEND_API_KEY || '',
    fromEmail: process.env.EMAIL_FROM || 'noreply@domilea.com',
    fromName: process.env.EMAIL_FROM_NAME || 'Domilea',
    replyTo: process.env.EMAIL_REPLY_TO || 'support@domilea.com',
  },

  // Redis
  redis: {
    url: process.env.REDIS_URL || undefined,
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD || undefined,
    db: parseInt(process.env.REDIS_DB || '0', 10),
  },

  // MorPro Carrier API
  morproCarrier: {
    baseUrl: process.env.MORPRO_CARRIER_API_URL || 'http://194.195.92.25:3001',
    apiKey: process.env.MORPRO_CARRIER_API_KEY || '',
  },

  // MorPro LINQ (data source for Leads tool)
  morproLinq: {
    baseUrl: process.env.MORPRO_LINQ_API_URL || 'https://api.morprolinq.com',
    apiKey: process.env.MORPRO_LINQ_API_KEY || '',
  },

  // AI Agent platform
  agents: {
    enableWorker: process.env.ENABLE_AGENT_WORKER === 'true',
    workerIntervalMs: parseInt(process.env.AGENT_WORKER_INTERVAL_MS || '5000', 10),
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    defaultChatModel: process.env.AGENT_CHAT_MODEL || 'gpt-4o',
    defaultReasoningModel: process.env.AGENT_REASONING_MODEL || 'gpt-4o-mini',
    dailyTokenBudgetUser: parseInt(process.env.AGENT_DAILY_TOKEN_BUDGET_USER || '200000', 10),
    dailyTokenBudgetPlatform: parseInt(process.env.AGENT_DAILY_TOKEN_BUDGET_PLATFORM || '2000000', 10),
    maxChatIterations: parseInt(process.env.AGENT_MAX_CHAT_ITERATIONS || '6', 10),
    toolResultMaxChars: parseInt(process.env.AGENT_TOOL_RESULT_MAX_CHARS || '12000', 10),
  },

  // FMCSA
  fmcsa: {
    apiKey: process.env.FMCSA_API_KEY || '',
    baseUrl: process.env.FMCSA_BASE_URL || 'https://mobile.fmcsa.dot.gov/qc/services',
  },

  // Creditsafe
  creditsafe: {
    username: process.env.CREDITSAFE_USERNAME || '',
    password: process.env.CREDITSAFE_PASSWORD || '',
    baseUrl: process.env.CREDITSAFE_BASE_URL || 'https://connect.creditsafe.com/v1',
  },

  // File Upload
  upload: {
    maxFileSize: parseInt(process.env.MAX_FILE_SIZE || '10485760', 10), // 10MB
    uploadDir: process.env.UPLOAD_DIR || './uploads',
    allowedTypes: ['image/jpeg', 'image/png', 'image/gif', 'application/pdf', 'image/webp', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] as string[],
    // S3 configuration (optional)
    s3: {
      enabled: process.env.S3_ENABLED === 'true',
      bucket: process.env.S3_BUCKET || '',
      region: process.env.S3_REGION || 'us-east-1',
      accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
    },
  },

  // Rate Limiting
  rateLimit: {
    windowMs: process.env.RATE_LIMIT_WINDOW_MS || '900000', // 15 minutes
    maxRequests: process.env.RATE_LIMIT_MAX_REQUESTS || '3000',
  },

  // Security
  security: {
    bcryptRounds: parseInt(process.env.BCRYPT_ROUNDS || '12', 10),
    passwordMinLength: parseInt(process.env.PASSWORD_MIN_LENGTH || '8', 10),
    sessionTimeout: parseInt(process.env.SESSION_TIMEOUT || '3600', 10), // 1 hour
    credentialEncryptionKey: process.env.CREDENTIAL_ENCRYPTION_KEY || '',
  },

  // Cors
  cors: {
    origins: process.env.CORS_ORIGINS?.split(',') || [
      'http://localhost:5173',
      'http://localhost:5174',
      'http://localhost:3000',
    ],
    credentials: true,
  },

  // Platform Settings
  platform: {
    name: process.env.PLATFORM_NAME || 'Domilea',
    listingFee: parseFloat(process.env.LISTING_FEE || '49.99'),
    premiumListingFee: parseFloat(process.env.PREMIUM_LISTING_FEE || '199.99'),
    transactionFeePercent: parseFloat(process.env.TRANSACTION_FEE_PERCENT || '3'),
    depositPercent: parseFloat(process.env.DEPOSIT_PERCENT || '10'),
    minDeposit: parseFloat(process.env.MIN_DEPOSIT || '500'),
    maxDeposit: parseFloat(process.env.MAX_DEPOSIT || '10000'),
  },

  // Subscription Plans
  subscriptions: {
    starter: {
      credits: 4,
      monthlyPrice: 99,
      yearlyPrice: 950,
    },
    premium: {
      credits: 10,
      monthlyPrice: 199,
      yearlyPrice: 1910,
    },
    enterprise: {
      credits: 25,
      monthlyPrice: 399,
      yearlyPrice: 3830,
    },
  },

} as const;

// Configuration validation errors
class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

// Validate required configuration
export function validateConfig(): void {
  const errors: string[] = [];
  const warnings: string[] = [];

  // ============================================
  // Production-only required variables
  // ============================================
  if (isProduction) {
    // JWT secrets must be set and strong
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
      errors.push('JWT_SECRET must be set and at least 32 characters in production');
    }

    if (!process.env.JWT_REFRESH_SECRET || process.env.JWT_REFRESH_SECRET.length < 32) {
      errors.push('JWT_REFRESH_SECRET must be set and at least 32 characters in production');
    }

    // Database must be configured (JAWSDB_URL or individual vars)
    if (!process.env.JAWSDB_URL && (!process.env.DB_HOST || !process.env.DB_NAME || !process.env.DB_USER)) {
      errors.push('Database configuration (JAWSDB_URL or DB_HOST, DB_NAME, DB_USER) is required in production');
    }

    // Stripe must be configured for payments
    if (!process.env.STRIPE_SECRET_KEY) {
      errors.push('STRIPE_SECRET_KEY is required in production');
    }

    if (!process.env.STRIPE_WEBHOOK_SECRET) {
      errors.push('STRIPE_WEBHOOK_SECRET is required in production');
    }

    // Email configuration (optional - will run in degraded mode without it)
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
      warnings.push('SMTP not configured - email functionality will be disabled');
    }

    // Frontend URL must be set
    if (!process.env.FRONTEND_URL) {
      errors.push('FRONTEND_URL is required in production');
    }

    // CORS must be explicitly configured
    if (!process.env.CORS_ORIGINS) {
      warnings.push('CORS_ORIGINS not set - using default localhost origins');
    }
  }

  // ============================================
  // Warnings for missing optional config
  // ============================================
  if (!process.env.MORPRO_CARRIER_API_URL) {
    warnings.push('MORPRO_CARRIER_API_URL not set - using default http://194.195.92.25:3001');
  }

  if (!process.env.MORPRO_CARRIER_API_KEY) {
    warnings.push('MORPRO_CARRIER_API_KEY not set - MorPro requests will go unauthenticated (works today, will break when MorPro enforces auth)');
  }

  if (!process.env.MORPRO_LINQ_API_KEY) {
    warnings.push('MORPRO_LINQ_API_KEY not set - Leads tool will not be able to query LINQ');
  }

  if (!process.env.FMCSA_API_KEY) {
    warnings.push('FMCSA_API_KEY not set - FMCSA lookups will not work');
  }

  if (!process.env.CREDITSAFE_USERNAME || !process.env.CREDITSAFE_PASSWORD) {
    warnings.push('CREDITSAFE_USERNAME/PASSWORD not set - Creditsafe credit reports will not work');
  }

  if (!process.env.REDIS_URL && !process.env.REDIS_HOST) {
    warnings.push('Redis not configured - rate limiting will use in-memory store');
  }

  // Check default JWT secrets in development
  if (isDevelopment) {
    if (config.jwt.secret.includes('change-in-production')) {
      warnings.push('Using default JWT_SECRET - change this in production!');
    }
    if (config.jwt.refreshSecret.includes('change-in-production')) {
      warnings.push('Using default JWT_REFRESH_SECRET - change this in production!');
    }
  }

  // ============================================
  // Log warnings
  // ============================================
  if (warnings.length > 0) {
    console.warn('\n⚠️  Configuration Warnings:');
    warnings.forEach((warning) => console.warn(`   - ${warning}`));
    console.warn('');
  }

  // ============================================
  // Throw on errors in production
  // ============================================
  if (errors.length > 0) {
    console.error('\n❌ Configuration Errors:');
    errors.forEach((error) => console.error(`   - ${error}`));
    console.error('');

    if (isProduction) {
      throw new ConfigurationError(
        `Invalid configuration for production environment:\n${errors.join('\n')}`
      );
    }
  }

  // Success message
  console.log(`✅ Configuration validated for ${nodeEnv} environment`);
}

// Get public-safe config (no secrets)
export function getPublicConfig() {
  return {
    nodeEnv: config.nodeEnv,
    platformName: config.platform.name,
    frontendUrl: config.frontendUrl,
    features: {
      stripe: !!config.stripe.secretKey,
      email: !!(config.smtp.host && config.smtp.user),
      fmcsa: !!config.fmcsa.apiKey,
      creditsafe: !!(config.creditsafe.username && config.creditsafe.password),
      redis: !!config.redis.url || !!config.redis.host,
      s3: config.upload.s3.enabled,
    },
    subscriptions: config.subscriptions,
    platform: {
      listingFee: config.platform.listingFee,
      premiumListingFee: config.platform.premiumListingFee,
      transactionFeePercent: config.platform.transactionFeePercent,
    },
  };
}

export default config;
