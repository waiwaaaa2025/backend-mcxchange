#!/usr/bin/env node
/*
 * One-shot dispute response: builds the evidence PDF, the Terms-of-Service PDF
 * and Stripe's structured evidence fields straight from the database, uploads
 * them, and stages them on the dispute WITHOUT submitting.
 *
 * Runs against the compiled build (dist/), so it works on the Heroku dyno where
 * both STRIPE_SECRET_KEY and JAWSDB_URL already exist:
 *
 *   heroku run "node scripts/stageDisputeEvidence.js --dispute du_123" -a mcxchange
 *
 * The customer is matched from the disputed charge's Stripe customer; pass
 * --user <userId> to override. Add --submit to submit immediately (irreversible
 * for this round) — by default you review in the Stripe Dashboard first.
 *
 * Locally: npm run build first, and set STRIPE_SECRET_KEY + JAWSDB_URL.
 */
const Stripe = require('stripe');
const { disputeEvidenceService } = require('../dist/services/disputeEvidenceService');
const { User } = require('../dist/models');

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

// stripe-node v20's multipart uploader hangs on Heroku dynos (a 23-byte file
// still times out after 90s, while files.stripe.com answers curl in 90ms), so
// dispute files go up over plain fetch.
async function upload(key, buffer, name) {
  const fd = new FormData();
  fd.append('purpose', 'dispute_evidence');
  fd.append('file', new Blob([buffer], { type: 'application/pdf' }), name);
  const res = await fetch('https://files.stripe.com/v1/files', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: fd,
    signal: AbortSignal.timeout(120000),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`file upload failed (${res.status}): ${json.error?.message || 'unknown error'}`);
  return json.id;
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) { console.error('Set STRIPE_SECRET_KEY'); process.exit(1); }
  const disputeId = arg('dispute');
  const submit = arg('submit', false) === true;
  if (!disputeId) {
    console.error('Usage: --dispute du_123 [--user <userId>] [--submit]');
    process.exit(1);
  }

  // PDF uploads over the dyno's network regularly exceed Stripe's 80s default.
  const stripe = new Stripe(key, { timeout: 180000, maxNetworkRetries: 2 });
  const dispute = await stripe.disputes.retrieve(disputeId);
  const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;

  // Match the cardholder to a platform account.
  let userId = arg('user');
  if (typeof userId !== 'string') {
    const charge = chargeId ? await stripe.charges.retrieve(chargeId) : null;
    const customerId = typeof charge?.customer === 'string' ? charge.customer : charge?.customer?.id;
    if (!customerId) {
      console.error(`No Stripe customer on charge ${chargeId} — this looks like a guest/payment-link sale with no`);
      console.error('platform account behind it. There is no account evidence to build; respond manually with proof');
      console.error('of delivery (see DISPUTE_RUNBOOK.md §2c). Pass --user <userId> if you know the account.');
      process.exit(3);
    }
    const user = await User.findOne({ where: { stripeCustomerId: customerId } });
    if (!user) {
      console.error(`No platform user matches Stripe customer ${customerId}. Pass --user <userId> explicitly.`);
      process.exit(3);
    }
    userId = user.id;
    console.log(`Matched ${user.name} <${user.email}> (${userId})`);
  }

  console.log(`Building evidence for dispute ${disputeId} (reason=${dispute.reason}, ` +
    `due ${dispute.evidence_details?.due_by ? new Date(dispute.evidence_details.due_by * 1000).toISOString().slice(0, 10) : '—'})...`);
  const [evidencePdf, termsPdf, built] = await Promise.all([
    disputeEvidenceService.buildEvidencePdf(userId),
    disputeEvidenceService.buildTermsOfServicePdf(),
    disputeEvidenceService.buildEvidenceFields(userId, { disputeId }),
  ]);

  if (built.meta.missing.length) {
    console.warn(`  ⚠ no data for: ${built.meta.missing.join(', ')}`);
  }

  console.log(`Uploading PDFs (evidence ${(evidencePdf.buffer.length / 1024).toFixed(0)}KB, ` +
    `terms ${(termsPdf.buffer.length / 1024).toFixed(0)}KB)...`);
  const evidenceFileId = await upload(key, evidencePdf.buffer, evidencePdf.filename);
  console.log(`  evidence uploaded: ${evidenceFileId}`);
  const termsFileId = await upload(key, termsPdf.buffer, termsPdf.filename);
  console.log(`  terms uploaded:    ${termsFileId}`);

  const evidence = {
    ...built.fields,
    uncategorized_file: evidenceFileId,
    service_documentation: evidenceFileId,
    customer_signature: evidenceFileId,
    terms_of_service: termsFileId,
    cancellation_policy: termsFileId,
  };

  console.log(`Staging on the dispute (submit=${submit})...`);
  const updated = await stripe.disputes.update(disputeId, { evidence, submit });

  console.log('\nDone.');
  console.log(`  dispute:          ${updated.id}`);
  console.log(`  status:           ${updated.status}`);
  console.log(`  submission_count: ${updated.evidence_details?.submission_count}`);
  console.log('\n  Text fields staged:');
  for (const [k, v] of Object.entries(built.fields)) {
    console.log(`    ✓ ${k.padEnd(31)} ${String(v.length).padStart(6)} chars`);
  }
  console.log(`\n  Files staged: evidence ${evidenceFileId} · terms ${termsFileId}`);
  if (!submit) {
    console.log('\nNOT submitted. Review at https://dashboard.stripe.com/disputes/' + disputeId);
    console.log('then submit there, or re-run with --submit.');
  }
}

main().catch((e) => { console.error('Failed:', e.message); process.exit(1); });
