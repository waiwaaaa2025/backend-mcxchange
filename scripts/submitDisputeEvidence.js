#!/usr/bin/env node
/*
 * Attach dispute-evidence files to a Stripe dispute AND populate the structured
 * evidence fields issuers actually weigh (customer identity, purchase IP,
 * service date, access activity log, product description, cancellation
 * disclosure, rebuttal) — WITHOUT final submission, so you can review in the
 * Stripe Dashboard before submitting.
 *
 * Prep (download from the admin panel first):
 *   1. Admin → Users → [customer] → Download Dispute Evidence   → evidence.pdf
 *      (its last page is the standalone "Signed Payment Authorization")
 *   2. Admin → Download Terms of Service  (GET /admin/terms-of-service.pdf) → terms.pdf
 *   3. Admin → Disputes → [row] → Evidence Fields (JSON)        → fields.json
 *      (GET /admin/users/:id/dispute-evidence-fields?disputeId=dp_123&download=1)
 *
 * Usage:
 *   STRIPE_SECRET_KEY=rk_live_... node scripts/submitDisputeEvidence.js \
 *     --dispute dp_123 --evidence ./evidence.pdf --terms ./terms.pdf \
 *     [--fields ./fields.json] [--signature ./signature.pdf] [--submit]
 *
 * Without --fields the script still fills what Stripe itself knows (customer
 * name, email, billing address, service date) from the disputed charge.
 *
 * By default it uploads + fills the evidence but does NOT submit (submit=false).
 * Add --submit to submit to Stripe immediately (irreversible for this round).
 */
const Stripe = require('stripe');
const fs = require('fs');

// Stripe's per-field limit for dispute evidence text.
const MAX_FIELD_CHARS = 20000;

// Text fields Stripe accepts on a dispute's evidence object.
const TEXT_FIELDS = [
  'access_activity_log',
  'billing_address',
  'cancellation_policy_disclosure',
  'cancellation_rebuttal',
  'customer_email_address',
  'customer_name',
  'customer_purchase_ip',
  'duplicate_charge_explanation',
  'product_description',
  'refund_policy_disclosure',
  'refund_refusal_explanation',
  'service_date',
  'uncategorized_text',
];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}

function clip(value) {
  const t = String(value);
  return t.length <= MAX_FIELD_CHARS
    ? t
    : t.slice(0, MAX_FIELD_CHARS - 100) + '\n… (truncated; full record in the attached evidence PDF)';
}

async function uploadFile(stripe, path) {
  const file = await stripe.files.create({
    purpose: 'dispute_evidence',
    file: { data: fs.readFileSync(path), name: path.split('/').pop(), type: 'application/pdf' },
  });
  return file.id;
}

// Fields Stripe can supply on its own from the disputed charge — used as a
// fallback when no --fields JSON is provided (or to fill its gaps).
async function fieldsFromStripe(stripe, dispute) {
  const out = {};
  const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id;
  if (!chargeId) return out;
  let charge;
  try {
    charge = await stripe.charges.retrieve(chargeId);
  } catch (e) {
    console.warn(`  (could not retrieve charge ${chargeId}: ${e.message})`);
    return out;
  }
  const bd = charge.billing_details || {};
  if (bd.name) out.customer_name = bd.name;
  const email = bd.email || charge.receipt_email;
  if (email) out.customer_email_address = email;
  const a = bd.address;
  if (a) {
    const addr = [a.line1, a.line2, [a.city, a.state, a.postal_code].filter(Boolean).join(' '), a.country]
      .filter(Boolean).join('\n');
    if (addr) out.billing_address = addr;
  }
  if (charge.created) out.service_date = new Date(charge.created * 1000).toISOString().slice(0, 10);
  return out;
}

function loadFieldsFile(path) {
  const raw = JSON.parse(fs.readFileSync(path, 'utf8'));
  // Accepts either the admin endpoint's { fields, meta } payload or a flat object.
  const fields = raw && typeof raw === 'object' && raw.fields ? raw.fields : raw;
  const meta = raw && raw.meta ? raw.meta : null;
  const clean = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v == null || v === '') continue;
    if (!TEXT_FIELDS.includes(k)) {
      console.warn(`  (ignoring unknown evidence field "${k}")`);
      continue;
    }
    clean[k] = clip(v);
  }
  return { fields: clean, meta };
}

