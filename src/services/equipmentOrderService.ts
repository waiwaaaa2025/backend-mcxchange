import Stripe from 'stripe';
import { Op } from 'sequelize';
import { config } from '../config';
import {
  EquipmentOrder,
  Notification,
  NotificationType,
  PlatformSetting,
  Truck,
  TruckPhoto,
  User,
} from '../models';
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../middleware/errorHandler';
import { stripeService } from './stripeService';
import { messageService } from './messageService';
import emailService from './emailService';
import { AUTHORITY_TALK_BLOCKED, mentionsAuthority } from '../utils/authorityTalk';
import logger from '../utils/logger';

export const OrderStatus = { PENDING: 'PENDING', PAID: 'PAID', CANCELLED: 'CANCELLED' } as const;

export const FEE_SETTING_KEY = 'equipment_platform_fee_percentage';
const DEFAULT_FEE_PERCENT = 5;
// A PENDING order holds its units while its Stripe session can still be paid.
const HOLD_MS = 31 * 60 * 1000;

const itemName = (t: Truck) =>
  (t.equipmentType === 'PART' && t.name) || [t.year, t.make, t.model].filter(Boolean).join(' ') || 'Equipment';

const itemUrl = (id: string) => `${config.frontendUrl}/equipment/${id}`;

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const usd = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function feePercent(): Promise<number> {
  const row = await PlatformSetting.findOne({ where: { key: FEE_SETTING_KEY } });
  const n = Number(row?.value);
  return row && isFinite(n) && n >= 0 && n < 100 ? n : DEFAULT_FEE_PERCENT;
}

async function sellerPayable(sellerId: string | null | undefined): Promise<User | null> {
  if (!sellerId) return null;
  const seller = await User.findByPk(sellerId);
  if (!seller?.stripeAccountId) return null;
  return (await stripeService.isAccountOnboarded(seller.stripeAccountId)) ? seller : null;
}

/** Units of an item not sold and not held by an open checkout. */
async function availableUnits(item: Truck): Promise<number> {
  const stock = item.equipmentType === 'PART' ? Math.max(item.quantity ?? 1, 0) : 1;
  const held = await EquipmentOrder.sum('quantity', {
    where: {
      itemId: item.id,
      status: OrderStatus.PENDING,
      createdAt: { [Op.gt]: new Date(Date.now() - HOLD_MS) },
    },
  });
  return Math.max(stock - (Number(held) || 0), 0);
}

/** A standalone, live item a buyer may purchase or ask about. */
async function liveStandaloneItem(itemId: string): Promise<Truck> {
  const item = await Truck.findByPk(itemId);
  if (!item || item.listingId || item.status !== 'ACTIVE') throw new NotFoundError('Item');
  return item;
}

