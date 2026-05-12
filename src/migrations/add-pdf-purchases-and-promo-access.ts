/**
 * Migration: Add pdf_purchases table and promo access columns to users
 *
 * - pdf_purchases: tracks one-time PDF/bundle purchases via Stripe Payment Links
 * - users.promoAccessType: 'pdf_bundle_60day' for the buyer's guide bundle
 * - users.promoAccessExpiresAt: hard expiry for time-limited access grants
 *
 * Run manually using:
 *   npx ts-node src/migrations/add-pdf-purchases-and-promo-access.ts
 * Rollback:
 *   npx ts-node src/migrations/add-pdf-purchases-and-promo-access.ts down
 */

import { DataTypes } from 'sequelize';
import sequelize from '../config/database';

async function up(): Promise<void> {
  const queryInterface = sequelize.getQueryInterface();

  try {
    // 1. Add promo access columns to users
    const usersDesc = await queryInterface.describeTable('users');

    if (!usersDesc['promoAccessType']) {
      console.log('Adding promoAccessType column to users...');
      await queryInterface.addColumn('users', 'promoAccessType', {
        type: DataTypes.STRING(32),
        allowNull: true,
      });
      console.log('✓ promoAccessType added');
    } else {
      console.log('promoAccessType already exists, skipping');
    }

    if (!usersDesc['promoAccessExpiresAt']) {
      console.log('Adding promoAccessExpiresAt column to users...');
      await queryInterface.addColumn('users', 'promoAccessExpiresAt', {
        type: DataTypes.DATE,
        allowNull: true,
      });
      console.log('✓ promoAccessExpiresAt added');
    } else {
      console.log('promoAccessExpiresAt already exists, skipping');
    }

    // 2. Create pdf_purchases table
    const tables = await queryInterface.showAllTables();
    const tableNames = tables.map((t) => (typeof t === 'string' ? t : (t as { tableName: string }).tableName));

    if (!tableNames.includes('pdf_purchases')) {
      console.log('Creating pdf_purchases table...');
      await queryInterface.createTable('pdf_purchases', {
        id: {
          type: DataTypes.UUID,
          defaultValue: DataTypes.UUIDV4,
          primaryKey: true,
        },
        email: {
          type: DataTypes.STRING(255),
          allowNull: false,
        },
        stripeSessionId: {
          type: DataTypes.STRING(255),
          allowNull: false,
          unique: true,
        },
        tier: {
          type: DataTypes.STRING(32),
          allowNull: false,
        },
        downloadToken: {
          type: DataTypes.STRING(128),
          allowNull: false,
          unique: true,
        },
        downloadCount: {
          type: DataTypes.INTEGER,
          allowNull: false,
          defaultValue: 0,
        },
        lastDownloadedAt: {
          type: DataTypes.DATE,
          allowNull: true,
        },
        userId: {
          type: DataTypes.UUID,
          allowNull: true,
        },
        amountCents: {
          type: DataTypes.INTEGER,
          allowNull: true,
        },
        createdAt: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: DataTypes.NOW,
        },
        updatedAt: {
          type: DataTypes.DATE,
          allowNull: false,
          defaultValue: DataTypes.NOW,
        },
      });

      await queryInterface.addIndex('pdf_purchases', ['email']);
      await queryInterface.addIndex('pdf_purchases', ['downloadToken'], { unique: true });
      await queryInterface.addIndex('pdf_purchases', ['stripeSessionId'], { unique: true });
      await queryInterface.addIndex('pdf_purchases', ['userId']);
      console.log('✓ pdf_purchases table created');
    } else {
      console.log('pdf_purchases table already exists, skipping');
    }

    console.log('Migration completed successfully');
  } catch (error) {
    console.error('Migration failed:', error);
    throw error;
  }
}

async function down(): Promise<void> {
  const queryInterface = sequelize.getQueryInterface();

  try {
    await queryInterface.dropTable('pdf_purchases');
    await queryInterface.removeColumn('users', 'promoAccessExpiresAt');
    await queryInterface.removeColumn('users', 'promoAccessType');
    console.log('Rollback completed successfully');
  } catch (error) {
    console.error('Rollback failed:', error);
    throw error;
  }
}

const command = process.argv[2];
if (command === 'down') {
  down().then(() => process.exit(0)).catch(() => process.exit(1));
} else {
  up().then(() => process.exit(0)).catch(() => process.exit(1));
}
