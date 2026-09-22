/**
 * Guards the two query-param rules that keep the listing feed from being a
 * bulk-export endpoint: the page-size clamp, and who may match the masked
 * identity columns by substring.
 */

jest.mock('../../../services/listingService', () => ({
  listingService: { getListings: jest.fn() },
}));
jest.mock('../../../models', () => ({
  UnlockedListing: { findAll: jest.fn().mockResolvedValue([]), findOne: jest.fn() },
  Listing: { findByPk: jest.fn() },
  Subscription: { findOne: jest.fn() },
  UserRole: { ADMIN: 'ADMIN', SELLER: 'SELLER', BUYER: 'BUYER' },
  SubscriptionPlan: { PREMIUM: 'PREMIUM', ENTERPRISE: 'ENTERPRISE', VIP_ACCESS: 'VIP_ACCESS' },
  SubscriptionStatus: { ACTIVE: 'ACTIVE' },
  AuthorityType: { MOTOR_CARRIER: 'MOTOR_CARRIER', BROKER: 'BROKER' },
}));
jest.mock('../../../services/buyerPreferencesService', () => ({
  buyerPreferencesService: { getByUserId: jest.fn().mockResolvedValue(null) },
}));
jest.mock('../../../services/fmcsaService', () => ({ fmcsaService: {} }));
jest.mock('../../../services/carrierDataService', () => ({ carrierDataService: {} }));
jest.mock('../../../utils/accessLog', () => ({ recordAccess: jest.fn() }));

import { getListings } from '../../../controllers/listingController';
import { listingService } from '../../../services/listingService';

const mockedGetListings = listingService.getListings as jest.Mock;

// asyncHandler swallows the promise rather than returning it, so let the
// microtask queue drain before reading what the controller passed down.
async function run(query: Record<string, string>, user?: { id: string; role: string }) {
  const req: any = { query, user };
  const res: any = { json: jest.fn(), status: jest.fn().mockReturnThis() };
  (getListings as any)(req, res, jest.fn());
  await new Promise((resolve) => setImmediate(resolve));
  const calls = mockedGetListings.mock.calls;
  return calls[calls.length - 1][0];
}

beforeEach(() => {
  mockedGetListings.mockReset();
  mockedGetListings.mockResolvedValue({ listings: [], pagination: {} });
});

describe('listing feed query params', () => {
  it('clamps an oversized limit instead of pulling the whole table', async () => {
    expect((await run({ limit: '10000' })).limit).toBe(100);
  });

  it('honours a reasonable limit as asked', async () => {
    expect((await run({ limit: '25' })).limit).toBe(25);
  });

  it('defaults to 20 when no limit is given', async () => {
    expect((await run({})).limit).toBe(20);
  });

  it('refuses a zero or negative limit, which would page forever', async () => {
    expect((await run({ limit: '0' })).limit).toBe(20);
    expect((await run({ limit: '-5' })).limit).toBe(1);
  });

  it('refuses a negative page, which would make the offset negative', async () => {
    expect((await run({ page: '-3' })).page).toBe(1);
  });

  it('does not let an anonymous caller substring-match the masked columns', async () => {
    expect((await run({ search: '674' })).allowIdentitySubstringSearch).toBe(false);
  });

  it('does not let an ordinary buyer substring-match them either', async () => {
    const params = await run({ search: '674' }, { id: 'u1', role: 'BUYER' });
    expect(params.allowIdentitySubstringSearch).toBe(false);
  });

  it('does not let a seller account substring-match them', async () => {
    const params = await run({ search: '674' }, { id: 'u2', role: 'SELLER' });
    expect(params.allowIdentitySubstringSearch).toBe(false);
  });

  it('allows admins the substring search', async () => {
    const params = await run({ search: '674' }, { id: 'a1', role: 'ADMIN' });
    expect(params.allowIdentitySubstringSearch).toBe(true);
  });
});
