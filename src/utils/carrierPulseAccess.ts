import { Subscription, SubscriptionStatus, User, UserRole } from '../models';
import { hasActiveBundlePromo } from './bundlePromo';
import { isFreeToolsPromoActive } from './freeToolsPromo';

/**
 * Who may use CarrierPulse / Chameleon Check. Same rule the frontend applies via
 * GET /buyer/carrier-pulse/access (buyerController.sendToolAccess): any active
 * subscription, standalone CarrierPulse, the Buyer's-Guide bundle window or the
 * free-tools promo. Admins and sellers always get the Chameleon Check page.
 */
export async function hasCarrierPulseAccess(userId: string, role: string | undefined): Promise<boolean> {
  if (role === UserRole.ADMIN || role === UserRole.SELLER) return true;

  const [user, subscription] = await Promise.all([
    User.findByPk(userId, { attributes: ['id', 'carrierPulseAccess', 'promoAccessType', 'promoAccessExpiresAt'] }),
    Subscription.findOne({ where: { userId }, attributes: ['status'] }),
  ]);

  return (
    subscription?.status === SubscriptionStatus.ACTIVE ||
    !!user?.carrierPulseAccess ||
    hasActiveBundlePromo(user) ||
    isFreeToolsPromoActive()
  );
}
