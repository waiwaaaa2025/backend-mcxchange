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
import { adoptIdName, adoptSkipReason, buildNameCheck, idFullName, nameMismatches } from '../services/identityNameService';

async function main() {
  const dry = process.argv.includes('--dry-run');
  const users: any[] = await User.findAll({ where: { identityVerified: true } });
  let renamed = 0, flagged = 0, noId = 0, skipped = 0;
  for (const u of users) {
    if (!idFullName(u)) { noId++; continue; }
    const before = u.name;
    const skip = await adoptSkipReason(u);
    if (skip) { skipped++; console.log(`SKIP ${u.email}: ${skip} (account "${u.name}", ID "${idFullName(u)}")`); }
    const check = dry || skip ? buildNameCheck(u) : await adoptIdName(u);
    if (dry && !skip) {
      const target = String(idFullName(u)).toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_m: string, p: string, c: string) => p + c.toUpperCase());
      if (target !== before) { renamed++; console.log(`WOULD RENAME ${u.email}: "${before}" -> "${target}"`); }
    }
    if (!dry && u.name !== before) { renamed++; console.log(`RENAMED ${u.email}: "${before}" -> "${u.name}"`); }
    const problems = nameMismatches(check);
    if (problems.length) { flagged++; console.log(`MISMATCH ${u.email} (${u.role}): ${problems.join('; ')}`); }
  }
  console.log(`${dry ? '[dry run] ' : ''}verified=${users.length} renamed=${renamed} skipped=${skipped} withMismatch=${flagged} noIdNameOnFile=${noId}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
