import { QueryTypes } from 'sequelize';
import { isIP } from 'net';
import sequelize from '../config/database';
import { geolocateIps, IpGeo } from '../utils/ipGeo';

// Every place a signed-in user's IP is recorded. The filter goes inside each
// branch so the per-table ipAddress/userId indexes are used.
function ipEvents(where: string): string {
  return `
    SELECT userId, ipAddress, event, createdAt AS at FROM user_access_logs WHERE ${where}
    UNION ALL
    SELECT userId, ipAddress, 'SIGNUP', acceptedAt FROM user_terms_acceptances WHERE ${where}
    UNION ALL
    SELECT userId, ipAddress, 'CHECKOUT', acceptedAt FROM payment_consents WHERE ${where}
    UNION ALL
    SELECT userId, ipAddress, 'BROWSE', createdAt FROM listing_access_logs WHERE userId IS NOT NULL AND ${where}`;
}

interface UserRow { id: string; name: string; email: string; role: string; status: string; createdAt: Date }

export interface SharedUser extends UserRow { hits: number; lastSeen: Date }

export interface IpEntry {
  ip: string;
  events: string[];
  hits: number;
  firstSeen: Date;
  lastSeen: Date;
  geo: IpGeo | null;
  otherUsers: SharedUser[];
}

const MAX_USERS = 10;
const MAX_IPS_PER_USER = 50;

async function usersOnIps(ips: string[]): Promise<Map<string, SharedUser[]>> {
  const byIp = new Map<string, SharedUser[]>();
  if (ips.length === 0) return byIp;
  const rows = await sequelize.query<SharedUser & { ipAddress: string }>(
    `SELECT e.ipAddress, u.id, u.name, u.email, u.role, u.status, u.createdAt,
            COUNT(*) AS hits, MAX(e.at) AS lastSeen
       FROM (${ipEvents('ipAddress IN (:ips)')}) e
       JOIN users u ON u.id = e.userId
      GROUP BY e.ipAddress, u.id, u.name, u.email, u.role, u.status, u.createdAt
      ORDER BY lastSeen DESC`,
    { replacements: { ips }, type: QueryTypes.SELECT }
  );
  for (const { ipAddress, ...u } of rows) {
    const list = byIp.get(ipAddress) ?? [];
    list.push({ ...u, hits: Number(u.hits) });
    byIp.set(ipAddress, list);
  }
  return byIp;
}

export const ipLookupService = {
  // q is a name/email fragment (→ each matching user's IPs and who else used
  // them) or an IP address (→ every account seen on it).
  async lookup(q: string) {
    const query = q.trim();
    if (isIP(query)) {
      const [users, geo] = await Promise.all([usersOnIps([query]), geolocateIps([query])]);
      return { mode: 'ip' as const, ip: query, geo: geo[query] ?? null, users: users.get(query) ?? [] };
    }

    const like = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    const users = await sequelize.query<UserRow>(
      `SELECT id, name, email, role, status, createdAt FROM users
        WHERE email LIKE :like OR name LIKE :like
        ORDER BY (email = :exact) DESC, createdAt DESC LIMIT ${MAX_USERS}`,
      { replacements: { like, exact: query }, type: QueryTypes.SELECT }
    );
    if (users.length === 0) return { mode: 'user' as const, users: [] };

    const ipRows = await sequelize.query<{ userId: string; ipAddress: string; events: string; hits: number; firstSeen: Date; lastSeen: Date }>(
      `SELECT userId, ipAddress, GROUP_CONCAT(DISTINCT event) AS events, COUNT(*) AS hits,
              MIN(at) AS firstSeen, MAX(at) AS lastSeen
         FROM (${ipEvents('userId IN (:ids) AND ipAddress IS NOT NULL')}) e
        GROUP BY userId, ipAddress
        ORDER BY lastSeen DESC`,
      { replacements: { ids: users.map((u) => u.id) }, type: QueryTypes.SELECT }
    );

    const perUser = new Map<string, typeof ipRows>();
    for (const r of ipRows) {
      const list = perUser.get(r.userId) ?? [];
      if (list.length < MAX_IPS_PER_USER) list.push(r);
      perUser.set(r.userId, list);
    }
    const allIps = [...new Set([...perUser.values()].flat().map((r) => r.ipAddress))];
    const [shared, geo] = await Promise.all([usersOnIps(allIps), geolocateIps(allIps)]);

    return {
      mode: 'user' as const,
      users: users.map((user) => ({
        user,
        ips: (perUser.get(user.id) ?? []).map((r): IpEntry => ({
          ip: r.ipAddress,
          events: String(r.events || '').split(',').filter(Boolean),
          hits: Number(r.hits),
          firstSeen: r.firstSeen,
          lastSeen: r.lastSeen,
          geo: geo[r.ipAddress] ?? null,
          otherUsers: (shared.get(r.ipAddress) ?? []).filter((u) => u.id !== user.id),
        })),
      })),
    };
  },
};
