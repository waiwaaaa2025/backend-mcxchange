import { Request, Response } from 'express';
import { telegramService } from '../services/telegramService';
import { fmcsaService } from '../services/fmcsaService';
import { Listing, AmazonRelayStatus } from '../models';

/**
 * Get Telegram configuration (admin only)
 */
export const getConfig = async (_req: Request, res: Response) => {
  try {
    const config = await telegramService.getConfig();
    const isConfigured = await telegramService.isConfigured();

    res.json({
      success: true,
      data: {
        // Don't send the full token for security - just indicate if it's set
        botTokenSet: !!config.botToken,
        channelId: config.channelId,
        isConfigured,
      },
    });
  } catch (error: any) {
    console.error('Error getting Telegram config:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get Telegram configuration',
      error: error.message,
    });
  }
};

/**
 * Update Telegram configuration (admin only)
 */
export const updateConfig = async (req: Request, res: Response) => {
  try {
    const { botToken, channelId } = req.body;

    await telegramService.updateConfig({ botToken, channelId });

    res.json({
      success: true,
      message: 'Telegram configuration updated successfully',
    });
  } catch (error: any) {
    console.error('Error updating Telegram config:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to update Telegram configuration',
      error: error.message,
    });
  }
};

/**
 * Test Telegram connection (admin only)
 */
export const testConnection = async (_req: Request, res: Response) => {
  try {
    const result = await telegramService.testConnection();

    if (result.success) {
      res.json({
        success: true,
        message: `Connected to bot: @${result.botName}`,
        botName: result.botName,
      });
    } else {
      res.status(400).json({
        success: false,
        message: result.error,
      });
    }
  } catch (error: any) {
    console.error('Error testing Telegram connection:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to test Telegram connection',
      error: error.message,
    });
  }
};

/**
 * Send a custom message to Telegram channel (admin only)
 */
export const sendMessage = async (req: Request, res: Response) => {
  try {
    const { message } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        message: 'Message is required',
      });
    }

    const result = await telegramService.sendMessage({ message });

    if (result.success) {
      res.json({
        success: true,
        message: 'Message sent to Telegram channel',
        messageId: result.messageId,
      });
    } else {
      res.status(400).json({
        success: false,
        message: result.error,
      });
    }
  } catch (error: any) {
    console.error('Error sending Telegram message:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to send message',
      error: error.message,
    });
  }
};

/**
 * Share a listing to Telegram channel (admin only)
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

    // Fetch FMCSA SMS data (inspections + OOS) and authority history (for accurate years active)
    let smsData = null;
    let authority = null;
    try {
      // Resolve a DOT number first — use the listing's, else look it up by MC
      let dotNumber = listing.dotNumber;
      if (!dotNumber) {
        const fmcsaData = await fmcsaService.lookupByMC(listing.mcNumber);
        dotNumber = fmcsaData?.dotNumber || '';
      }
      if (dotNumber) {
        [smsData, authority] = await Promise.all([
          fmcsaService.getSMSData(dotNumber),
          fmcsaService.getAuthorityHistory(dotNumber),
        ]);
      }
    } catch (error) {
      console.error('Failed to fetch FMCSA data for Telegram share:', error);
    }

    // Count years from the reinstated date when the authority was reinstated,
    // otherwise from the original grant date; fall back to the stored value.
    const reinstatedDate = authority?.commonAuthorityReinstatedDate;
    const startDate = reinstatedDate || authority?.commonAuthorityGrantDate || authority?.grantDate;
    let yearsActive = listing.yearsActive;
    if (startDate) {
      const start = new Date(startDate);
      if (!isNaN(start.getTime())) {
        const years = Math.floor((Date.now() - start.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
        if (years >= 0) yearsActive = years;
      }
    }

    const result = await telegramService.sendListingPromotion(
      {
        id: listing.id,
        mcNumber: listing.mcNumber,
        dotNumber: listing.dotNumber,
        legalName: listing.legalName,
        dbaName: listing.dbaName,
        title: listing.title,
        listingPrice: listing.listingPrice || listing.askingPrice,
        state: listing.state,
        yearsActive,
        yearsFromReinstatement: !!reinstatedDate,
        fleetSize: listing.fleetSize,
        safetyRating: listing.safetyRating,
        totalInspections: smsData?.totalInspections,
        driverInspections: smsData?.totalDriverInspections,
        vehicleInspections: smsData?.totalVehicleInspections,
        driverOosRate: smsData?.driverOosRate,
        vehicleOosRate: smsData?.vehicleOosRate,
        description: listing.description,
        sellingWithEmail: listing.sellingWithEmail,
        sellingWithPhone: listing.sellingWithPhone,
        amazonActive: listing.amazonStatus === AmazonRelayStatus.ACTIVE,
        highwaySetup: listing.highwaySetup,
        rmisSetup: listing.rmisSetup,
      },
      customMessage
    );

    if (result.success) {
      res.json({
        success: true,
        message: 'Listing shared to Telegram channel',
        messageId: result.messageId,
      });
    } else {
      res.status(400).json({
        success: false,
        message: result.error,
      });
    }
  } catch (error: any) {
    console.error('Error sharing listing to Telegram:', error);
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
      attributes: ['id', 'mcNumber', 'title', 'listingPrice', 'askingPrice', 'state', 'yearsActive', 'fleetSize', 'safetyRating', 'createdAt'],
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
