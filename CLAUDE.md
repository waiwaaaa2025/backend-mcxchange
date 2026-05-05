# CLAUDE.md — AI Developer Notes for backend-mcxchange

## Subscription Changes — CRITICAL

**NEVER manually insert/update subscription records in the database without keeping ALL three layers in sync:**

1. **Stripe** — Create, update, or cancel the actual Stripe subscription via the Stripe API
2. **Database** — Update the `subscriptions` table (plan, status, stripeSubId, stripeCustomerId, credits, dates)
3. **User credits** — Update `creditsPerMonth` and `creditsRemaining` to match the new plan

### Before making any subscription change:
- Query the DB to get current subscription state (plan, stripeSubId, stripeCustomerId, credits)
- Query Stripe to verify the subscription exists and its status matches the DB
- If there's a mismatch, resolve it before making further changes

### Subscription plan defaults:
| Plan | Price | Credits/mo | Notes |
|------|------|------------|-------|
| STARTER | $19/mo | 6 | Full marketplace, CarrierPulse, Risk Checks, Standard support |
| PROFESSIONAL | $39/mo | 10 | + EVA AI, 4 company credit reports/mo (UCC, tax liens, bankruptcy, payment history) |
| PREMIUM | $79/mo | 15 | Everything in Professional + AI Due Diligence + 15 credit reports + Priority support |
| VIP_ACCESS | $399 one-time | unlimited (until purchase) | NOT a subscription. $399 credited toward purchase. Display name: "VIP / Deal Access Pass" |

**Grandfathered (no longer offered to new signups, but enum values + existing subscriptions retained):**
- `PACKAGE_TOOL` — Pulse Bundle, $14.99/mo, 0 credits — tools only.
- `ENTERPRISE` — $79.99/mo, 15 credits — superseded by the new PREMIUM tier.

### Key fields:
- `User.stripeCustomerId` — the Stripe customer ID on the user record
- `Subscription.stripeSubId` — the Stripe subscription ID (NOT `stripeSubscriptionId`)
- `Subscription.stripeCustomerId` — should match `User.stripeCustomerId` but is sometimes null; always populate both

### Stripe env vars:
- `STRIPE_SECRET_KEY` — for API calls
- `STRIPE_PRICE_STARTER_MONTHLY`, `STRIPE_PRICE_PREMIUM_MONTHLY`, etc. — price IDs for each plan

## Database
- MySQL 8.0 via Sequelize ORM
- Hosted on JawsDB (Heroku addon)
- Connection via `JAWSDB_URL` env var

## Deployment
- Heroku app: `mcxchange`
- Auto-deploys from `main` branch on GitHub (`morproceo/backend-mcxchange`)
- Frontend on Vercel (`frontend-mcxchange-7gyr`) pointing to `https://www.domilea.com`