async function main() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) { console.error('Set STRIPE_SECRET_KEY'); process.exit(1); }

  const disputeId = arg('dispute');
  const evidencePath = arg('evidence');
  const termsPath = arg('terms');
  const signaturePath = arg('signature'); // optional; falls back to the evidence PDF
  const fieldsPath = arg('fields');       // optional; structured fields JSON from the admin panel
  const submit = arg('submit', false) === true;

  if (!disputeId || !evidencePath) {
    console.error('Usage: --dispute dp_123 --evidence ./evidence.pdf [--terms ./terms.pdf] [--fields ./fields.json] [--signature ./sig.pdf] [--submit]');
    process.exit(1);
  }
  for (const p of [evidencePath, termsPath, signaturePath, fieldsPath].filter((v) => typeof v === 'string')) {
    if (!fs.existsSync(p)) { console.error(`File not found: ${p}`); process.exit(2); }
  }

  const stripe = new Stripe(key);
  const dispute = await stripe.disputes.retrieve(disputeId);

  // ── Structured text fields ────────────────────────────────────────────────
  console.log('Building structured evidence fields...');
  const stripeDerived = await fieldsFromStripe(stripe, dispute);
  let fromFile = { fields: {}, meta: null };
  if (fieldsPath) {
    fromFile = loadFieldsFile(fieldsPath);
    if (fromFile.meta?.disputeId && fromFile.meta.disputeId !== disputeId) {
      console.warn(`  ⚠ fields file was generated for dispute ${fromFile.meta.disputeId}, not ${disputeId}`);
    }
    if (fromFile.meta?.missing?.length) {
      console.warn(`  ⚠ platform could not populate: ${fromFile.meta.missing.join(', ')}`);
    }
  } else {
    console.warn('  ⚠ no --fields JSON: filling only what Stripe knows from the charge.');
    console.warn('    Download it from Admin → Disputes → Evidence Fields (JSON) for the full set.');
  }
  // The platform's own records win over Stripe-derived values.
  const textFields = { ...stripeDerived, ...fromFile.fields };

  if (!textFields.product_description) {
    textFields.product_description = clip(
      'Marketplace subscription; credits unlock confidential motor-carrier contact data. ' +
      'Customer signed the payment terms at checkout (see attached).');
  }

  // ── Files ─────────────────────────────────────────────────────────────────
  console.log(`Uploading evidence files for dispute ${disputeId}...`);
  const evidenceFileId = await uploadFile(stripe, evidencePath);
  const termsFileId = termsPath ? await uploadFile(stripe, termsPath) : undefined;
  const signatureFileId = signaturePath ? await uploadFile(stripe, signaturePath) : evidenceFileId;

  const evidence = {
    ...textFields,
    uncategorized_file: evidenceFileId,
    customer_signature: signatureFileId,
    service_documentation: evidenceFileId,
  };
  if (termsFileId) {
    evidence.terms_of_service = termsFileId;
    evidence.cancellation_policy = termsFileId;
  }

  console.log(`Updating dispute (reason=${dispute.reason}, submit=${submit})...`);
  const updated = await stripe.disputes.update(disputeId, { evidence, submit });

  console.log('\nDone.');
  console.log(`  dispute:          ${updated.id}`);
  console.log(`  status:           ${updated.status}`);
  console.log(`  submission_count: ${updated.evidence_details?.submission_count}`);
  console.log('\n  Text fields sent:');
  for (const f of TEXT_FIELDS) {
    if (textFields[f]) console.log(`    ✓ ${f.padEnd(31)} ${String(textFields[f].length).padStart(6)} chars`);
  }
  const empty = TEXT_FIELDS.filter((f) => !textFields[f]);
  if (empty.length) console.log(`    – not applicable/empty: ${empty.join(', ')}`);
  console.log('\n  Files sent:');
  console.log(`    ✓ uncategorized_file / service_documentation: ${evidenceFileId}`);
  console.log(`    ✓ customer_signature:                         ${signatureFileId}`);
  if (termsFileId) console.log(`    ✓ terms_of_service / cancellation_policy:     ${termsFileId}`);
  if (!submit) {
    console.log('\nNOT submitted yet. Review in the Stripe Dashboard, then submit there,');
    console.log('or re-run this command with --submit to submit now.');
  }
}

main().catch((err) => { console.error('Failed:', err.message); process.exit(1); });
