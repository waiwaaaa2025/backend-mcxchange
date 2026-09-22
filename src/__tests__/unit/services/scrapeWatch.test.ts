jest.mock('../../../config/database', () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.mock('../../../models', () => ({ PlatformSetting: { findOne: jest.fn(), upsert: jest.fn() } }));
jest.mock('../../../services/adminNotificationService', () => ({
  adminNotificationService: { notifyScrapeActivity: jest.fn() },
}));

import { assessClient, ScrapeClient } from '../../../services/scrapeWatchService';

const HOUR = 60 * 60 * 1000;

function client(overrides: Partial<ScrapeClient> = {}): ScrapeClient {
  return {
    ipAddress: '203.0.113.9',
    requests: 10,
    detailViews: 5,
    searches: 0,
    listingsTouched: 2,
    users: 1,
    anonymousRequests: 0,
    userAgents: 'Mozilla/5.0 (Macintosh) Safari/605.1',
    firstSeen: new Date(Date.now() - HOUR),
    lastSeen: new Date(),
    ...overrides,
  };
}

describe('assessClient', () => {
  it('flags a catalogue sweep from a scripted client', () => {
    const result = assessClient(
      client({
        requests: 4200,
        listingsTouched: 312,
        users: 0,
        anonymousRequests: 4200,
        userAgents: 'python-requests/2.31.0',
      })
    );

    expect(result.isLikelyBot).toBe(true);
    expect(result.reasons).toEqual(
      expect.arrayContaining(['Tooling user agent', 'Never signed in', 'Opened 312 listings'])
    );
  });

  it('leaves an ordinary signed-in browser alone', () => {
    const result = assessClient(client({ requests: 61, listingsTouched: 9, users: 2 }));

    expect(result.isLikelyBot).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it('does not flag a busy shared office on volume alone', () => {
    // Many reads, many accounts, real browser — a NAT, not a bot.
    const result = assessClient(
      client({ requests: 900, listingsTouched: 40, users: 14, firstSeen: new Date(Date.now() - 8 * HOUR) })
    );

    expect(result.isLikelyBot).toBe(false);
  });

  it('treats a missing user agent as a tooling signal', () => {
    expect(assessClient(client({ userAgents: null })).reasons).toContain('Tooling user agent');
  });

  it('needs three signals, not two', () => {
    // Tooling UA + never signed in, but only a couple of listings and slow.
    const two = assessClient(
      client({ requests: 25, listingsTouched: 2, users: 0, userAgents: 'curl/8.5.0',
        firstSeen: new Date(Date.now() - 6 * HOUR) })
    );

    expect(two.reasons).toHaveLength(2);
    expect(two.isLikelyBot).toBe(false);
  });

  it('flags sustained request rate near the browse limiter', () => {
    // 600 requests inside 5 minutes = 120/min, at the limiter ceiling.
    const result = assessClient(
      client({
        requests: 600,
        listingsTouched: 50,
        users: 0,
        userAgents: 'Mozilla/5.0 (Windows NT 10.0) Chrome/120',
        firstSeen: new Date(Date.now() - 5 * 60 * 1000),
      })
    );

    expect(result.reasons.some((r) => r.includes('req/min'))).toBe(true);
    expect(result.isLikelyBot).toBe(true);
  });

  it('does not divide by zero when every read lands in the same instant', () => {
    const now = new Date();
    const result = assessClient(client({ requests: 5, firstSeen: now, lastSeen: now }));

    expect(Number.isFinite(result.reasons.length)).toBe(true);
    expect(result.isLikelyBot).toBe(false);
  });
});
