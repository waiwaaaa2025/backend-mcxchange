import { Router } from 'express';
import { createVerificationSession, getVerificationStatus } from '../controllers/identityController';
import { authenticate } from '../middleware/auth';

const router = Router();

// All identity routes require authentication
router.use(authenticate);

router.post('/create-session', createVerificationSession);
router.get('/status', getVerificationStatus);

export default router;
