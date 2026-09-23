import { Request, Response } from 'express';
import { facebookService } from '../services/facebookService';
import { Listing } from '../models';

/**
 * Get Facebook configuration (admin only)
 */
export const getConfig = async (_req: Request, res: Response) => {
  try {
    const config = await facebookService.getConfig();
    const isConfigured = await facebookService.isConfigured();

    res.json({
      success: true,
      data: {
        // Don't send the full token for security - just indicate if it's set
        pageAccessTokenSet: !!config.pageAccessToken,
        pageId: config.pageId,
        pageName: config.pageName,
        isConfigured,
      },
    });
  } catch (error: any) {
    console.error('Error getting Facebook config:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get Facebook configuration',
      error: error.message,
    });
  }
};

/**
 * Update Facebook configuration (admin only)
 */
export const updateConfig = async (req: Request, res: Response) => {
  try {
    const { pageAccessToken, pageId, pageName } = req.body;

    console.log('Facebook updateConfig received:', {
      hasPageAccessToken: !!pageAccessToken,
      pageAccessTokenLength: pageAccessToken?.length,
      pageId,
      pageName,
    });

    await facebookService.updateConfig({
      pageAccessToken,
      pageId,
      pageName,
    });

    console.log('Facebook config saved successfully');

    res.json({
      success: true,
      message: 'Facebook configuration updated successfully',
    });
  } catch (error: any) {
    console.error('Error updating Facebook config:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update Facebook configuration',
      error: error.message,
    });
  }
};

/**
 * Test Facebook connection (admin only)
 */
export const testConnection = async (_req: Request, res: Response) => {
  try {
    const result = await facebookService.testConnection();

    if (result.success) {
      res.json({
        success: true,
        message: `Connected to Page: ${result.pageName}`,
        pageName: result.pageName,
      });
    } else {
      res.status(400).json({
        success: false,
        message: result.error,
      });
    }
  } catch (error: any) {
    console.error('Error testing Facebook connection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to test Facebook connection',
      error: error.message,
    });
  }
};

/**
 * Share a listing to Facebook Page (admin only)
 */
export const shareListing = async (req: Request, res: Response) => {
  try {
    const { listingId, customMessage } = req.body;

    if (!listingId) {
      return res.status(400).json({
        success: false,
        message: 'Listing ID is required',
      });
    }

    // Get the listing
    const listing = await Listing.findByPk(listingId);

    if (!listing) {
      return res.status(404).json({
        success: false,
        message: 'Listing not found',
      });
    }

    const result = await facebookService.postListing(
      {
        id: listing.id,
        mcNumber: listing.mcNumber,
        dotNumber: listing.dotNumber,
        legalName: listing.legalName,
        dbaName: listing.dbaName,
        title: listing.title,
        askingPrice: listing.askingPrice,
        state: listing.state,
        yearsActive: listing.yearsActive,
        fleetSize: listing.fleetSize,
        safetyRating: listing.safetyRating,
      },
      customMessage
    );

    if (result.success) {
      res.json({
        success: true,
        message: 'Listing shared to Facebook Page',
        postId: result.postId,
      });
    } else {
      res.status(400).json({
        success: false,
        message: result.error,
      });
    }
  } catch (error: any) {
    console.error('Error sharing listing to Facebook:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to share listing',
      error: error.message,
    });
  }
};

/**
 * Get all active listings for sharing (admin only)
 */
export const getListingsForSharing = async (req: Request, res: Response) => {
  try {
    const { page = 1, limit = 20, search } = req.query;
    const offset = (Number(page) - 1) * Number(limit);

    const where: any = {
      status: 'ACTIVE',
    };

    if (search) {
      const { Op } = require('sequelize');
      where[Op.or] = [
        { mcNumber: { [Op.like]: `%${search}%` } },
        { title: { [Op.like]: `%${search}%` } },
      ];
    }

    const { rows: listings, count: total } = await Listing.findAndCountAll({
      where,
      attributes: ['id', 'mcNumber', 'title', 'askingPrice', 'state', 'yearsActive', 'fleetSize', 'safetyRating', 'createdAt'],
      order: [['createdAt', 'DESC']],
      limit: Number(limit),
      offset,
    });

    res.json({
      success: true,
      data: listings,
      pagination: {
        total,
        pages: Math.ceil(total / Number(limit)),
        page: Number(page),
        limit: Number(limit),
      },
    });
  } catch (error: any) {
    console.error('Error getting listings for sharing:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get listings',
      error: error.message,
    });
  }
};
