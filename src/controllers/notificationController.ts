import { equipmentMarketService } from '../services/equipmentMarketService';
import { Response } from 'express';
import { Op } from 'sequelize';
import { notificationService } from '../services/notificationService';
import { asyncHandler } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { parseIntParam, parseBooleanParam } from '../utils/helpers';
import { Message, Transaction, TransactionStatus, UserRole, Consultation, ConsultationStatus, Offer, OfferStatus } from '../models';

// Get notifications
export const getNotifications = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const page = parseIntParam(req.query.page as string) || 1;
  const limit = parseIntParam(req.query.limit as string) || 20;
  const unreadOnly = parseBooleanParam(req.query.unreadOnly as string);

  const result = await notificationService.getNotifications(
    req.user.id,
    page,
    limit,
    unreadOnly || false
  );

  res.json({
    success: true,
    data: result.notifications,
    pagination: result.pagination,
  });
});

// Mark notification as read
export const markAsRead = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  await notificationService.markAsRead(id, req.user.id);

  res.json({
    success: true,
    message: 'Notification marked as read',
  });
});

// Mark all notifications as read
export const markAllAsRead = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  await notificationService.markAllAsRead(req.user.id);

  res.json({
    success: true,
    message: 'All notifications marked as read',
  });
});

// Delete notification
export const deleteNotification = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  await notificationService.deleteNotification(id, req.user.id);

  res.json({
    success: true,
    message: 'Notification deleted',
  });
});

// Clear all notifications
export const clearAll = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  await notificationService.clearAll(req.user.id);

  res.json({
    success: true,
    message: 'All notifications cleared',
  });
});

// Get unread count
export const getUnreadCount = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const count = await notificationService.getUnreadCount(req.user.id);

  res.json({
    success: true,
    data: { count },
  });
});

// Get counts by type
export const getCountsByType = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const counts = await notificationService.getCountsByType(req.user.id);

  res.json({
    success: true,
    data: counts,
  });
});

// Get nav badge counts for sidebar notifications
export const getNavBadgeCounts = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const userId = req.user.id;
  const role = req.user.role;

  // Unread messages count
  const unreadMessages = await Message.count({
    where: { receiverId: userId, read: false },
  });

  // Active closing statuses
  const closingStatuses = [
    TransactionStatus.DEPOSIT_RECEIVED,
    TransactionStatus.IN_REVIEW,
    TransactionStatus.BUYER_APPROVED,
    TransactionStatus.SELLER_APPROVED,
    TransactionStatus.BOTH_APPROVED,
    TransactionStatus.ADMIN_FINAL_REVIEW,
    TransactionStatus.PAYMENT_PENDING,
    TransactionStatus.PAYMENT_RECEIVED,
  ];

  // Non-terminal transaction statuses (everything except COMPLETED and CANCELLED)
  const activeStatuses = [
    TransactionStatus.AWAITING_DEPOSIT,
    ...closingStatuses,
  ];

  // Build where clause based on role
  const txnWhere = role === UserRole.ADMIN
    ? {}
    : role === UserRole.SELLER
    ? { sellerId: userId }
    : { buyerId: userId };

  const newTransactions = await Transaction.count({
    where: { ...txnWhere, status: { [Op.in]: activeStatuses } },
  });

  const activeClosings = await Transaction.count({
    where: { ...txnWhere, status: { [Op.in]: closingStatuses } },
  });

  // Paid consultations awaiting admin action (admin-only)
  const paidConsultations = role === UserRole.ADMIN
    ? await Consultation.count({ where: { status: ConsultationStatus.PAID } })
    : 0;

  // Offers awaiting admin review (admin-only)
  const pendingAdminOffers = role === UserRole.ADMIN
    ? await Offer.count({ where: { status: OfferStatus.PENDING_ADMIN } })
    : 0;

  // Standalone equipment/parts awaiting review (admin-only)
  const pendingEquipment = role === UserRole.ADMIN ? await equipmentMarketService.pendingCount() : 0;

  res.json({
    success: true,
    data: { unreadMessages, newTransactions, activeClosings, paidConsultations, pendingAdminOffers, pendingEquipment },
  });
});
