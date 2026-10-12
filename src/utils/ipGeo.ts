import { isIP } from 'net';
import logger from './logger';

export interface IpGeo {
  city?: string;
  region?: string;
  country?: string;
  countryCode?: string;
  isp?: string;
  // ip-api only: VPN/proxy/datacenter address — a shared IP there means little.
  proxy?: boolean;
  hosting?: boolean;
}

const TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map<string, { geo: IpGeo | null; at: number }>();

function isPrivate(ip: string): boolean {
  return /^(10\.|127\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|::1$|f[cd]|fe80)/i.test(ip);
}

async function fetchJson(url: string, init?: RequestInit): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ip-api batch: up to 100 IPs per call, includes proxy/hosting flags.
async function fromIpApi(ips: string[]): Promise<Map<string, IpGeo>> {
  const out = new Map<string, IpGeo>();
  for (let i = 0; i < ips.length; i += 100) {
    const rows = await fetchJson(
      'http://ip-api.com/batch?fields=status,query,city,regionName,country,countryCode,isp,proxy,hosting',
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(ips.slice(i, i + 100)) }
    );
    for (const r of rows || []) {
      if (r.status !== 'success') continue;
      out.set(r.query, {
        city: r.city, region: r.regionName, country: r.country, countryCode: r.countryCode,
        isp: r.isp, proxy: !!r.proxy, hosting: !!r.hosting,
      });
    }
  }
  return out;
}

// ipwho.is fallback: one IP per call.
async function fromIpWho(ips: string[]): Promise<Map<string, IpGeo>> {
  const out = new Map<string, IpGeo>();
  await Promise.all(ips.map(async (ip) => {
    try {
      const r = await fetchJson(`https://ipwho.is/${encodeURIComponent(ip)}?fields=success,city,region,country,country_code,connection`);
      if (!r?.success) return;
      out.set(ip, { city: r.city, region: r.region, country: r.country, countryCode: r.country_code, isp: r.connection?.isp });
    } catch { /* leave unresolved */ }
  }));
  return out;
}

// Geolocate IPs, cached for a day. Never throws — unresolved IPs map to null.
export async function geolocateIps(ips: string[]): Promise<Record<string, IpGeo | null>> {
  const result: Record<string, IpGeo | null> = {};
  const now = Date.now();
  const todo: string[] = [];
  for (const ip of new Set(ips)) {
    if (!isIP(ip) || isPrivate(ip)) { result[ip] = null; continue; }
    const hit = cache.get(ip);
    if (hit && now - hit.at < TTL_MS) result[ip] = hit.geo;
    else todo.push(ip);
  }
  if (todo.length === 0) return result;

  let found = new Map<string, IpGeo>();
  try {
    found = await fromIpApi(todo);
  } catch (error) {
    logger.warn('ip-api geolocation failed, falling back to ipwho.is', { error });
  }
  const missing = todo.filter((ip) => !found.has(ip));
  if (missing.length) {
    for (const [ip, geo] of await fromIpWho(missing)) found.set(ip, geo);
  }
  for (const ip of todo) {
    const geo = found.get(ip) ?? null;
    if (geo) cache.set(ip, { geo, at: now });
    result[ip] = geo;
  }
  return result;
}
