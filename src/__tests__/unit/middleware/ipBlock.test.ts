const isBlocked = jest.fn();
const recordHit = jest.fn();
jest.mock('../../../services/ipBlockService', () => ({ ipBlockService: { isBlocked, recordHit } }));

import { blockFlaggedIps } from '../../../middleware/ipBlock';

function run(req: any) {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const next = jest.fn();
  return blockFlaggedIps(req, res, next).then(() => ({ res, next }));
}

beforeEach(() => {
  isBlocked.mockReset();
  recordHit.mockReset();
});

describe('blockFlaggedIps', () => {
  it('refuses an anonymous read from a blocked IP', async () => {
    isBlocked.mockResolvedValue(true);
    const { res, next } = await run({ ip: '203.0.113.9', headers: {} });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'IP_BLOCKED' }));
    expect(recordHit).toHaveBeenCalledWith('203.0.113.9');
    expect(next).not.toHaveBeenCalled();
  });

  it('lets a signed-in user through from the same IP', async () => {
    isBlocked.mockResolvedValue(true);
    const { res, next } = await run({ ip: '203.0.113.9', headers: {}, user: { id: 'u1' } });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(isBlocked).not.toHaveBeenCalled();
  });

  it('keys on the address the proxy saw, not a forged X-Forwarded-For', async () => {
    isBlocked.mockImplementation(async (ip: string) => ip === '203.0.113.9');
    const { res } = await run({ ip: '203.0.113.9', headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.9' } });
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('fails open if the block list cannot be read', async () => {
    isBlocked.mockRejectedValue(new Error('db down'));
    const { next } = await run({ ip: '203.0.113.9', headers: {} });
    expect(next).toHaveBeenCalled();
  });
});
