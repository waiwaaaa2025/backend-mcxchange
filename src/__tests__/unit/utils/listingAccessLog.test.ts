const mockCreate = jest.fn();
const mockDestroy = jest.fn();

jest.mock('../../../models', () => ({
  ListingAccessLog: { create: mockCreate, destroy: mockDestroy },
}));

import { recordListingAccess, purgeOldListingAccessLogs } from '../../../utils/listingAccessLog';

function req(overrides: any = {}): any {
  return {
    // The client wrote the first entry; Heroku appended the second, which is
    // what Express (trust proxy = 1) resolves req.ip to.
    headers: { 'user-agent': 'curl/8.5.0', 'x-forwarded-for': '9.9.9.9, 203.0.113.9' },
    ip: '203.0.113.9',
    ...overrides,
  };
}

beforeEach(() => {
  mockCreate.mockReset();
  mockCreate.mockResolvedValue({});
  mockDestroy.mockReset();
  mockDestroy.mockResolvedValue(0);
});

describe('recordListingAccess', () => {
  it('records the address the proxy saw, not the one the client claims', () => {
    recordListingAccess(req(), 'BROWSE');

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ ipAddress: '203.0.113.9', userAgent: 'curl/8.5.0', event: 'BROWSE' })
    );
  });

  it('records anonymous reads, which is the traffic we most want to see', () => {
    recordListingAccess(req(), 'DETAIL', { listingId: 'l1' });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: null, listingId: 'l1', event: 'DETAIL' })
    );
  });

  it('attributes the read when the caller is signed in', () => {
    recordListingAccess(req(), 'SEARCH', { userId: 'u1', detail: 'q=674 n=0' });

    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', event: 'SEARCH', detail: 'q=674 n=0' })
    );
  });

  it('truncates a search term to the column width', () => {
    recordListingAccess(req(), 'SEARCH', { detail: 'x'.repeat(400) });

    expect(mockCreate.mock.calls[0][0].detail).toHaveLength(255);
  });

  it('never throws when the write fails — it observes the request, it does not gate it', async () => {
    mockCreate.mockRejectedValue(new Error('db down'));

    expect(() => recordListingAccess(req(), 'BROWSE')).not.toThrow();
    // Let the rejection settle so it cannot surface as an unhandled rejection.
    await new Promise((resolve) => setImmediate(resolve));
  });
});

describe('purgeOldListingAccessLogs', () => {
  it('deletes only rows past the retention window', async () => {
    await purgeOldListingAccessLogs();

    const where = mockDestroy.mock.calls[0][0].where;
    // The operator key is a Symbol (Op.lt), so it is invisible to Object.values.
    const opKey = Object.getOwnPropertySymbols(where.createdAt)[0];
    const cutoff = where.createdAt[opKey] as Date;
    const daysAgo = (Date.now() - cutoff.getTime()) / (24 * 60 * 60 * 1000);

    expect(Math.round(daysAgo)).toBe(90);
  });
});
