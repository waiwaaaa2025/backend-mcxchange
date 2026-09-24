import { Sequelize } from 'sequelize';
import config from './index';

// Parse JAWSDB_URL if available (Heroku auto-sets this for JawsDB add-on)
function parseJawsDbUrl(url: string) {
  try {
    const parsed = new URL(url);
    return {
      database: parsed.pathname.slice(1), // Remove leading slash
      username: parsed.username,
      password: parsed.password,
      host: parsed.hostname,
      port: parseInt(parsed.port || '3306', 10),
    };
  } catch (error) {
    console.error('Failed to parse JAWSDB_URL:', error);
    return null;
  }
}

// Get database connection config - prefer JAWSDB_URL if available
const jawsConfig = process.env.JAWSDB_URL ? parseJawsDbUrl(process.env.JAWSDB_URL) : null;

const dbConfig = jawsConfig || {
  database: config.database.name,
  username: config.database.user,
  password: config.database.password,
  host: config.database.host,
  port: config.database.port,
};

// Build dialect options - only use socket for local development
const dialectOptions: Record<string, unknown> = {
  connectTimeout: 10000, // 10 second connection timeout
};

// Only use socket path for local development, not for production remote databases
if (config.isDevelopment && process.env.DB_SOCKET_PATH) {
  dialectOptions.socketPath = process.env.DB_SOCKET_PATH;
} else if (config.isDevelopment && config.database.host === 'localhost' && !jawsConfig) {
  // Default socket path for local macOS MySQL (only if not using JAWSDB)
  dialectOptions.socketPath = '/tmp/mysql.sock';
}
// For production/remote databases, don't use socketPath - connect via host/port

// Create Sequelize instance with config-based pool settings (not hardcoded!)
const sequelize = new Sequelize(
  dbConfig.database,
  dbConfig.username,
  dbConfig.password,
  {
    host: dbConfig.host,
    port: dbConfig.port,
    dialect: 'mysql',
    logging: config.nodeEnv === 'development' ? console.log : false,
    pool: {
      max: config.database.pool.max,      // Use config (default 5)
      min: config.database.pool.min,      // Use config (default 1)
      acquire: config.database.pool.acquire,
      idle: config.database.pool.idle,
      evict: 1000, // Check for idle connections every 1 second
    },
    retry: {
      max: 3, // Retry failed queries up to 3 times
    },
    define: {
      timestamps: true,
      underscored: false,
    },
    dialectOptions,
  }
);

