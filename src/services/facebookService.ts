import { PlatformSetting } from '../models';
import { maskNumber, publicListingTitle } from '../utils/listingSanitize';

interface FacebookConfig {
  pageAccessToken: string;
  pageId: string;
  pageName: string;
}

interface PostToPageOptions {
  message: string;
  link?: string;
}

interface FacebookApiResponse {
  id?: string;
  name?: string;
  error?: {
    message: string;
    code: number;
  };
}

class FacebookService {
  private configCache: FacebookConfig | null = null;
  private cacheTimestamp: number = 0;
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  /**
   * Get Facebook configuration from database
   */
  async getConfig(): Promise<FacebookConfig> {
    // Check cache
    if (this.configCache && Date.now() - this.cacheTimestamp < this.CACHE_TTL) {
      return this.configCache;
    }

    // Load from database
    const [pageAccessTokenSetting, pageIdSetting, pageNameSetting] = await Promise.all([
      PlatformSetting.findOne({ where: { key: 'facebook_page_access_token' } }),
      PlatformSetting.findOne({ where: { key: 'facebook_page_id' } }),
      PlatformSetting.findOne({ where: { key: 'facebook_page_name' } }),
    ]);

    this.configCache = {
      pageAccessToken: pageAccessTokenSetting?.value || '',
      pageId: pageIdSetting?.value || '',
      pageName: pageNameSetting?.value || 'Facebook Page',
    };
    this.cacheTimestamp = Date.now();

    return this.configCache;
  }

  /**
   * Update Facebook configuration
   */
  async updateConfig(config: Partial<FacebookConfig>): Promise<void> {
    const updates: { key: string; value: string }[] = [];

    if (config.pageAccessToken !== undefined) {
      updates.push({ key: 'facebook_page_access_token', value: config.pageAccessToken });
    }
    if (config.pageId !== undefined) {
      updates.push({ key: 'facebook_page_id', value: config.pageId });
    }
    if (config.pageName !== undefined) {
      updates.push({ key: 'facebook_page_name', value: config.pageName });
    }

    console.log('FacebookService updateConfig - updates to save:', updates.map(u => ({ key: u.key, valueLength: u.value?.length })));

    await Promise.all(
      updates.map(({ key, value }) =>
        PlatformSetting.upsert({ key, value, type: 'string' })
      )
    );

    console.log('FacebookService updateConfig - upserts completed');

    // Clear cache
    this.configCache = null;
    this.cacheTimestamp = 0;
  }

  /**
   * Check if Facebook is configured
   */
  async isConfigured(): Promise<boolean> {
    const config = await this.getConfig();
    return !!(config.pageAccessToken && config.pageId);
  }

  /**
   * Post to Facebook Page
   */
  async postToPage(options: PostToPageOptions): Promise<{ success: boolean; postId?: string; error?: string }> {
    const config = await this.getConfig();

    if (!config.pageAccessToken || !config.pageId) {
      return {
        success: false,
        error: 'Facebook not configured. Please set Page Access Token and Page ID in settings.',
      };
    }

    try {
      const url = `https://graph.facebook.com/v18.0/${config.pageId}/feed`;

      const body: Record<string, string> = {
        message: options.message,
        access_token: config.pageAccessToken,
      };

      if (options.link) {
        body.link = options.link;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams(body).toString(),
      });

      const data = await response.json() as FacebookApiResponse;

      if (data.error) {
        console.error('Facebook API error:', data.error);
        return {
          success: false,
          error: data.error.message || 'Failed to post to Facebook Page',
        };
      }

      return {
        success: true,
        postId: data.id,
      };
    } catch (error: any) {
      console.error('Facebook service error:', error);
      return {
        success: false,
        error: error.message || 'Failed to connect to Facebook',
      };
    }
  }

  /**
   * Post a listing to Facebook Page
   */
  async postListing(
    listing: {
      id: string;
      mcNumber: string;
      dotNumber?: string;
      legalName?: string;
      dbaName?: string;
      title: string;
      askingPrice: number;
      state?: string;
      yearsActive?: number;
      fleetSize?: number;
      safetyRating?: string;
    },
    customMessage?: string
  ): Promise<{ success: boolean; postId?: string; error?: string }> {
    const frontendUrl = process.env.FRONTEND_URL || 'https://www.domilea.com';
    const listingUrl = `${frontendUrl}/mc/${listing.id}`;

    // Same mask as the site and Telegram; a different one combines with theirs.
    const maskedMC = maskNumber(listing.mcNumber);

    // Build the message
    let message = '';

    if (customMessage) {
      message = customMessage + '\n\n';
    }

    message += `🚛 ${publicListingTitle(listing)}\n\n`;
    message += `📋 MC# ${maskedMC}\n`;
    message += `💰 Listing Price: $${listing.askingPrice.toLocaleString()}\n`;

    if (listing.state) {
      message += `📍 State: ${listing.state}\n`;
    }
    if (listing.yearsActive) {
      message += `📅 Years Active: ${listing.yearsActive}\n`;
    }
    if (listing.fleetSize) {
      message += `🚚 Fleet Size: ${listing.fleetSize}\n`;
    }
    if (listing.safetyRating) {
      message += `⭐ Safety Rating: ${listing.safetyRating}\n`;
    }

    message += `\n🔗 View Listing: ${listingUrl}`;

    return this.postToPage({ message, link: listingUrl });
  }

  /**
   * Test the Facebook connection
   */
  async testConnection(): Promise<{ success: boolean; pageName?: string; error?: string }> {
    const config = await this.getConfig();

    if (!config.pageAccessToken) {
      return {
        success: false,
        error: 'Page Access Token not configured',
      };
    }

    try {
      // Test by getting page info
      const url = `https://graph.facebook.com/v18.0/me?access_token=${config.pageAccessToken}`;
      const response = await fetch(url);
      const data = await response.json() as FacebookApiResponse;

      if (data.error) {
        return {
          success: false,
          error: data.error.message || 'Invalid access token',
        };
      }

      return {
        success: true,
        pageName: data.name,
      };
    } catch (error: any) {
      return {
        success: false,
        error: error.message || 'Failed to connect to Facebook',
      };
    }
  }
}

export const facebookService = new FacebookService();
export default facebookService;
