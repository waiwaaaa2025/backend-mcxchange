/**
 * Migration: users.signupName — the name typed at signup, kept when the
 * account name is replaced with the legal name from the government ID
 * (Stripe Identity). Shown to admins and in dispute evidence.
 *
 * Run BEFORE deploying the code that uses it (the User model selects every
 * column, so a missing column breaks login):
 *   JAWSDB_URL=... npx ts-node src/migrations/add-signup-name.ts
 *
 * No index (users table is at MySQL's 64-index limit).
 */
import { DataTypes } from 'sequelize';
import sequelize from '../config/database';

async function up(): Promise<void> {
  const qi = sequelize.getQueryInterface();
  const desc = await qi.describeTable('users');
  if (desc.signupName) {
    console.log('signupName already exists, skipping');
    return;
  }
  await qi.addColumn('users', 'signupName', { type: DataTypes.STRING(255), allowNull: true });
  console.log('Added users.signupName');
}

async function down(): Promise<void> {
  await sequelize.getQueryInterface().removeColumn('users', 'signupName');
}

if (require.main === module) {
  up().then(() => { console.log('Done'); process.exit(0); })
    .catch((e) => { console.error('Migration failed:', e); process.exit(1); });
}

export { up, down };
