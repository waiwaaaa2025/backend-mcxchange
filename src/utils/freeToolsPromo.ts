/**
 * Limited-time free access to CarrierPulse and Chameleon Check for every
 * signed-in user. Launched 2026-09-15 for two weeks; ends end of day
 * 2026-09-29 US Central. After this date the normal subscription gate applies
 * again with no deploy needed. Insurance Leads is NOT part of this promo.
 */

export const FREE_TOOLS_PROMO_ENDS_AT = new Date('2026-09-30T04:59:59Z');

export function isFreeToolsPromoActive(now: number = Date.now()): boolean {
  return now < FREE_TOOLS_PROMO_ENDS_AT.getTime();
}
