import {
  User,
  Subscription,
  CreditTransaction,
  UnlockedListing,
  Listing,
  UserTermsAcceptance,
  PaymentConsent,
  UserAccessLog,
} from '../models';
import { stripeService } from './stripeService';
import { NotFoundError } from '../middleware/errorHandler';
import logger from '../utils/logger';
import { REGISTER_CONSENT, CHECKOUT_CONSENT, PAYMENT_TERMS_ARTICLE_7, TERMS_OF_SERVICE_URL } from '../constants/legal';

function fmt(d: any): string {
  if (!d) return '—';
  const dt = new Date(d);
  return isNaN(dt.getTime()) ? String(d) : dt.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}
function stripeTs(sec?: number | null): string {
  return sec ? new Date(sec * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '—';
}
function money(amount?: number | null, currency?: string | null): string {
  if (amount == null) return '—';
  return `$${(amount / 100).toFixed(2)} ${String(currency || '').toUpperCase()}`;
}

class DisputeEvidenceService {
  /**
   * Build a dispute-evidence PDF for any user: account, subscription, real Stripe charges
   * + dispute record, credit usage (value consumed), and recorded Terms acceptance.
   */
  async buildEvidencePdf(userId: string): Promise<{ buffer: Buffer; filename: string }> {
    const user = await User.findByPk(userId);
    if (!user) throw new NotFoundError('User');

    const [subscription, ledger, unlocked, terms, paymentConsents, accessLog] = await Promise.all([
      Subscription.findOne({ where: { userId } }),
      CreditTransaction.findAll({ where: { userId }, order: [['createdAt', 'ASC']] }),
      UnlockedListing.findAll({ where: { userId }, order: [['createdAt', 'ASC']] }),
      UserTermsAcceptance.findAll({ where: { userId }, order: [['acceptedAt', 'DESC']] }),
      PaymentConsent.findAll({ where: { userId }, order: [['acceptedAt', 'DESC']] }),
      UserAccessLog.findAll({ where: { userId }, order: [['createdAt', 'ASC']], limit: 500 }),
    ]);

    // Join unlocked listings to listing details (proof of value consumed).
    const listingIds = unlocked.map((u: any) => u.listingId);
    const listings = listingIds.length ? await Listing.findAll({ where: { id: listingIds } }) : [];
    const listingById = new Map(listings.map((l: any) => [l.id, l]));

    // Live Stripe billing evidence.
    let stripeData: { subscription: any; charges: any[]; disputes: any[]; checkoutSessions: any[] } = {
      subscription: null,
      charges: [],
      disputes: [],
      checkoutSessions: [],
    };
    if ((user as any).stripeCustomerId && stripeService.isEnabled()) {
      try {
        stripeData = await stripeService.getCustomerBillingEvidence((user as any).stripeCustomerId);
      } catch (e) {
        logger.error('Dispute evidence: Stripe pull failed', { userId, error: e });
      }
    }

    // Stripe's own recorded Terms-of-Service acceptances from hosted checkout.
    const stripeTosAcceptances = (stripeData.checkoutSessions || [])
      .filter((s: any) => s?.consent?.terms_of_service === 'accepted')
      .map((s: any) => ({ id: s.id, created: s.created }))
      .sort((a: any, b: any) => (b.created || 0) - (a.created || 0));

    const buffer = await this.renderPdf({ user, subscription, ledger, unlocked, listingById, terms, paymentConsents, stripeTosAcceptances, accessLog, stripe: stripeData });
    const safeName = String((user as any).name || 'user').replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    return { buffer, filename: `dispute-evidence-${safeName}-${userId}.pdf` };
  }

  /**
   * Build the Terms of Service PDF (payment & dispute provisions, Article 7) to
   * upload into Stripe's `terms_of_service` dispute-evidence field. Contains the
   * exact "all payments final" and chargeback-prohibition clauses the customer
   * agreed to, plus a link to the full public Terms of Service.
   */
  buildTermsOfServicePdf(): Promise<{ buffer: Buffer; filename: string }> {
    return new Promise(async (resolve, reject) => {
      try {
        const PDFDocument = (await import('pdfkit')).default;
        const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), filename: 'domilea-terms-of-service-payment-provisions.pdf' }));

        doc.font('Helvetica-Bold').fontSize(16).fillColor('#0f172a')
          .text('Domilea — Terms of Service', { align: 'center' });
        doc.font('Helvetica').fontSize(11).fillColor('#333')
          .text('Payment & Dispute Provisions (Article 7)', { align: 'center' });
        doc.font('Helvetica').fontSize(9).fillColor('#666')
          .text('The Domilea Group', { align: 'center' });
        doc.moveDown(0.3);
        doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#ccc').stroke();
        doc.moveDown(0.6);

        doc.font('Helvetica').fontSize(9.5).fillColor('#444').text(
          `This document reproduces the payment and dispute provisions of the Domilea Buyer Terms of Service that every customer must affirmatively accept before payment. The complete Terms of Service are published at ${TERMS_OF_SERVICE_URL}.`);
        doc.moveDown(0.5);

        doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text('Consent presented and accepted at checkout:');
        doc.moveDown(0.2);
        doc.font('Helvetica-Oblique').fontSize(9.5).fillColor('#444').text(`“${CHECKOUT_CONSENT}”`, { indent: 15 });
        doc.moveDown(0.6);

        PAYMENT_TERMS_ARTICLE_7.forEach((clause) => {
          doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text(clause.heading);
          doc.moveDown(0.15);
          doc.font('Helvetica').fontSize(10).fillColor('#222').text(clause.body, { align: 'left' });
          doc.moveDown(0.5);
        });

        doc.moveDown(0.3);
        doc.font('Helvetica').fontSize(8.5).fillColor('#666').text(
          `Full Terms of Service: ${TERMS_OF_SERVICE_URL} · Privacy Policy: https://www.domilea.com/privacy`);

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }


  /**
   * Build Stripe's STRUCTURED dispute-evidence fields (the text fields issuers
   * actually weigh) for a user, derived from the same records as the PDF:
   * customer identity, purchase IP, service date, access activity log, product
   * description, cancellation disclosure and a reason-specific rebuttal.
   *
   * The PDF is the exhibit; these fields are what Stripe forwards to the issuing
   * bank in structured form. Pass `disputeId` to target a specific dispute,
   * otherwise the first dispute awaiting a response is used.
   */
  async buildEvidenceFields(userId: string, opts: { disputeId?: string } = {}): Promise<{
    fields: Record<string, string>;
    meta: {
      disputeId: string | null;
      reason: string | null;
      chargeId: string | null;
      missing: string[];
      generatedAt: string;
    };
  }> {
    const user: any = await User.findByPk(userId);
    if (!user) throw new NotFoundError('User');

    const [subscription, unlocked, terms, paymentConsents, accessLog] = await Promise.all([
      Subscription.findOne({ where: { userId } }),
      UnlockedListing.findAll({ where: { userId }, order: [['createdAt', 'ASC']] }),
      UserTermsAcceptance.findAll({ where: { userId }, order: [['acceptedAt', 'DESC']] }),
      PaymentConsent.findAll({ where: { userId }, order: [['acceptedAt', 'DESC']] }),
      UserAccessLog.findAll({ where: { userId }, order: [['createdAt', 'ASC']], limit: 500 }),
    ]);

    const listingIds = unlocked.map((u: any) => u.listingId);
    const listings = listingIds.length ? await Listing.findAll({ where: { id: listingIds } }) : [];
    const listingById = new Map(listings.map((l: any) => [l.id, l]));

    let stripeData: { subscription: any; charges: any[]; disputes: any[]; checkoutSessions: any[] } = {
      subscription: null, charges: [], disputes: [], checkoutSessions: [],
    };
    if (user.stripeCustomerId && stripeService.isEnabled()) {
      try {
        stripeData = await stripeService.getCustomerBillingEvidence(user.stripeCustomerId);
      } catch (e) {
        logger.error('Dispute evidence fields: Stripe pull failed', { userId, error: e });
      }
    }

    // Target dispute: the requested one, else the first awaiting a response, else the latest.
    const disputes = stripeData.disputes || [];
    const dispute =
      (opts.disputeId && disputes.find((d: any) => d.id === opts.disputeId)) ||
      disputes.find((d: any) => d.status === 'needs_response' || d.status === 'warning_needs_response') ||
      disputes[0] ||
      null;
    const chargeId: string | null = dispute
      ? (typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id || null)
      : null;
    const disputedCharge = chargeId ? stripeData.charges.find((c: any) => c.id === chargeId) : null;
    const paidCharges = stripeData.charges.filter((c: any) => c.paid).sort((a: any, b: any) => a.created - b.created);

    // Purchase IP: the signed checkout consent closest in time to the disputed
    // charge (that is the session that produced it), else the latest consent,
    // else the signup Terms acceptance, else the first recorded access event.
    const chargeMs = (disputedCharge?.created || paidCharges[0]?.created || 0) * 1000;
    const consentsByProximity = [...(paymentConsents as any[])].sort((a: any, b: any) =>
      Math.abs(new Date(a.acceptedAt).getTime() - chargeMs) - Math.abs(new Date(b.acceptedAt).getTime() - chargeMs));
    const purchaseIp =
      (chargeMs ? consentsByProximity[0]?.ipAddress : '') ||
      (paymentConsents as any[])[0]?.ipAddress ||
      (terms as any[])[0]?.ipAddress ||
      (accessLog as any[])[0]?.ipAddress ||
      '';

    const addr = disputedCharge?.billing_details?.address || stripeData.charges[0]?.billing_details?.address || null;
    const billingAddress = addr
      ? [addr.line1, addr.line2, [addr.city, addr.state, addr.postal_code].filter(Boolean).join(' '), addr.country]
          .filter(Boolean).join('\n')
      : '';

    const serviceDate = paidCharges.length
      ? new Date(paidCharges[0].created * 1000).toISOString().slice(0, 10)
      : (subscription as any)?.startDate
        ? new Date((subscription as any).startDate).toISOString().slice(0, 10)
        : '';

    const loginCount = (accessLog as any[]).filter((a) => a.event === 'LOGIN').length;
    const plan = (subscription as any)?.plan || 'subscription';

    // 20,000 characters is Stripe's per-field limit for evidence text.
    const clip = (t: string): string =>
      t.length <= 20000 ? t : t.slice(0, 19900) + '\n… (truncated; full record in the attached evidence PDF)';

    const accessActivityLog = (accessLog as any[]).length
      ? clip(
          [
            `Authenticated access events for ${user.email} (account ${user.id}), recorded by the platform with IP address and timestamp:`,
            '',
            ...(accessLog as any[]).map((a) =>
              `${fmt(a.createdAt)}  ${String(a.event).padEnd(7)}  IP ${a.ipAddress || 'n/a'}  ${a.detail || ''}`.trimEnd()),
            '',
            `Total: ${(accessLog as any[]).length} event(s), including ${loginCount} authenticated login(s).`,
          ].join('\n'))
      : '';

    const unlockLines = (unlocked as any[]).slice(0, 100).map((u: any, i: number) => {
      const l: any = listingById.get(u.listingId);
      return `${i + 1}. ${fmt(u.createdAt)} — MC ${l?.mcNumber || '—'} ${l?.legalName || l?.title || `(listing ${u.listingId})`} (−${u.creditsUsed} credit)`;
    });

    const productDescription = clip(
      [
        `Domilea is a B2B marketplace for motor carrier authorities (www.domilea.com). The customer purchased a ${plan} ` +
          'subscription, billed month-to-month, which grants account credits used to unlock the confidential contact ' +
          'details of motor carriers listed on the platform. The service is delivered digitally and immediately: access ' +
          'is granted the moment the subscription is created, and each unlock discloses private information that cannot be returned.',
        '',
        `The customer consumed the service by unlocking ${(unlocked as any[]).length} carrier contact record(s).`,
        ...(unlockLines.length ? ['', ...unlockLines] : []),
        ...((unlocked as any[]).length > 100 ? ['', `… and ${(unlocked as any[]).length - 100} more (full list in the attached evidence PDF).`] : []),
      ].join('\n'));

    const cancellationPolicyDisclosure = clip(
      'Subscriptions are billed month-to-month and may be cancelled at any time from the customer’s Subscription page ' +
      'in their account or by emailing info@domilea.com. Cancellation stops all future billing. As disclosed in the ' +
      'terms the customer accepted at signup and signed again at checkout: “' + CHECKOUT_CONSENT + '” ' +
      `The full Terms of Service are published at ${TERMS_OF_SERVICE_URL} (payment provisions, Article 7).`);

    const refundRefusalExplanation = clip(
      'All payments are final under Article 7.3 of the Terms of Service, which the customer affirmatively accepted before ' +
      'an account could be created' +
      ((terms as any[])[0] ? ` (electronically signed by ${(terms as any[])[0].signatureName || 'the customer'} on ${fmt((terms as any[])[0].acceptedAt)} from IP ${(terms as any[])[0].ipAddress || 'n/a'})` : '') +
      ((paymentConsents as any[])[0] ? ` and signed again at the moment of payment (signed by ${(paymentConsents as any[])[0].signatureName || 'the customer'} on ${fmt((paymentConsents as any[])[0].acceptedAt)} from IP ${(paymentConsents as any[])[0].ipAddress || 'n/a'})` : '') +
      `. The service was delivered in full and consumed: ${(unlocked as any[]).length} confidential carrier contact record(s) were unlocked and ` +
      'disclosed to the customer. Article 7.4 of the same terms also expressly prohibits chargebacks and directs the ' +
      'customer to contact info@domilea.com to resolve any billing issue; cancellation is available at any time from the ' +
      'account\u2019s Subscription page or by email, and stops all future billing.');

    const reason = dispute?.reason || null;
    const summaryFacts = [
      `Account: ${user.name} <${user.email}> (id ${user.id}), created ${fmt(user.memberSince || user.createdAt)}.`,
      `Stripe customer ${user.stripeCustomerId || 'n/a'}; ${paidCharges.length} successful charge(s) on this card before the dispute.`,
      `Authenticated logins recorded: ${loginCount}; last login ${fmt(user.lastLoginAt)}.`,
      `Service consumed: ${(unlocked as any[]).length} carrier contact record(s) unlocked.`,
      `Terms accepted at signup: ${(terms as any[])[0] ? `${fmt((terms as any[])[0].acceptedAt)} from IP ${(terms as any[])[0].ipAddress || 'n/a'}` : 'mandatory checkbox (signature capture postdates this account)'}.`,
      `Payment terms signed at checkout: ${(paymentConsents as any[])[0] ? `${fmt((paymentConsents as any[])[0].acceptedAt)} from IP ${(paymentConsents as any[])[0].ipAddress || 'n/a'}` : 'signature capture postdates this charge; signup acceptance applies'}.`,
      `Stripe Identity verified: ${user.identityVerified ? 'yes' : 'no'}.`,
    ];
    const uncategorizedText = clip(
      [
        'Merchant response — The Domilea Group (www.domilea.com).',
        '',
        'The disputed charge was authorized by the account holder and the service was delivered immediately and digitally' +
          ((unlocked as any[]).length ? ', and the customer used it' : '') + '. Supporting records:',
        '',
        ...summaryFacts.map((f) => `• ${f}`),
        '',
        'The attached PDF contains the full evidence packet: the Stripe billing record, the itemized list of carrier ' +
          'records unlocked, the IP-stamped access activity log, the account credit ledger, and the customer’s ' +
          'electronic signatures on the Terms of Service and the payment authorization.',
        '',
        'We respectfully request that this dispute be resolved in the merchant’s favor.',
      ].join('\n'));

    const fields: Record<string, string> = {
      customer_name: user.name || '',
      customer_email_address: user.email || '',
      customer_purchase_ip: purchaseIp,
      billing_address: billingAddress,
      service_date: serviceDate,
      product_description: productDescription,
      access_activity_log: accessActivityLog,
      cancellation_policy_disclosure: cancellationPolicyDisclosure,
      refund_refusal_explanation: refundRefusalExplanation,
      uncategorized_text: uncategorizedText,
    };

    // Reason-specific rebuttals — only sent when they actually apply.
    if (reason === 'subscription_canceled') {
      const cancelledAt = (subscription as any)?.cancelledAt;
      // Only claim continued use if the records actually show it inside the
      // disputed billing period — an assertion the attached log contradicts
      // costs more credibility than it buys.
      const periodEnd = chargeMs ? chargeMs + 31 * 86400000 : 0;
      const inPeriod = chargeMs
        ? [
            ...(accessLog as any[]).map((a: any) => new Date(a.createdAt).getTime()),
            ...(unlocked as any[]).map((u: any) => new Date(u.createdAt).getTime()),
          ].filter((t) => t >= chargeMs && t <= periodEnd)
        : [];
      const usageSentence = inPeriod.length
        ? ` The account was used ${inPeriod.length} time(s) during that billing period (most recently `
          + `${fmt(new Date(Math.max(...inPeriod)))}) — see the access activity log.`
        : '';
      fields.cancellation_rebuttal = clip(
        cancelledAt
          ? `Our records show the subscription was cancelled on ${fmt(cancelledAt)}. The disputed charge was made on `
            + `${disputedCharge ? stripeTs(disputedCharge.created) : 'the date shown in the Stripe billing record'}, i.e. for a billing period that began `
            + 'before any cancellation request was received. Cancellation stops future billing; it does not reverse a period '
            + 'already billed, during which the account remained active and entitled to the service.' + usageSentence
          : 'No cancellation request was ever received from this customer — there is no cancellation on record in the platform '
            + 'database or in Stripe, and the subscription remained active.' + usageSentence
            + ' Cancellation is available at any time from the customer’s Subscription page or by emailing info@domilea.com.');
    }
    if (reason === 'duplicate') {
      fields.duplicate_charge_explanation = clip(
        [
          'The charges are not duplicates: each is a separate monthly billing period of an active month-to-month subscription.',
          '',
          ...paidCharges.map((c: any) => `${stripeTs(c.created)}  ${money(c.amount, c.currency)}  ${c.id}`),
        ].join('\n'));
    }

    const missing = Object.entries(fields).filter(([, v]) => !v).map(([k]) => k);
    Object.keys(fields).forEach((k) => { if (!fields[k]) delete fields[k]; });

    return {
      fields,
      meta: {
        disputeId: dispute?.id || null,
        reason,
        chargeId,
        missing,
        generatedAt: new Date().toISOString(),
      },
    };
  }

  private renderPdf(data: any): Promise<Buffer> {
    return new Promise(async (resolve, reject) => {
      try {
        const PDFDocument = (await import('pdfkit')).default;
        const { user, subscription, ledger, unlocked, listingById, terms, paymentConsents, stripeTosAcceptances, accessLog, stripe } = data;

        const doc = new PDFDocument({ margin: 50, size: 'LETTER' });
        const chunks: Buffer[] = [];
        doc.on('data', (c: Buffer) => chunks.push(c));
        doc.on('end', () => resolve(Buffer.concat(chunks)));

        const H = (t: string) => doc.moveDown(0.6).font('Helvetica-Bold').fontSize(12).fillColor('#111').text(t).moveDown(0.2);
        const P = (t: string) => doc.font('Helvetica').fontSize(10).fillColor('#222').text(t);
        const KV = (k: string, v: any) => doc.font('Helvetica-Bold').fontSize(10).fillColor('#222')
          .text(`${k}: `, { continued: true }).font('Helvetica').text(String(v == null || v === '' ? '—' : v));

        doc.font('Helvetica-Bold').fontSize(16).fillColor('#0f172a').text('Domilea — Subscription Dispute Evidence', { align: 'center' });
        doc.font('Helvetica').fontSize(9).fillColor('#666').text(`Generated ${fmt(new Date().toISOString())} · The Domilea Group`, { align: 'center' });
        doc.moveDown(0.3);
        doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#ccc').stroke();

        // 1. Account
        H('1. Cardholder & Account');
        KV('Name', user.name);
        KV('Email', user.email);
        KV('Account ID', user.id);
        KV('Stripe Customer', user.stripeCustomerId);
        KV('Account created', fmt(user.memberSince || user.createdAt));
        KV('Last login', fmt(user.lastLoginAt));
        KV('Identity verified', user.identityVerified ? 'Yes' : 'No');

        // 2. Subscription
        H('2. Subscription');
        if (subscription) {
          KV('Plan', subscription.plan);
          KV('Status', subscription.status);
          KV('Stripe Subscription ID', subscription.stripeSubId);
          KV('Started', fmt(subscription.startDate));
          KV('Cancelled', fmt(subscription.cancelledAt));
        } else {
          P('No subscription record on file.');
        }
        if (stripe.subscription) {
          const price = stripe.subscription.items?.data?.[0]?.price;
          if (price) KV('Billed', `${money(price.unit_amount, price.currency)} / ${price.recurring?.interval}`);
        }

        // 2b. Real charges
        if (stripe.charges.length) {
          H('2b. Stripe Billing Record (actual charges)');
          const paid = stripe.charges.filter((c: any) => c.paid).length;
          P(`The cardholder was successfully charged ${paid} time(s):`);
          doc.moveDown(0.2);
          stripe.charges.forEach((c: any) => {
            doc.font('Helvetica').fontSize(9.5).fillColor('#222').text(
              `   ${stripeTs(c.created)}   ${money(c.amount, c.currency)}   ${c.paid ? 'PAID' : 'unpaid'}` +
              `${c.disputed ? '  (DISPUTED)' : ''}   ${c.id}`);
          });
        }

        // 2c. Disputes
        if (stripe.disputes.length) {
          H('2c. Dispute Record');
          stripe.disputes.forEach((d: any) => {
            const active = d.status === 'needs_response' || d.status === 'warning_needs_response';
            doc.font('Helvetica-Bold').fontSize(10).fillColor(active ? '#b45309' : '#222').text(
              `   ${money(d.amount, d.currency)}  ·  reason: ${d.reason}  ·  status: ${String(d.status).toUpperCase()}`);
            doc.font('Helvetica').fontSize(9).fillColor('#444').text(
              `      charge ${d.charge} · opened ${stripeTs(d.created)} · evidence due ${stripeTs(d.evidence_details?.due_by)}` +
              `${active ? '  ← RESPOND BY THIS DATE' : ''}`);
          });
          doc.fillColor('#222');
        }

        // 3. Usage
        H('3. Proof of Service Delivered & Used');
        P(`The customer spent account credits to unlock the private contact details of ${unlocked.length} motor carrier(s):`);
        doc.moveDown(0.3);
        unlocked.forEach((u: any, i: number) => {
          const l: any = listingById.get(u.listingId);
          doc.font('Helvetica').fontSize(10).fillColor('#222').text(
            `   ${i + 1}.  ${fmt(u.createdAt)}   —   MC ${l?.mcNumber || '—'}   ${l?.legalName || l?.title || '(listing ' + u.listingId + ')'}   (−${u.creditsUsed} credit)`);
        });
        if (!unlocked.length) P('   (no listings unlocked)');

        // 3b. Access activity log (with IP) — Stripe's "access activity log" evidence.
        if (accessLog?.length) {
          H('3b. Access Activity Log (IP + timestamp)');
          P('Authenticated access events recorded by the platform:');
          doc.moveDown(0.2);
          accessLog.forEach((a: any) => {
            doc.font('Helvetica').fontSize(9).fillColor('#222').text(
              `   ${fmt(a.createdAt)}   ${String(a.event).padEnd(7)}   IP ${a.ipAddress || '—'}   ${a.detail || ''}`);
          });
        }

        // 4. Credit ledger
        H('4. Account Credit Ledger');
        ledger.forEach((c: any) => {
          doc.font('Helvetica').fontSize(9).fillColor('#222').text(
            `   ${fmt(c.createdAt)}   ${String(c.type).padEnd(12)} ${String(c.amount).padStart(3)}   balance ${String(c.balance).padStart(3)}   ${c.description || ''}`);
        });
        if (!ledger.length) P('   (no credit transactions)');

        // 5. Terms
        H('5. Terms Accepted by Customer');
        P('To create an account, the customer was required to check a mandatory agreement box (signup is blocked otherwise). The statement presented and accepted reads:');
        doc.moveDown(0.2);
        doc.font('Helvetica-Oblique').fontSize(9.5).fillColor('#444').text(`“${REGISTER_CONSENT}”`, { indent: 15 });
        doc.moveDown(0.4);
        P('At the point of subscribing, the following was also displayed and agreed to:');
        doc.moveDown(0.2);
        doc.font('Helvetica-Oblique').fontSize(9.5).fillColor('#444').text(`“${CHECKOUT_CONSENT}”`, { indent: 15 });

        // Prominent electronic signature block — the customer's recorded signature.
        doc.moveDown(0.6);
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text('ELECTRONIC SIGNATURE');
        if (terms.length) {
          const t: any = terms[0];
          doc.moveDown(0.3);
          // Render the typed signature in a signature-style (italic) face.
          doc.font('Helvetica-Oblique').fontSize(24).fillColor('#0f172a').text(t.signatureName || '(unnamed)');
          const sigY = doc.y + 2;
          doc.moveTo(50, sigY).lineTo(320, sigY).strokeColor('#94a3b8').stroke();
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(9).fillColor('#444')
            .text(`Signed electronically by: ${t.signatureName || '—'}`)
            .text(`Date signed: ${fmt(t.acceptedAt)}    ·    IP address: ${t.ipAddress || 'n/a'}`)
            .text(`Terms version: ${t.termsVersion}    ·    Document ID: ${t.id}`);
          if (terms.length > 1) {
            doc.moveDown(0.2);
            doc.fillColor('#666').fontSize(8).text(`(${terms.length} acceptance records on file; most recent shown above.)`);
          }
        } else {
          doc.moveDown(0.2);
          doc.font('Helvetica').fontSize(9.5).fillColor('#b45309').text(
            'No stored electronic signature on record for this account (it predates signature capture). The customer ' +
            'still could not create the account without checking the mandatory Terms-acceptance box quoted above.');
        }
        doc.fillColor('#222');

        // 5b. Signed payment agreement captured AT CHECKOUT (per-payment signature).
        H('5b. Signed Payment Agreement (at Checkout)');
        if (paymentConsents?.length) {
          const pc: any = paymentConsents[0];
          P('At the moment of paying, the customer affirmatively agreed to the payment terms below and ' +
            'signed by typing their full legal name. This signature was captured with their IP address and a timestamp:');
          doc.moveDown(0.2);
          doc.font('Helvetica-Oblique').fontSize(9.5).fillColor('#444').text(`“${pc.consentText || CHECKOUT_CONSENT}”`, { indent: 15 });
          doc.moveDown(0.5);
          doc.font('Helvetica-Oblique').fontSize(24).fillColor('#0f172a').text(pc.signatureName || '(unnamed)');
          const pcY = doc.y + 2;
          doc.moveTo(50, pcY).lineTo(320, pcY).strokeColor('#94a3b8').stroke();
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(9).fillColor('#444')
            .text(`Signed electronically by: ${pc.signatureName || '—'}`)
            .text(`Date signed: ${fmt(pc.acceptedAt)}    ·    IP address: ${pc.ipAddress || 'n/a'}`)
            .text(`Plan: ${pc.plan || '—'}    ·    Consent version: ${pc.consentVersion}    ·    Checkout session: ${pc.stripeSessionId || '—'}`);
          if (paymentConsents.length > 1) {
            doc.moveDown(0.2);
            doc.fillColor('#666').fontSize(8).text(`(${paymentConsents.length} signed checkout agreements on file; most recent shown above.)`);
          }
        } else {
          doc.moveDown(0.2);
          doc.font('Helvetica').fontSize(9.5).fillColor('#b45309').text(
            'No per-checkout signature on record for this account (the charge predates checkout-signature capture). ' +
            'The signup Terms acceptance (§5) and Stripe’s own Terms-of-Service acceptance (§5c) still apply.');
        }
        doc.fillColor('#222');

        // 5c. Stripe-native Terms-of-Service acceptance (recorded by Stripe on the hosted checkout page).
        if (stripeTosAcceptances?.length) {
          H('5c. Terms of Service Accepted on Stripe Checkout');
          P('Stripe recorded the customer accepting the Terms of Service on its hosted, PCI-compliant checkout page:');
          doc.moveDown(0.2);
          stripeTosAcceptances.forEach((a: any) => {
            doc.font('Helvetica').fontSize(9).fillColor('#222').text(
              `   Accepted ${stripeTs(a.created)}   ·   Stripe checkout session ${a.id}`);
          });
        }

        // 6. Summary
        H('6. Summary');
        const anyFraud = stripe.disputes.some((d: any) => d.reason === 'fraudulent');
        if (anyFraud) {
          P('The chargeback is filed as "fraudulent" (unauthorized). The records show the transaction was authorized and used by the legitimate account holder:');
          doc.moveDown(0.2);
          [
            `Identity verified via Stripe Identity: ${user.identityVerified ? 'YES' : 'no'}.`,
            `Account created ${fmt(user.memberSince || user.createdAt)}, last login ${fmt(user.lastLoginAt)}.`,
            `The same card was billed and paid for multiple months before any dispute — inconsistent with an unauthorized charge.`,
            `The account consumed the paid service, unlocking ${unlocked.length} carrier contact record(s) (see §3).`,
            `The cardholder agreed to the Terms of Service at signup (see §5)${paymentConsents?.length ? ' and signed the payment terms at checkout (see §5b)' : ''}.`,
          ].forEach((b) => doc.font('Helvetica').fontSize(10).fillColor('#222').text(`   •  ${b}`));
        } else {
          P('The customer agreed to the Terms of Service (all payments final / dispute prohibition), maintained an active subscription, logged in over time, and consumed the paid service by unlocking confidential carrier contact information. The service was delivered as described.');
        }
        doc.moveDown(0.3);
        P('We respectfully request the dispute be resolved in the merchant’s favor.');

        // ── Standalone "Signed Payment Authorization" page ──────────────────
        // A self-contained one-page artifact suited to Stripe's dispute-evidence
        // `customer_signature` field: customer identity + exact payment terms +
        // the electronic signature + IP + timestamp.
        const sig: any = (paymentConsents && paymentConsents[0]) || (terms && terms[0]);
        doc.addPage();
        doc.font('Helvetica-Bold').fontSize(16).fillColor('#0f172a').text('Signed Payment Authorization', { align: 'center' });
        doc.font('Helvetica').fontSize(9).fillColor('#666').text('Electronic signature record · The Domilea Group', { align: 'center' });
        doc.moveDown(0.3);
        doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#ccc').stroke();
        doc.moveDown(0.6);
        KV('Customer', user.name);
        KV('Email', user.email);
        KV('Account ID', user.id);
        KV('Stripe Customer', user.stripeCustomerId);
        doc.moveDown(0.5);
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text('Payment terms agreed to:');
        doc.moveDown(0.2);
        doc.font('Helvetica-Oblique').fontSize(10).fillColor('#333').text(`“${(sig && sig.consentText) || CHECKOUT_CONSENT}”`, { indent: 15 });
        doc.moveDown(0.8);
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text('ELECTRONIC SIGNATURE');
        doc.moveDown(0.3);
        if (sig) {
          doc.font('Helvetica-Oblique').fontSize(28).fillColor('#0f172a').text(sig.signatureName || '(unnamed)');
          const sy = doc.y + 2;
          doc.moveTo(50, sy).lineTo(340, sy).strokeColor('#94a3b8').stroke();
          doc.moveDown(0.5);
          doc.font('Helvetica').fontSize(9.5).fillColor('#444')
            .text(`Signed electronically by: ${sig.signatureName || '—'}`)
            .text(`Date signed: ${fmt(sig.acceptedAt)}`)
            .text(`IP address: ${sig.ipAddress || 'n/a'}`)
            .text(`Consent version: ${sig.consentVersion || sig.termsVersion || '—'}    ·    Record ID: ${sig.id}`);
        } else {
          doc.font('Helvetica').fontSize(10).fillColor('#b45309').text(
            'No stored electronic signature for this account (the charge predates signature capture). ' +
            'See the Terms acceptance and Stripe-native Terms-of-Service acceptance in the evidence packet.');
        }
        doc.moveDown(0.8);
        doc.font('Helvetica').fontSize(8).fillColor('#666').text(
          'This electronic signature was captured under the U.S. E-SIGN Act. The typed name, IP address, and ' +
          'timestamp above constitute the customer’s binding agreement to the payment terms shown.');

        doc.end();
      } catch (err) {
        reject(err);
      }
    });
  }
}

export const disputeEvidenceService = new DisputeEvidenceService();
export default disputeEvidenceService;
