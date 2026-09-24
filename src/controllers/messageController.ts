import { AUTHORITY_TALK_BLOCKED, mentionsAuthority } from '../utils/authorityTalk';
import { Response } from 'express';
import { body, param } from 'express-validator';
import { messageService } from '../services/messageService';
import { asyncHandler } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { parseIntParam } from '../utils/helpers';
import { User, UserRole, UserStatus } from '../models';

// Validation rules
export const sendMessageValidation = [
  body('receiverId').trim().notEmpty().withMessage('Receiver ID is required'),
  body('content').trim().notEmpty().withMessage('Message content is required'),
  body('listingId').optional().trim(),
];

export const sendInquiryValidation = [
  body('content').trim().notEmpty().withMessage('Message content is required'),
  body('listingId').optional().trim(),
  body('contactPhone').optional().trim(),
];

// Get conversations
export const getConversations = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const conversations = await messageService.getConversations(req.user.id);

  res.json({
    success: true,
    data: conversations,
  });
});

// Get messages in a conversation
export const getMessages = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { partnerId } = req.params;
  const page = parseIntParam(req.query.page as string) || 1;
  const limit = parseIntParam(req.query.limit as string) || 50;

  const result = await messageService.getMessages(req.user.id, partnerId, page, limit);

  res.json({
    success: true,
    data: result.messages,
    pagination: result.pagination,
  });
});

// Send a message
export const sendMessage = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { receiverId, content, listingId } = req.body;

  // Direct user-to-user messages (equipment & parts questions) may not discuss
  // MC authorities — those deals go through the Domilea team, so threads with
  // an admin are exempt.
  if (req.user.role !== UserRole.ADMIN && mentionsAuthority(content)) {
    const receiver = await User.findByPk(receiverId, { attributes: ['id', 'role'] });
    if (receiver && receiver.role !== UserRole.ADMIN) {
      res.status(400).json({ success: false, error: AUTHORITY_TALK_BLOCKED });
      return;
    }
  }

  const message = await messageService.sendMessage(
    req.user.id,
    receiverId,
    content,
    listingId
  );

  res.status(201).json({
    success: true,
    data: message,
    message: 'Message sent',
  });
});

// Send inquiry to admin (buyer -> admin)
export const sendInquiryToAdmin = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { content, listingId, contactPhone } = req.body as {
    content: string;
    listingId?: string;
    contactPhone?: string;
  };

  const adminUser = await User.findOne({
    where: {
      role: UserRole.ADMIN,
      status: UserStatus.ACTIVE,
    },
    order: [['createdAt', 'ASC']],
  });

  if (!adminUser) {
    res.status(404).json({ success: false, error: 'Admin user not found' });
    return;
  }

  const messageContent = contactPhone
    ? `Phone: ${contactPhone}\n\n${content}`
    : content;

  const message = await messageService.sendMessage(
    req.user.id,
    adminUser.id,
    messageContent,
    listingId
  );

  res.status(201).json({
    success: true,
    data: message,
    message: 'Inquiry sent',
  });
});

// Mark message as read
export const markAsRead = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  await messageService.markAsRead(id, req.user.id);

  res.json({
    success: true,
    message: 'Message marked as read',
  });
});

// Mark conversation as read
export const markConversationAsRead = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { partnerId } = req.params;

  await messageService.markConversationAsRead(req.user.id, partnerId);

  res.json({
    success: true,
    message: 'Conversation marked as read',
  });
});

// Get unread count
export const getUnreadCount = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const count = await messageService.getUnreadCount(req.user.id);

  res.json({
    success: true,
    data: { count },
  });
});

// Delete message
export const deleteMessage = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  await messageService.deleteMessage(id, req.user.id);

  res.json({
    success: true,
    message: 'Message deleted',
  });
});
