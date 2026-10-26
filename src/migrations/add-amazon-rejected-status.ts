/**
 * Migration: Add REJECTED to listings.amazonStatus ENUM
 *
 * sync({ force: false }) never widens ENUMs, so without this a REJECTED
 * status is stored as an empty string.
 *
 * Run with:
 *   npx ts-node src/migrations/add-amazon-rejected-status.ts
 */
import { Sequelize } from 'sequelize';

const JAWSDB_URL = process.env.JAWSDB_URL;
if (!JAWSDB_URL) {
  console.error('JAWSDB_URL environment variable is required');
  process.exit(1);
}

const sequelize = new Sequelize(JAWSDB_URL, { dialect: 'mysql', logging: false });

async function run() {
  try {
    console.log('Adding REJECTED to listings.amazonStatus ENUM...');
    await sequelize.query(
      `ALTER TABLE listings MODIFY COLUMN amazonStatus ENUM('NONE','PENDING','ACTIVE','SUSPENDED','REJECTED') DEFAULT 'NONE'`
    );
    console.log('✓ REJECTED added to ENUM');
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  } finally {
    await sequelize.close();
  }
}

run();
