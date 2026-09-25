const isBlocked = jest.fn();
const recordHit = jest.fn();
const findByPk = jest.fn();
jest.mock('../../../services/ipBlockService', () => ({ ipBlockService: { isBlocked, recordHit } }));
jest.mock('../../../models', () => ({ User: { findByPk }, UserRole: { ADMIN: 'ADMIN' } }));
jest.mock('../../../config', () => ({ config: { jwt: { secret: 'test-secret' } } }));

import jwt from 'jsonwebtoken';
import { blockFlaggedIps } from '../../../middleware/ipBlock';

const tokenFor = (id: string) => `Bearer ${jwt.sign({ id }, 'test-secret')}`;

function run(req: any) {
  const res: any = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
  const next = jest.fn();
  return blockFlaggedIps({ path: '/api/listings', headers: {}, ...req }, res, next).then(() => ({ res, next }));
}

beforeEach(() => {
  isBlocked.mockReset();
  recordHit.mockReset();
  findByPk.mockReset();
});

describe('blockFlaggedIps', () => {
  it('refuses an anonymous request from a blocked IP', async () => {
    isBlocked.mockResolvedValue(true);
    const { res, next } = await run({ ip: '203.0.113.9' });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ code: 'IP_BLOCKED' }));
    expect(recordHit).toHaveBeenCalledWith('203.0.113.9');
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a signed-in non-admin from a blocked IP', async () => {
    isBlocked.mockResolvedValue(true);
    findByPk.mockResolvedValue({ role: 'BUYER', status: 'ACTIVE' });
    const { res, next } = await run({ ip: '203.0.113.9', path: '/api/buyer/dashboard', headers: { authorization: tokenFor('u1') } });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('lets an admin through from a blocked IP', async () => {
    isBlocked.mockResolvedValue(true);
    findByPk.mockResolvedValue({ role: 'ADMIN', status: 'ACTIVE' });
    const { res, next } = await run({ ip: '203.0.113.9', headers: { authorization: tokenFor('a1') } });
    expect(next).toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
  });

  it('does not trust a forged token claiming admin', async () => {
    isBlocked.mockResolvedValue(true);
    const forged = `Bearer ${jwt.sign({ id: 'a1', role: 'ADMIN' }, 'wrong-secret')}`;
    const { res } = await run({ ip: '203.0.113.9', headers: { authorization: forged } });
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('keeps login reachable from a blocked IP', async () => {
    isBlocked.mockResolvedValue(true);
    const { next } = await run({ ip: '203.0.113.9', path: '/api/auth/login' });
    expect(next).toHaveBeenCalled();
  });

  it('keys on the address the proxy saw, not a forged X-Forwarded-For', async () => {
    isBlocked.mockImplementation(async (ip: string) => ip === '203.0.113.9');
    const { res } = await run({ ip: '203.0.113.9', headers: { 'x-forwarded-for': '9.9.9.9, 203.0.113.9' } });
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('refuses the Highway bot from any IP', async () => {
    isBlocked.mockResolvedValue(false);
    const { res, next } = await run({ ip: '198.51.100.7', headers: { 'user-agent': 'Highway-Domilea-Monitor/1.0' } });
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('lets an ordinary browser through from an unblocked IP without a DB lookup', async () => {
    isBlocked.mockResolvedValue(false);
    const { next } = await run({ ip: '198.51.100.7', headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/154.0.0.0' } });
    expect(next).toHaveBeenCalled();
    expect(findByPk).not.toHaveBeenCalled();
  });

  it('fails open if the block list cannot be read', async () => {
    isBlocked.mockRejectedValue(new Error('db down'));
    const { next } = await run({ ip: '203.0.113.9' });
    expect(next).toHaveBeenCalled();
  });
});
