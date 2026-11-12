/**
 * Backfill: for every ID-verified user, pull the legal name off their ID
 * (Stripe Identity) and their cardholder name(s), save both, and print/CSV
 * the account-vs-ID-vs-card comparison.
 *
 *   npx ts-node --transpile-only src/scripts/syncIdentityNames.ts [out.csv]
 *   heroku run -a mcxchange node dist/scripts/syncIdentityNames.js
 *
 * Requires the add-identity-names migration to have run first.
 */
import fs from 'fs';
import { User } from '../models';
import { syncIdentityNames } from '../services/identityNameService';

const flag = (v: boolean | null) => (v === null ? '' : v ? 'yes' : 'NO');
const csv = (v: any) => `"${String(v ?? '').replace(/"/g, '""')}"`;

async function main() {
  const out = process.argv[2];
  const users: any[] = await User.findAll({ where: { identityVerified: true }, order: [['identityVerifiedAt', 'DESC']] });
  console.log(`Syncing ${users.length} verified user(s)...`);
  const rows: any[] = [];
  for (const u of users) {
    const c = await syncIdentityNames(u);
    rows.push({ id: u.id, email: u.email, role: u.role, verifiedAt: u.identityVerifiedAt, ...c });
  }
  const header = ['email', 'role', 'verifiedAt', 'accountName', 'idName', 'cardholderName', 'idMatchesAccount', 'cardMatchesId', 'cardMatchesAccount', 'id'];
  const lines = [header.join(','), ...rows.map((r) => [
    r.email, r.role, r.verifiedAt ? new Date(r.verifiedAt).toISOString().slice(0, 10) : '', r.accountName, r.idName, r.cardholderName,
    flag(r.idMatchesAccount), flag(r.cardMatchesId), flag(r.cardMatchesAccount), r.id,
  ].map(csv).join(','))];
  if (out) fs.writeFileSync(out, lines.join('\n') + '\n');
  else console.log(lines.join('\n'));
  const mism = rows.filter((r) => r.idMatchesAccount === false || r.cardMatchesId === false).length;
  console.log(`Done: ${rows.length} users, ${rows.filter((r) => r.idName).length} with ID name, ${rows.filter((r) => r.cardholderName).length} with card name, ${mism} with a mismatch.`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
