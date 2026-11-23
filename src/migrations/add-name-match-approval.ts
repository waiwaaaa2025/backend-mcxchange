/**
 * Migration: users.nameMatchApprovedAt — set when an admin approves a buyer
 * whose account name, ID name and cardholder name don't match, so the
 * name-match gate on unlocking listings lets them through.
 *
 * Run manually BEFORE deploying the code that uses it (the User model selects
 * every column, so a missing column breaks login):
 *   npx ts-node src/migrations/add-name-match-approval.ts
 *   or on Heroku: heroku run -a mcxchange node dist/migrations/add-name-match-approval.js
 *
 * No index (users table is at MySQL's 64-index limit).
 */
import { DataTypes } from 'sequelize';
import sequelize from '../config/database';

async function up(): Promise<void> {
  const qi = sequelize.getQueryInterface();
  const desc = await qi.describeTable('users');
  if (desc.nameMatchApprovedAt) {
    console.log('nameMatchApprovedAt already exists, skipping');
    return;
  }
  await qi.addColumn('users', 'nameMatchApprovedAt', { type: DataTypes.DATE, allowNull: true });
  console.log('Added users.nameMatchApprovedAt');
}

async function down(): Promise<void> {
  await sequelize.getQueryInterface().removeColumn('users', 'nameMatchApprovedAt');
}

if (require.main === module) {
  up().then(() => { console.log('Done'); process.exit(0); })
    .catch((e) => { console.error('Migration failed:', e); process.exit(1); });
}

export { up, down };
