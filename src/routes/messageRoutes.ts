import { Router } from 'express';
import {
  getConversations,
  getMessages,
  sendMessage,
  sendInquiryToAdmin,
  markAsRead,
  markConversationAsRead,
  getUnreadCount,
  deleteMessage,
  sendMessageValidation,
  sendInquiryValidation,
} from '../controllers/messageController';
import { authenticate } from '../middleware/auth';
import validate from '../middleware/validate';

const router = Router();

// All message routes require authentication
router.use(authenticate);

// Conversations
router.get('/conversations', getConversations);
router.get('/conversations/:partnerId', getMessages);
router.put('/conversations/:partnerId/read', markConversationAsRead);

// Messages — any authenticated user (buyer or seller) can send inquiries to admin
router.post('/inquiries', validate(sendInquiryValidation), sendInquiryToAdmin);
router.post('/', validate(sendMessageValidation), sendMessage);
router.put('/:id/read', markAsRead);
router.delete('/:id', deleteMessage);

// Unread count
router.get('/unread-count', getUnreadCount);

export default router;
