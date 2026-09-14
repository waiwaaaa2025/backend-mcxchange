import { Response } from 'express';
import { AuthRequest } from '../types';
import { User } from '../models';
import { stripeService } from '../services/stripeService';
import logger, { logError } from '../utils/logger';
import { config } from '../config';

/**
 * POST /api/identity/create-session
 * Creates a Stripe Identity verification session for the current user
 */
export const createVerificationSession = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Not authenticated' });
      return;
    }

    const user = await User.findByPk(req.user.id);
    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // Already verified
    if (user.identityVerified) {
      res.status(400).json({
        success: false,
        error: 'Identity already verified',
        data: { identityVerified: true, identityVerificationStatus: 'verified' },
      });
      return;
    }

    // Check for existing pending/processing session
    if (
      user.stripeVerificationSessionId &&
      (user.identityVerificationStatus === 'processing')
    ) {
      // Poll Stripe for latest status
      const sessionResult = await stripeService.getVerificationSession(user.stripeVerificationSessionId);
      if (sessionResult.success && sessionResult.status === 'verified') {
        await user.update({
          identityVerified: true,
          identityVerifiedAt: new Date(),
          identityVerificationStatus: 'verified',
        });
        res.json({
          success: true,
          data: { identityVerified: true, identityVerificationStatus: 'verified' },
        });
        return;
      }

      res.status(400).json({
        success: false,
        error: 'Verification is currently being processed. Please wait.',
        data: { identityVerificationStatus: user.identityVerificationStatus },
      });
      return;
    }

    // Create new verification session. Return the buyer to the page they started
    // from (e.g. the transaction room); only same-site relative paths are allowed.
    const requested = req.body?.returnPath;
    const returnPath =
      typeof requested === 'string' && requested.startsWith('/') && !requested.startsWith('//')
        ? requested
        : '/settings';
    const returnUrl = `${config.frontendUrl}${returnPath}${returnPath.includes('?') ? '&' : '?'}verification=complete`;

    const result = await stripeService.createVerificationSession({
      userId: user.id,
      returnUrl,
    });

    if (!result.success) {
      const statusCode = result.error === 'Payment service not available' ? 503 : 500;
      res.status(statusCode).json({ success: false, error: result.error || 'Failed to create verification session' });
      return;
    }

    // Store session ID on user
    await user.update({
      stripeVerificationSessionId: result.sessionId,
      identityVerificationStatus: 'pending',
    });

    logger.info('Identity verification session created', {
      userId: user.id,
      sessionId: result.sessionId,
    });

    res.json({
      success: true,
      data: {
        sessionId: result.sessionId,
        url: result.url,
      },
    });
  } catch (error) {
    logError('Failed to create verification session', error as Error);
    res.status(500).json({ success: false, error: 'Failed to create verification session' });
  }
};

/**
 * GET /api/identity/status
 * Returns current verification status, polls Stripe if needed
 */
export const getVerificationStatus = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    if (!req.user) {
      res.status(401).json({ success: false, error: 'Not authenticated' });
      return;
    }

    const user = await User.findByPk(req.user.id, {
      attributes: ['id', 'identityVerified', 'identityVerifiedAt', 'identityVerificationStatus', 'stripeVerificationSessionId'],
    });

    if (!user) {
      res.status(404).json({ success: false, error: 'User not found' });
      return;
    }

    // If already verified, return immediately
    if (user.identityVerified) {
      res.json({
        success: true,
        data: {
          identityVerified: true,
          identityVerificationStatus: 'verified',
          identityVerifiedAt: user.identityVerifiedAt,
        },
      });
      return;
    }

    // If there's a pending session, poll Stripe for latest status
    if (user.stripeVerificationSessionId) {
      const sessionResult = await stripeService.getVerificationSession(user.stripeVerificationSessionId);

      if (sessionResult.success) {
        const stripeStatus = sessionResult.status;

        // Update local status if it changed
        if (stripeStatus !== user.identityVerificationStatus) {
          const updateData: any = { identityVerificationStatus: stripeStatus };

          if (stripeStatus === 'verified') {
            updateData.identityVerified = true;
            updateData.identityVerifiedAt = new Date();
          }

          await user.update(updateData);
        }

        res.json({
          success: true,
          data: {
            identityVerified: stripeStatus === 'verified',
            identityVerificationStatus: stripeStatus,
            identityVerifiedAt: stripeStatus === 'verified' ? new Date() : null,
          },
        });
        return;
      }
    }

    // No session or couldn't poll
    res.json({
      success: true,
      data: {
        identityVerified: false,
        identityVerificationStatus: user.identityVerificationStatus || null,
        identityVerifiedAt: null,
      },
    });
  } catch (error) {
    logError('Failed to get verification status', error as Error);
    res.status(500).json({ success: false, error: 'Failed to get verification status' });
  }
};

export default {
  createVerificationSession,
  getVerificationStatus,
};
