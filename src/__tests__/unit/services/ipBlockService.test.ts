const findOne = jest.fn();
jest.mock('../../../models', () => ({ BlockedIp: { findOne, findAll: jest.fn().mockResolvedValue([]) } }));

import { ipBlockService } from '../../../services/ipBlockService';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3600 * 1000);
const hoursAhead = (h: number) => new Date(Date.now() + h * 3600 * 1000);

beforeEach(() => findOne.mockReset());

describe('autoBlockExempt', () => {
  it('never auto-blocks an IP an admin has used', async () => {
    expect(await ipBlockService.autoBlockExempt('1.2.3.4', new Set(['1.2.3.4']))).toMatch(/admin/);
    expect(findOne).not.toHaveBeenCalled();
  });

  it('leaves an IP alone after an admin unblocked it', async () => {
    findOne.mockResolvedValue({ status: 'UNBLOCKED', updatedAt: hoursAgo(48) });
    expect(await ipBlockService.autoBlockExempt('1.2.3.4', new Set())).toMatch(/unblocked/);
  });

  it('may re-block once the unblock is a month old', async () => {
    findOne.mockResolvedValue({ status: 'UNBLOCKED', updatedAt: hoursAgo(31 * 24) });
    expect(await ipBlockService.autoBlockExempt('1.2.3.4', new Set())).toBeNull();
  });

  it('skips an IP that is already blocked, but re-blocks a lapsed one', async () => {
    findOne.mockResolvedValue({ status: 'BLOCKED', expiresAt: hoursAhead(5), updatedAt: hoursAgo(1) });
    expect(await ipBlockService.autoBlockExempt('1.2.3.4', new Set())).toBe('already blocked');
    findOne.mockResolvedValue({ status: 'BLOCKED', expiresAt: hoursAgo(1), updatedAt: hoursAgo(200) });
    expect(await ipBlockService.autoBlockExempt('1.2.3.4', new Set())).toBeNull();
  });
});
