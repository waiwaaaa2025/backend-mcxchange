/**
 * Migration: store the name read off the government ID (Stripe Identity
 * verified_outputs) and the cardholder name(s) on the user, so admins can
 * compare them with the account name and quote them in dispute evidence.
 *
 * Run manually (sync({force:false}) does not add columns on prod):
 *   npx ts-node src/migrations/add-identity-names.ts
 *   or on Heroku: heroku run -a mcxchange node dist/migrations/add-identity-names.js
 *
 * No indexes (users table is at MySQL's 64-index limit).
 */
import { DataTypes } from 'sequelize';
import sequelize from '../config/database';

const COLUMNS: Record<string, number> = {
  identityFirstName: 100,
  identityLastName: 100,
  cardholderName: 255,
};

async function up(): Promise<void> {
  const qi = sequelize.getQueryInterface();
  const desc = await qi.describeTable('users');
  for (const [col, len] of Object.entries(COLUMNS)) {
    if (desc[col]) {
      console.log(`${col} already exists, skipping`);
      continue;
    }
    await qi.addColumn('users', col, { type: DataTypes.STRING(len), allowNull: true });
    console.log(`Added users.${col}`);
  }
}

async function down(): Promise<void> {
  const qi = sequelize.getQueryInterface();
  for (const col of Object.keys(COLUMNS)) await qi.removeColumn('users', col);
}

if (require.main === module) {
  up().then(() => { console.log('Done'); process.exit(0); })
    .catch((e) => { console.error('Migration failed:', e); process.exit(1); });
}

export { up, down };