// Test database connection
export const connectDatabase = async (): Promise<void> => {
  try {
    await sequelize.authenticate();
    console.log('Database connected successfully');

    // Safe column migrations — MUST run before sync() so indexes on new columns don't fail
    const addColumnIfMissing = async (table: string, column: string, type: string) => {
      try {
        await sequelize.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${type}`, { logging: false });
        console.log(`Migration: added ${table}.${column}`);
      } catch (e: any) {
        if (e?.original?.code !== 'ER_DUP_FIELDNAME') {
          console.warn(`Migration: could not add ${table}.${column}:`, e?.message);
        }
      }
    };
    await addColumnIfMissing('users', 'mcNumber', 'VARCHAR(50) NULL');
    await addColumnIfMissing('users', 'dotNumber', 'VARCHAR(50) NULL');
    await addColumnIfMissing('listings', 'rmisSetup', 'TINYINT(1) NOT NULL DEFAULT 0');
    await addColumnIfMissing('listings', 'setupWithBrokers', 'TINYINT(1) NOT NULL DEFAULT 0');
    await addColumnIfMissing('listings', 'freeToUnlock', 'TINYINT(1) NOT NULL DEFAULT 0');
    await addColumnIfMissing(
      'listings',
      'authorityType',
      "ENUM('MOTOR_CARRIER','BROKER','MOTOR_CARRIER_AND_BROKER','FREIGHT_FORWARDER') NOT NULL DEFAULT 'MOTOR_CARRIER'"
    );

    // Equipment (trucks/trailers) sold alongside an authority
    await addColumnIfMissing('trucks', 'equipmentType', "VARCHAR(20) NOT NULL DEFAULT 'TRUCK'");
    await addColumnIfMissing('trucks', 'price', 'DECIMAL(12,2) NULL');
    await addColumnIfMissing('trucks', 'trailerType', 'VARCHAR(50) NULL');
    await addColumnIfMissing('trucks', 'lengthFt', 'INT NULL');
    await addColumnIfMissing('trucks', 'engine', 'VARCHAR(100) NULL');
    await addColumnIfMissing('trucks', 'transmission', 'VARCHAR(50) NULL');

    // Standalone equipment & parts marketplace: items not tied to an authority
    await addColumnIfMissing('trucks', 'sellerId', 'CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL');
    await addColumnIfMissing('trucks', 'status', "VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'");
    await addColumnIfMissing('trucks', 'reviewNote', 'VARCHAR(500) NULL');
    await addColumnIfMissing('trucks', 'city', 'VARCHAR(100) NULL');
    await addColumnIfMissing('trucks', 'state', 'VARCHAR(2) NULL');
    await addColumnIfMissing('trucks', 'name', 'VARCHAR(200) NULL');
    await addColumnIfMissing('trucks', 'partCategory', 'VARCHAR(50) NULL');
    await addColumnIfMissing('trucks', 'partNumber', 'VARCHAR(100) NULL');
    await addColumnIfMissing('trucks', 'quantity', 'INT NULL');
    await addColumnIfMissing('trucks', 'fitment', 'VARCHAR(255) NULL');
    try {
      const [cols]: any = await sequelize.query(
        "SELECT IS_NULLABLE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'trucks' AND COLUMN_NAME = 'listingId'",
        { logging: false }
      );
      if (cols?.[0]?.IS_NULLABLE === 'NO') {
        // Same type/collation as listings.id so the foreign key survives.
        await sequelize.query(
          'ALTER TABLE `trucks` MODIFY COLUMN `listingId` CHAR(36) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL',
          { logging: false }
        );
        console.log('Migration: trucks.listingId is now nullable');
      }
    } catch (e: any) {
      console.warn('Migration: could not make trucks.listingId nullable:', e?.message);
    }

    // Escrow columns for transaction payment tracking
    await addColumnIfMissing('transactions', 'escrowAmount', 'DECIMAL(12,2) NULL');
    await addColumnIfMissing('transactions', 'escrowConfirmedAt', 'DATETIME NULL');
    await addColumnIfMissing('transactions', 'escrowConfirmedBy', 'CHAR(36) NULL');
    await addColumnIfMissing('transactions', 'escrowPaymentMethod', 'VARCHAR(50) NULL');

    // Payout columns for admin release payout to seller
    await addColumnIfMissing('transactions', 'payoutStatus', 'VARCHAR(20) NULL');
    await addColumnIfMissing('transactions', 'payoutReleasedAt', 'DATETIME NULL');
    await addColumnIfMissing('transactions', 'payoutTransferId', 'VARCHAR(255) NULL');
    await addColumnIfMissing('transactions', 'sellerPaidAtCharge', 'DECIMAL(12,2) NULL');

    // Convert document type from ENUM to VARCHAR to avoid enum sync issues
    try {
      await sequelize.query(
        `ALTER TABLE \`documents\` MODIFY COLUMN \`type\` VARCHAR(50) NOT NULL`,
      );
      console.log('Migration: converted documents.type to VARCHAR');
    } catch (e: any) {
      console.warn('Migration warning (documents.type):', e.message || e);
    }

    // Sync models after migrations so indexes on new columns succeed
    await sequelize.sync({ force: false });
    console.log('Database models synchronized');
  } catch (error) {
    console.error('Database connection failed:', error);
    throw error;
  }
};

// Graceful shutdown
export const disconnectDatabase = async (): Promise<void> => {
  await sequelize.close();
  console.log('Database disconnected');
};

export default sequelize;
