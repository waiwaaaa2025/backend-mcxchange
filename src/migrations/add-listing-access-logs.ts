/**
 * Migration: Create listing_access_logs table
 *
 * Records who reads the marketplace catalogue (browse / search / detail),
 * signed in or not, so scraping is visible after the fact rather than only
 * when it trips a rate limit.
 *
 * Separate from user_access_logs on purpose: that table is chargeback evidence
 * and buildEvidencePdf reads a user's 500 oldest rows, so high-volume browse
 * events would crowd out the LOGIN/UNLOCK rows that prove the sale. userId is
 * nullable here because anonymous traffic is exactly what we want to see.
 *
 * sequelize.sync({ force: false }) creates this table on boot too; this file
 * exists so production can be migrated explicitly and the shape is reviewable.
 *
 * Run with:
 *   npx ts-node src/migrations/add-listing-access-logs.ts
 */
import { Sequelize } from 'sequelize';

const JAWSDB_URL = process.env.JAWSDB_URL;
if (!JAWSDB_URL) {
  console.error('JAWSDB_URL environment variable is required');
  process.exit(1);
}

const sequelize = new Sequelize(JAWSDB_URL, { dialect: 'mysql', logging: console.log });

async function run() {
  try {
    console.log('=== Migration: Create listing_access_logs table ===\n');

    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS listing_access_logs (
        id CHAR(36) NOT NULL PRIMARY KEY,
        userId CHAR(36) NULL,
        event VARCHAR(16) NOT NULL,
        listingId CHAR(36) NULL,
        ipAddress VARCHAR(45) NULL,
        userAgent TEXT NULL,
        detail VARCHAR(255) NULL,
        createdAt DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_listing_access_ip_created (ipAddress, createdAt),
        INDEX idx_listing_access_user_created (userId, createdAt),
        INDEX idx_listing_access_created (createdAt)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
    `);

    console.log('\n✓ listing_access_logs ready');
    await sequelize.close();
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    await sequelize.close();
    process.exit(1);
  }
}

run();