export const equipmentOrderService = {
  feePercent,

  /** What the item page needs to show a Buy button. */
  async purchaseInfo(item: Truck) {
    if (item.listingId || item.status !== 'ACTIVE' || item.price == null) {
      return { purchasable: false, available: 0, reason: null as string | null };
    }
    const [seller, available] = await Promise.all([sellerPayable(item.sellerId), availableUnits(item)]);
    return {
      purchasable: !!seller && available > 0,
      available,
      reason: !seller ? 'SELLER_PAYOUTS_PENDING' : available === 0 ? 'ON_HOLD' : null,
    };
  },

  async startCheckout(itemId: string, buyer: { id: string }, requestedQty: unknown) {
    const item = await liveStandaloneItem(itemId);
    if (item.sellerId === buyer.id) throw new BadRequestError("You can't buy your own listing");
    if (item.price == null || item.price <= 0) throw new BadRequestError('This item has no price set');

    const quantity = item.equipmentType === 'PART' ? Math.max(1, Math.floor(Number(requestedQty) || 1)) : 1;
    const available = await availableUnits(item);
    if (available <= 0) {
      throw new ConflictError('Someone is checking out this item right now. Try again in about 30 minutes.');
    }
    if (quantity > available) throw new BadRequestError(`Only ${available} available`);

    const seller = await sellerPayable(item.sellerId);
    if (!seller) {
      throw new ConflictError("The seller hasn't finished payout setup yet, so this item can't be bought online yet.");
    }
    const buyerUser = await User.findByPk(buyer.id);

    const unitCents = Math.round(item.price * 100);
    const totalCents = unitCents * quantity;
    const pct = await feePercent();
    const feeCents = Math.round((totalCents * pct) / 100);

    const order = await EquipmentOrder.create({
      itemId: item.id,
      buyerId: buyer.id,
      sellerId: seller.id,
      quantity,
      unitPrice: unitCents / 100,
      amount: totalCents / 100,
      platformFee: feeCents / 100,
      sellerPayout: (totalCents - feeCents) / 100,
      status: OrderStatus.PENDING,
    });

    const result = await stripeService.createEquipmentCheckout({
      customerEmail: buyerUser?.email,
      itemName: itemName(item),
      itemDescription: [item.equipmentType === 'PART' ? item.partNumber && `Part #${item.partNumber}` : null, item.condition]
        .filter(Boolean)
        .join(' · ') || undefined,
      unitAmount: unitCents,
      quantity,
      applicationFee: feeCents,
      sellerConnectedAccountId: seller.stripeAccountId!,
      collectShipping: item.equipmentType === 'PART',
      successUrl: `${itemUrl(item.id)}?purchase=success`,
      cancelUrl: `${itemUrl(item.id)}?purchase=cancelled`,
      metadata: {
        type: 'equipment_purchase',
        orderId: order.id,
        itemId: item.id,
        buyerId: buyer.id,
        sellerId: seller.id,
      },
    });
    if (!result.success || !result.url) {
      await order.update({ status: OrderStatus.CANCELLED });
      throw new BadRequestError(result.error || 'Could not start checkout');
    }
    await order.update({ stripeSessionId: result.sessionId });
    return { url: result.url, orderId: order.id };
  },

  /** checkout.session.completed with metadata.type === 'equipment_purchase'. */
  async fulfill(session: Stripe.Checkout.Session) {
    const orderId = session.metadata?.orderId;
    const order = orderId ? await EquipmentOrder.findByPk(orderId) : null;
    if (!order) {
      logger.warn('equipment_purchase webhook: order not found', { sessionId: session.id, orderId });
      return;
    }
    // Idempotent: a retried event finds the order already PAID.
    if (order.status === OrderStatus.PAID) return;

    const ship = (session as any).shipping_details || (session as any).collected_information?.shipping_details;
    const addr = ship?.address;
    await order.update({
      status: OrderStatus.PAID,
      paidAt: new Date(),
      stripeSessionId: session.id,
      stripePaymentIntentId: typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id,
      buyerPhone: session.customer_details?.phone || null,
      shippingAddress: addr
        ? [ship?.name, addr.line1, addr.line2, [addr.city, addr.state, addr.postal_code].filter(Boolean).join(' ')]
            .filter(Boolean)
            .join('\n')
        : null,
    });

    const item = await Truck.findByPk(order.itemId);
    if (item) {
      if (item.equipmentType === 'PART') {
        const left = Math.max((item.quantity ?? 1) - order.quantity, 0);
        await item.update({ quantity: left, ...(left === 0 && { status: 'SOLD' }) });
      } else {
        await item.update({ status: 'SOLD' });
      }
    }

    const [buyer, seller] = await Promise.all([User.findByPk(order.buyerId), User.findByPk(order.sellerId)]);
    const name = item ? itemName(item) : 'your item';
    const qty = order.quantity > 1 ? ` × ${order.quantity}` : '';

    await Notification.create({
      userId: order.sellerId,
      type: NotificationType.PAYMENT,
      title: 'Item Sold',
      message: `${name}${qty} sold for ${usd(order.amount)}. ${usd(order.sellerPayout)} is on its way to your payout account.`,
      link: '/my-equipment',
    }).catch(() => undefined);
    await Notification.create({
      userId: order.buyerId,
      type: NotificationType.PAYMENT,
      title: 'Purchase Confirmed',
      message: `You bought ${name}${qty} for ${usd(order.amount)}.`,
      link: '/my-equipment',
    }).catch(() => undefined);

    if (seller?.email) {
      await emailService.sendCustomEmail(
        seller.email,
        `Sold: ${name}`,
        `<p>Good news — <strong>${escapeHtml(name)}${qty}</strong> sold on Domilea for <strong>${usd(order.amount)}</strong>.</p>
         <p>Your payout after the ${usd(order.platformFee)} platform fee is <strong>${usd(order.sellerPayout)}</strong>, sent to your connected payout account.</p>
         <p><strong>Buyer:</strong> ${escapeHtml(buyer?.name || 'Buyer')}${order.buyerPhone ? ` · ${escapeHtml(order.buyerPhone)}` : ''}<br/>
         ${order.shippingAddress ? `<strong>Ship to:</strong><br/>${escapeHtml(order.shippingAddress).replace(/\n/g, '<br/>')}` : 'Arrange pickup or delivery with the buyer from your Domilea messages.'}</p>
         <p><a href="${config.frontendUrl}/my-equipment">View your sales</a></p>`
      );
    }
    if (buyer?.email) {
      await emailService.sendCustomEmail(
        buyer.email,
        `Your Domilea purchase: ${name}`,
        `<p>Thanks for your purchase of <strong>${escapeHtml(name)}${qty}</strong> for <strong>${usd(order.amount)}</strong>.</p>
         <p>The seller has been notified. You can message them from the item page to arrange ${order.shippingAddress ? 'shipping' : 'pickup or delivery'}.</p>
         <p><a href="${itemUrl(order.itemId)}">View the item</a></p>`
      );
    }
    logger.info('Equipment order paid', { orderId: order.id, itemId: order.itemId, amount: order.amount });
  },

  /** Sales (as seller) and purchases (as buyer), paid orders only. */
  async listOrders(userId: string) {
    const include = [
      {
        model: Truck,
        as: 'item',
        attributes: ['id', 'equipmentType', 'make', 'model', 'name', 'year', 'partNumber'],
        include: [{ model: TruckPhoto, as: 'photos', attributes: ['url', 'displayOrder'] }],
      },
      { model: User, as: 'buyer', attributes: ['id', 'name', 'email'] },
      { model: User, as: 'seller', attributes: ['id', 'name'] },
    ];
    const [sales, purchases] = await Promise.all([
      EquipmentOrder.findAll({ where: { sellerId: userId, status: OrderStatus.PAID }, include, order: [['paidAt', 'DESC']] }),
      EquipmentOrder.findAll({ where: { buyerId: userId, status: OrderStatus.PAID }, include, order: [['paidAt', 'DESC']] }),
    ]);
    const shape = (o: EquipmentOrder, role: 'sale' | 'purchase') => {
      const photos = [...(o.item?.photos || [])].sort((a, b) => a.displayOrder - b.displayOrder);
      return {
        id: o.id,
        itemId: o.itemId,
        itemName: o.item ? itemName(o.item) : 'Item',
        equipmentType: o.item?.equipmentType ?? null,
        photo: photos[0]?.url ?? null,
        quantity: o.quantity,
        amount: o.amount,
        paidAt: o.paidAt,
        ...(role === 'sale'
          ? {
              platformFee: o.platformFee,
              sellerPayout: o.sellerPayout,
              buyer: o.buyer ? { id: o.buyer.id, name: o.buyer.name, email: o.buyer.email } : null,
              buyerPhone: o.buyerPhone,
              shippingAddress: o.shippingAddress,
            }
          : { seller: o.seller ? { id: o.seller.id, name: o.seller.name } : null }),
      };
    };
    return { sales: sales.map((o) => shape(o, 'sale')), purchases: purchases.map((o) => shape(o, 'purchase')) };
  },

  /**
   * Buyer's direct question to the seller of a standalone item. MC/authority
   * talk is refused — authority deals go through Domilea.
   */
  async askQuestion(itemId: string, buyer: { id: string }, content: unknown) {
    const text = String(content || '').trim();
    if (!text) throw new BadRequestError('Write a message');
    if (text.length > 2000) throw new BadRequestError('Message is too long');
    if (mentionsAuthority(text)) throw new BadRequestError(AUTHORITY_TALK_BLOCKED);

    const item = await liveStandaloneItem(itemId);
    if (!item.sellerId) throw new NotFoundError('Item');
    if (item.sellerId === buyer.id) throw new BadRequestError("That's your own listing");

    const name = itemName(item);
    const message = await messageService.sendMessage(
      buyer.id,
      item.sellerId,
      `[Question about ${name}]\n${itemUrl(item.id)}\n\n${text}`
    );

    const [seller, asker] = await Promise.all([User.findByPk(item.sellerId), User.findByPk(buyer.id)]);
    if (seller?.email) {
      await emailService.sendCustomEmail(
        seller.email,
        `New question about ${name}`,
        `<p><strong>${escapeHtml(asker?.name || 'A buyer')}</strong> asked about <a href="${itemUrl(item.id)}">${escapeHtml(name)}</a>:</p>
         <blockquote style="border-left:3px solid #ddd;margin:0;padding:8px 12px;color:#333">${escapeHtml(text).replace(/\n/g, '<br/>')}</blockquote>
         <p>Reply from your Domilea messages.</p>`
      );
    }
    return message;
  },

  // ---------- Payout setup for any role (listing is open to everyone) ----------

  async payoutStatus(userId: string) {
    const user = await User.findByPk(userId);
    if (!user) throw new NotFoundError('User');
    if (!user.stripeAccountId) {
      return { hasAccount: false, isOnboarded: false, chargesEnabled: false, payoutsEnabled: false, detailsSubmitted: false };
    }
    const account = await stripeService.getConnectedAccount(user.stripeAccountId);
    return {
      hasAccount: true,
      isOnboarded: !!(account?.details_submitted && account?.charges_enabled && account?.payouts_enabled),
      detailsSubmitted: !!account?.details_submitted,
      payoutsEnabled: !!account?.payouts_enabled,
      chargesEnabled: !!account?.charges_enabled,
    };
  },

  async payoutOnboardingLink(userId: string) {
    const user = await User.findByPk(userId);
    if (!user) throw new NotFoundError('User');
    let accountId = user.stripeAccountId;
    if (!accountId) {
      const created = await stripeService.createConnectedAccount({
        userId: user.id,
        email: user.email,
        businessName: user.companyName || undefined,
      });
      if (!created.success || !created.accountId) {
        throw new BadRequestError(created.error || 'Could not create payout account');
      }
      accountId = created.accountId;
      await user.update({ stripeAccountId: accountId });
    } else if (await stripeService.isAccountOnboarded(accountId)) {
      throw new BadRequestError('Your payout account is already set up');
    }
    const link = await stripeService.createAccountLink({
      accountId,
      refreshUrl: `${config.frontendUrl}/payouts?refresh=true`,
      returnUrl: `${config.frontendUrl}/payouts?onboarding=complete`,
    });
    if (!link.success || !link.url) throw new BadRequestError(link.error || 'Could not create onboarding link');
    return link.url;
  },

  async payoutDashboardLink(userId: string) {
    const user = await User.findByPk(userId);
    if (!user?.stripeAccountId) throw new ForbiddenError('Set up payouts first');
    const link = await stripeService.createLoginLink(user.stripeAccountId);
    if (!link.success || !link.url) throw new BadRequestError(link.error || 'Could not open payout dashboard');
    return link.url;
  },
};

