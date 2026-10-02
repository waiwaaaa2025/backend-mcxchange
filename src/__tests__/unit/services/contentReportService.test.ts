const ContentReport = {
  findOne: jest.fn(),
  findByPk: jest.fn(),
  count: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
};
const Listing = { findAll: jest.fn(), findByPk: jest.fn() };
const Truck = { findAll: jest.fn(), findByPk: jest.fn() };
const AdminAction = { create: jest.fn() };
const User = { findByPk: jest.fn().mockResolvedValue({ name: 'Reporter', email: 'r@x.com' }) };
const PlatformSetting = { findOne: jest.fn().mockResolvedValue(null) };
const blockUser = jest.fn();

jest.mock('../../../models', () => ({
  ContentReport,
  Listing,
  Truck,
  AdminAction,
  User,
  PlatformSetting,
  ContentReportStatus: { OPEN: 'OPEN', DISMISSED: 'DISMISSED', ACTIONED: 'ACTIONED' },
  ContentReportTarget: { LISTING: 'LISTING', EQUIPMENT: 'EQUIPMENT' },
  ListingStatus: { SUSPENDED: 'SUSPENDED' },
}));
jest.mock('../../../services/adminService', () => ({ adminService: { blockUser } }));
jest.mock('../../../services/emailService', () => ({ emailService: { sendEmail: jest.fn().mockResolvedValue(true) } }));

import { contentReportService } from '../../../services/contentReportService';

const LISTING_ID = '11111111-1111-4111-8111-111111111111';
const listingRow = { id: LISTING_ID, mcNumber: '123456', title: 'Dry van', sellerId: 'seller-1', status: 'ACTIVE' };

beforeEach(() => {
  jest.clearAllMocks();
  Listing.findAll.mockResolvedValue([listingRow]);
  ContentReport.findOne.mockResolvedValue(null);
  ContentReport.count.mockResolvedValue(0);
  ContentReport.create.mockImplementation(async (d: any) => ({ id: 'rep-1', ...d }));
  ContentReport.update.mockResolvedValue([2]);
});

describe('createReport', () => {
  it('files a report against the listing owner', async () => {
    const { duplicate } = await contentReportService.createReport('buyer-1', {
      targetType: 'listing', targetId: LISTING_ID, reason: 'FRAUD',
    });
    expect(duplicate).toBe(false);
    expect(ContentReport.create).toHaveBeenCalledWith(
      expect.objectContaining({ reporterId: 'buyer-1', targetType: 'LISTING', reportedUserId: 'seller-1', reason: 'FRAUD' })
    );
  });

  it('refuses reports on your own listing', async () => {
    await expect(
      contentReportService.createReport('seller-1', { targetType: 'LISTING', targetId: LISTING_ID, reason: 'FRAUD' })
    ).rejects.toThrow(/own listing/);
  });

  it('requires details for OTHER and rejects unknown reasons', async () => {
    await expect(
      contentReportService.createReport('buyer-1', { targetType: 'LISTING', targetId: LISTING_ID, reason: 'OTHER' })
    ).rejects.toThrow(/what is wrong/);
    await expect(
      contentReportService.createReport('buyer-1', { targetType: 'LISTING', targetId: LISTING_ID, reason: 'NOPE' })
    ).rejects.toThrow(/reason/);
  });

  it('does not duplicate an open report from the same user', async () => {
    ContentReport.findOne.mockResolvedValue({ id: 'existing' });
    const { duplicate } = await contentReportService.createReport('buyer-1', {
      targetType: 'LISTING', targetId: LISTING_ID, reason: 'FRAUD',
    });
    expect(duplicate).toBe(true);
    expect(ContentReport.create).not.toHaveBeenCalled();
  });

  it('enforces the daily limit', async () => {
    ContentReport.count.mockResolvedValue(10);
    await expect(
      contentReportService.createReport('buyer-1', { targetType: 'LISTING', targetId: LISTING_ID, reason: 'FRAUD' })
    ).rejects.toThrow(/daily report limit/);
  });
});

describe('admin decisions', () => {
  const report = { id: 'rep-1', targetType: 'LISTING', targetId: LISTING_ID, reportedUserId: 'seller-1', reason: 'FRAUD' };

  it('dismiss closes every open report on the target', async () => {
    ContentReport.findByPk.mockResolvedValue(report);
    const { closed } = await contentReportService.dismiss('rep-1', 'admin-1', 'looks fine');
    expect(closed).toBe(2);
    expect(ContentReport.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'DISMISSED', resolvedBy: 'admin-1', adminNotes: 'looks fine' }),
      { where: { targetType: 'LISTING', targetId: LISTING_ID, status: 'OPEN' } }
    );
    expect(AdminAction.create).toHaveBeenCalledWith(expect.objectContaining({ action: 'DISMISS_REPORT' }));
  });

  it('take down suspends the listing and blocks the seller', async () => {
    const update = jest.fn();
    ContentReport.findByPk.mockResolvedValue(report);
    Listing.findByPk.mockResolvedValue({ update });
    const { resolution } = await contentReportService.takeAction('rep-1', 'admin-1', { takeDown: true, blockSeller: true });
    expect(update).toHaveBeenCalledWith({ status: 'SUSPENDED' });
    expect(blockUser).toHaveBeenCalledWith('seller-1', 'admin-1', expect.stringContaining('Fraud'));
    expect(resolution).toBe('TAKEN_DOWN_AND_BLOCKED');
  });

  it('refuses to take down equipment attached to an MC listing', async () => {
    ContentReport.findByPk.mockResolvedValue({ ...report, targetType: 'EQUIPMENT' });
    Truck.findByPk.mockResolvedValue({ listingId: LISTING_ID, update: jest.fn() });
    await expect(
      contentReportService.takeAction('rep-1', 'admin-1', { takeDown: true })
    ).rejects.toThrow(/MC listing/);
    expect(ContentReport.update).not.toHaveBeenCalled();
  });

  it('requires at least one action', async () => {
    await expect(contentReportService.takeAction('rep-1', 'admin-1', {})).rejects.toThrow(/at least one/);
  });
});
