/**
 * Migration: Add broker_outreach_requests table
 * Backs the "Ask Domilea to contact the seller" flow from the Pending
 * Insurance Leads tool. Idempotent — safe to re-run.
 *
 * Run with:
 *   npx ts-node src/migrations/add-broker-outreach-requests.ts
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
    console.log('=== Migration: Add broker_outreach_requests ===\n');

    console.log('1. Creating broker_outreach_requests table...');
    await sequelize.query(`
      CREATE TABLE IF NOT EXISTS broker_outreach_requests (
        id CHAR(36) NOT NULL PRIMARY KEY,
        status ENUM('PENDING','CONTACTED','NEGOTIATING','COMPLETED','CLOSED','FAILED') NOT NULL DEFAULT 'PENDING',
        dotNumber VARCHAR(20) NOT NULL,
        mcNumber VARCHAR(20) NULL,
        carrierName VARCHAR(255) NULL,
        buyerMessage TEXT NULL,
        adminNotes TEXT NULL,
        contactedAt DATETIME NULL,
        contactedBy CHAR(36) NULL,
        userId CHAR(36) NOT NULL,
        createdAt DATETIME NOT NULL,
        updatedAt DATETIME NOT NULL,
        INDEX broker_outreach_status (status),
        INDEX broker_outreach_user (userId),
        INDEX broker_outreach_dot (dotNumber)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
    `);
    console.log('   ✓ broker_outreach_requests table ready');

    console.log('\n=== Migration complete ===');
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

run();
