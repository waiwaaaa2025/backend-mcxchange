import { Op } from 'sequelize';
import {
  AdminAction,
  ContentReport,
  ContentReportStatus,
  ContentReportTarget,
  Listing,
  ListingStatus,
  PlatformSetting,
  Truck,
  User,
} from '../models';
import { BadRequestError, NotFoundError } from '../middleware/errorHandler';
import { getPaginationInfo } from '../utils/helpers';
import { adminService } from './adminService';
import { emailService } from './emailService';
import { config } from '../config';
import logger from '../utils/logger';

/**
 * User-submitted reports on MC listings and equipment items.
 * Admin decisions (dismiss / take action) apply to every OPEN report on the
 * same target, so one bad listing reported five times is cleared in one click.
 */

export const REPORT_REASONS: Record<string, string> = {
  FRAUD: 'Fraud or scam',
  FAKE_DOCUMENTS: 'Fake or altered documents',
  MISREPRESENTED: 'Misleading or inaccurate details',
  STOLEN_IDENTITY: 'Not the real owner / stolen identity',
  ALREADY_SOLD: 'Already sold or unavailable',
  OFF_PLATFORM: 'Asked to deal off-platform',
  OTHER: 'Other',
};

// Reasons that land at the top of the admin queue.
const CRITICAL_REASONS = new Set(['FRAUD', 'FAKE_DOCUMENTS', 'STOLEN_IDENTITY']);

const DAILY_REPORT_LIMIT = 10;
const TARGET_TYPES: string[] = Object.values(ContentReportTarget);

interface TargetSummary {
  label: string;
  ownerId: string | null;
  status: string | null;
  publicUrl: string;
  adminUrl: string | null;
  attachedToListingId?: string | null;
}

const equipmentLabel = (t: Truck) =>
  t.equipmentType === 'PART'
    ? t.name || t.partNumber || 'Part'
    : [t.year, t.make, t.model].filter(Boolean).join(' ') || t.equipmentType;

async function loadTargets(type: string, ids: string[]): Promise<Map<string, TargetSummary>> {
  const map = new Map<string, TargetSummary>();
  if (ids.length === 0) return map;

  if (type === ContentReportTarget.LISTING) {
    const listings = await Listing.findAll({
      where: { id: ids },
      attributes: ['id', 'mcNumber', 'title', 'sellerId', 'status'],
      paranoid: false,
    });
    for (const l of listings) {
      map.set(l.id, {
        label: `MC #${l.mcNumber}${l.title ? ` — ${l.title}` : ''}`,
        ownerId: l.sellerId,
        status: l.status,
        publicUrl: `/mc/${l.id}`,
        adminUrl: `/admin/listing/${l.id}`,
      });
    }
  } else {
    const trucks = await Truck.findAll({
      where: { id: ids },
      include: [{ model: Listing, as: 'listing', attributes: ['id', 'sellerId', 'status'], required: false }],
    });
    for (const t of trucks) {
      map.set(t.id, {
        label: equipmentLabel(t),
        ownerId: t.listing ? t.listing.sellerId : t.sellerId ?? null,
        status: t.listing ? t.listing.status : t.status,
        publicUrl: `/equipment/${t.id}`,
        adminUrl: t.listing ? `/admin/listing/${t.listing.id}` : null,
        attachedToListingId: t.listingId,
      });
    }
  }
  return map;
}

async function notifyAdmins(report: ContentReport, target: TargetSummary, reporter: User | null) {
  try {
    const enabled = await PlatformSetting.findOne({ where: { key: 'notify_reports' } });
    if (enabled && enabled.value !== 'true') return;

    const emailsSetting = await PlatformSetting.findOne({ where: { key: 'admin_notification_emails' } });
    const emails = (emailsSetting?.value || 'support@domilea.com')
      .split(',')
      .map((e: string) => e.trim())
      .filter((e: string) => e.includes('@'));

    const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
    const reason = REPORT_REASONS[report.reason] || report.reason;
    const adminUrl = `${config.frontendUrl}/admin/reported`;
    const html = `
      <h2>New report: ${esc(target.label)}</h2>
      <p><strong>Reason:</strong> ${esc(reason)}</p>
      ${report.details ? `<p><strong>Details:</strong><br>${esc(report.details).replace(/\n/g, '<br>')}</p>` : ''}
      <p><strong>Reported by:</strong> ${esc(reporter?.name || 'Unknown')} (${esc(reporter?.email || '')})</p>
      <p><a href="${adminUrl}">Review in admin</a></p>`;

    await Promise.all(
      emails.map((to: string) =>
        emailService.sendEmail({ to, subject: `[Domilea] Reported: ${target.label} — ${reason}`, html })
      )
    );
  } catch (error) {
    logger.error('Failed to send content report notification:', error);
  }
}

