/**
 * Backfill: for every ID-verified user with a name on file from their ID,
 * keep their signup name and set the account name to the ID name. Prints
 * what doesn't line up (signup vs ID, card vs ID). Nothing is blocked.
 *
 *   npx ts-node --transpile-only src/scripts/adoptIdNames.ts [--dry-run]
 *
 * Requires the add-signup-name migration.
 */
import { User } from '../models';
import { adoptIdName, buildNameCheck, idFullName, nameMismatches } from '../services/identityNameService';

async function main() {
  const dry = process.argv.includes('--dry-run');
  const users: any[] = await User.findAll({ where: { identityVerified: true } });
  let renamed = 0, flagged = 0, noId = 0;
  for (const u of users) {
    if (!idFullName(u)) { noId++; continue; }
    const before = u.name;
    const check = dry ? buildNameCheck(u) : await adoptIdName(u);
    if (!dry && u.name !== before) { renamed++; console.log(`RENAMED ${u.email}: "${before}" -> "${u.name}"`); }
    const problems = nameMismatches(check);
    if (problems.length) { flagged++; console.log(`MISMATCH ${u.email} (${u.role}): ${problems.join('; ')}`); }
  }
  console.log(`${dry ? '[dry run] ' : ''}verified=${users.length} renamed=${renamed} withMismatch=${flagged} noIdNameOnFile=${noId}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