export const contentReportService = {
  async createReport(
    reporterId: string,
    input: { targetType: string; targetId: string; reason: string; details?: string }
  ) {
    const targetType = String(input.targetType || '').toUpperCase();
    if (!TARGET_TYPES.includes(targetType)) throw new BadRequestError('Invalid report target');
    if (!REPORT_REASONS[input.reason]) throw new BadRequestError('Pick a reason for the report');
    const details = (input.details || '').trim().slice(0, 2000) || null;
    if (input.reason === 'OTHER' && !details) throw new BadRequestError('Tell us what is wrong with this listing');

    const targets = await loadTargets(targetType, [input.targetId]);
    const target = targets.get(input.targetId);
    if (!target) throw new NotFoundError('Listing');
    if (target.ownerId === reporterId) throw new BadRequestError("You can't report your own listing");

    const existing = await ContentReport.findOne({
      where: { reporterId, targetType, targetId: input.targetId, status: ContentReportStatus.OPEN },
    });
    if (existing) return { report: existing, duplicate: true };

    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recent = await ContentReport.count({ where: { reporterId, createdAt: { [Op.gte]: since } } });
    if (recent >= DAILY_REPORT_LIMIT) {
      throw new BadRequestError('You have reached the daily report limit. Contact support@domilea.com.');
    }

    const report = await ContentReport.create({
      reporterId,
      targetType,
      targetId: input.targetId,
      reportedUserId: target.ownerId,
      reason: input.reason,
      details,
    });

    const reporter = await User.findByPk(reporterId, { attributes: ['name', 'email'] });
    void notifyAdmins(report, target, reporter);

    return { report, duplicate: false };
  },

  async countOpen() {
    return ContentReport.count({ where: { status: ContentReportStatus.OPEN } });
  },

  async listReports(params: { status?: string; page?: number; limit?: number }) {
    const page = Math.max(params.page || 1, 1);
    const limit = Math.min(Math.max(params.limit || 50, 1), 100);
    const status = (params.status || ContentReportStatus.OPEN).toUpperCase();
    const where = status === 'ALL' ? {} : { status };

    const { rows, count } = await ContentReport.findAndCountAll({
      where,
      include: [
        { model: User, as: 'reporter', attributes: ['id', 'name', 'email'] },
        { model: User, as: 'reportedUser', attributes: ['id', 'name', 'email', 'status'] },
        { model: User, as: 'resolver', attributes: ['id', 'name'] },
      ],
      order: [['createdAt', 'DESC']],
      limit,
      offset: (page - 1) * limit,
    });

    const listingIds = rows.filter((r) => r.targetType === ContentReportTarget.LISTING).map((r) => r.targetId);
    const equipmentIds = rows.filter((r) => r.targetType === ContentReportTarget.EQUIPMENT).map((r) => r.targetId);
    const [listings, equipment] = await Promise.all([
      loadTargets(ContentReportTarget.LISTING, listingIds),
      loadTargets(ContentReportTarget.EQUIPMENT, equipmentIds),
    ]);

    // How many OPEN reports each target has in total (not just on this page).
    const openCounts = new Map<string, number>();
    const targetIds = [...new Set(rows.map((r) => r.targetId))];
    if (targetIds.length > 0) {
      const grouped = (await ContentReport.findAll({
        where: { targetId: targetIds, status: ContentReportStatus.OPEN },
        attributes: ['targetId', [ContentReport.sequelize!.fn('COUNT', ContentReport.sequelize!.col('id')), 'n']],
        group: ['targetId'],
        raw: true,
      })) as unknown as Array<{ targetId: string; n: number }>;
      for (const g of grouped) openCounts.set(g.targetId, Number(g.n));
    }

    const reports = rows.map((r) => {
      const target = (r.targetType === ContentReportTarget.LISTING ? listings : equipment).get(r.targetId) || null;
      return {
        id: r.id,
        targetType: r.targetType,
        targetId: r.targetId,
        target,
        reason: r.reason,
        reasonLabel: REPORT_REASONS[r.reason] || r.reason,
        severity: CRITICAL_REASONS.has(r.reason) ? 'critical' : 'high',
        details: r.details,
        status: r.status,
        resolution: r.resolution,
        adminNotes: r.adminNotes,
        resolvedAt: r.resolvedAt,
        resolver: r.resolver ? { id: r.resolver.id, name: r.resolver.name } : null,
        reporter: r.reporter ? { id: r.reporter.id, name: r.reporter.name, email: r.reporter.email } : null,
        reportedUser: r.reportedUser
          ? { id: r.reportedUser.id, name: r.reportedUser.name, email: r.reportedUser.email, status: r.reportedUser.status }
          : null,
        openReportsOnTarget: openCounts.get(r.targetId) || 0,
        createdAt: r.createdAt,
      };
    });

    return { reports, pagination: getPaginationInfo(page, limit, count) };
  },

  /** Close every OPEN report on the same target as `reportId`. */
  async closeTargetReports(reportId: string, adminId: string, status: string, resolution: string, notes?: string) {
    const report = await ContentReport.findByPk(reportId);
    if (!report) throw new NotFoundError('Report');
    const [closed] = await ContentReport.update(
      { status, resolution, adminNotes: notes?.trim() || null, resolvedBy: adminId, resolvedAt: new Date() },
      { where: { targetType: report.targetType, targetId: report.targetId, status: ContentReportStatus.OPEN } }
    );
    return { report, closed };
  },

  async dismiss(reportId: string, adminId: string, notes?: string) {
    const { report, closed } = await this.closeTargetReports(
      reportId, adminId, ContentReportStatus.DISMISSED, 'DISMISSED', notes
    );
    await AdminAction.create({
      adminId,
      action: 'DISMISS_REPORT',
      targetType: report.targetType,
      targetId: report.targetId,
      reason: notes || null,
      metadata: JSON.stringify({ reportId, closed }),
    });
    return { closed };
  },

  async takeAction(reportId: string, adminId: string, opts: { takeDown?: boolean; blockSeller?: boolean; notes?: string }) {
    if (!opts.takeDown && !opts.blockSeller) throw new BadRequestError('Choose at least one action');
    const report = await ContentReport.findByPk(reportId);
    if (!report) throw new NotFoundError('Report');
    const reason = `Reported: ${REPORT_REASONS[report.reason] || report.reason}${opts.notes ? ` — ${opts.notes.trim()}` : ''}`;

    if (opts.takeDown) {
      if (report.targetType === ContentReportTarget.LISTING) {
        const listing = await Listing.findByPk(report.targetId);
        if (!listing) throw new NotFoundError('Listing');
        await listing.update({ status: ListingStatus.SUSPENDED });
      } else {
        const item = await Truck.findByPk(report.targetId);
        if (!item) throw new NotFoundError('Equipment');
        if (item.listingId) {
          // Attached equipment is public whenever its MC listing is — the listing has to come down instead.
          throw new BadRequestError('This item is part of an MC listing. Take down the MC listing instead.');
        }
        await item.update({ status: 'REJECTED', reviewNote: reason.slice(0, 500) });
      }
      await AdminAction.create({
        adminId,
        action: 'TAKE_DOWN_REPORTED',
        targetType: report.targetType,
        targetId: report.targetId,
        reason,
        metadata: JSON.stringify({ reportId }),
      });
    }

    if (opts.blockSeller) {
      if (!report.reportedUserId) throw new BadRequestError('No seller is attached to this listing');
      await adminService.blockUser(report.reportedUserId, adminId, reason);
    }

    const resolution = opts.takeDown && opts.blockSeller ? 'TAKEN_DOWN_AND_BLOCKED' : opts.takeDown ? 'TAKEN_DOWN' : 'SELLER_BLOCKED';
    const { closed } = await this.closeTargetReports(reportId, adminId, ContentReportStatus.ACTIONED, resolution, opts.notes);
    return { closed, resolution };
  },
};

export default contentReportService;
