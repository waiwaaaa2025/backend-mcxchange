/**
 * Viewer-scoped sanitizing for listing responses.
 *
 * The marketplace sells the link between a listing and the carrier behind it,
 * so MC/DOT are masked until a buyer unlocks. Masking those two columns is not
 * enough on its own: the `fmcsaData` snapshot stored alongside them repeats the
 * same MC and DOT verbatim and adds the seller's phone, email, EIN and street
 * address. Anything bound for a viewer who has not unlocked goes through here,
 * so there is one place to audit rather than one per controller.
 */

// Safety and inspection aggregates the marketplace cards read out of fmcsaData
// (see MarketplacePage.transformListing / VipMarketplacePage). Every other key —
// mcNumber, dotNumber, phone, email, ein, legalName, location — identifies the
// carrier and is dropped. Allowlist, not denylist: a new identifying field added
// to the snapshot upstream stays out by default instead of leaking until noticed.
const FMCSA_SAFETY_FIELDS = [
  'totalInspections',
  'driverInsp',
  'totalDriverInspections',
  'driverOosInsp',
  'driverOosInspections',
  'driverOosRate',
  'vehicleInsp',
  'vehicleInspections',
  'vehicleOosInsp',
  'vehicleOosInspections',
  'vehicleOosRate',
  'crashTotal',
  'totalCrashes',
  'fatalCrash',
  'fatalCrashes',
  'injuryCrash',
  'injuryCrashes',
  'towawayCrash',
  'towawayCrashes',
  'safetyRating',
  'safetyRatingDate',
] as const;

// Mask an MC/DOT number: show first half, replace rest with bullets
export function maskNumber(num: string): string {
  if (!num) return num;
  const half = Math.ceil(num.length / 2);
  return num.substring(0, half) + '•'.repeat(num.length - half);
}

function pickSafetyFields(source: any): Record<string, unknown> | null {
  if (!source || typeof source !== 'object') return null;
  const out: Record<string, unknown> = {};
  for (const field of FMCSA_SAFETY_FIELDS) {
    if (source[field] !== undefined && source[field] !== null) out[field] = source[field];
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Reduce a stored fmcsaData snapshot to its non-identifying safety fields.
 * Returns a JSON string (the column's stored shape) or null when nothing
 * survives. Unparseable input is withheld rather than passed through.
 */
export function sanitizeFmcsaData(raw: unknown): string | null {
  if (!raw) return null;

  let parsed: any;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }
  } else {
    parsed = raw;
  }

  // Written in two shapes over time: flat, and nested under `carrier` (the
  // FMCSA snapshot format). Readers on the client already handle both.
  const safe = pickSafetyFields(parsed?.carrier ?? parsed);
  return safe ? JSON.stringify(safe) : null;
}

interface ListingIdentity {
  mcNumber?: string | null;
  dotNumber?: string | null;
  legalName?: string | null;
  dbaName?: string | null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Remove the carrier's own MC, DOT, legal name and DBA from seller-written text.
 *
 * The listing form used to pre-fill the title as "<LEGAL NAME> - DOT #<dot>",
 * so masking the mcNumber/dotNumber columns left the same values in clear one
 * field over — on the site, in search (title is LIKE-matched) and in Telegram
 * posts. Any "MC#"/"DOT #" label left standing is dropped with its number, and
 * the separators the removal strands are tidied away.
 */
export function scrubIdentity(text: string | null | undefined, identity: ListingIdentity): string {
  if (!text) return text ?? '';
  let out = text;

  const names = [identity.legalName, identity.dbaName]
    .map((s) => (s ?? '').toString().trim())
    .filter((s) => s.length > 2);
  for (const name of names) {
    out = out.replace(new RegExp(escapeRegExp(name), 'gi'), '');
  }

  const numbers = [identity.mcNumber, identity.dotNumber]
    .map((s) => (s ?? '').toString().replace(/\D/g, ''))
    .filter((s) => s.length > 2);
  for (const num of numbers) {
    // Take an adjacent "MC"/"DOT"/"USDOT" label (with #, :, "number") along with it.
    const labelled = new RegExp(
      `\\b(?:US\\s*)?(?:DOT|MC)\\s*(?:#|No\\.?|number|num)?\\s*[:#-]?\\s*${num}\\b`,
      'gi'
    );
    out = out.replace(labelled, '').replace(new RegExp(`\\b${num}\\b`, 'g'), '');
  }

  // Nothing identifying found: hand the seller's text back exactly as written.
  if (out === text) return text;

  return out
    .replace(/\s*[-–—|,:]\s*(?=[-–—|,:]|$)/g, '') // separators with nothing after them
    .replace(/^\s*[-–—|,:]\s*/, '')                // ...or before them
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** A listing title safe to show anyone: scrubbed, with a neutral fallback. */
export function publicListingTitle(listing: ListingIdentity & { title?: string | null; state?: string | null }): string {
  const scrubbed = scrubIdentity(listing.title, listing);
  if (scrubbed.length >= 3) return scrubbed;
  return listing.state ? `${listing.state} Motor Carrier Authority` : 'Motor Carrier Authority';
}

/**
 * Strip a listing down to what a viewer who has not unlocked it may see.
 * Accepts a Sequelize instance or a plain object; always returns a plain object.
 */
export function sanitizeListing(listing: any): any {
  const safe = listing?.toJSON ? listing.toJSON() : { ...listing };

  // Scrub free text while the real values are still here to match against.
  const identity = {
    mcNumber: safe.mcNumber,
    dotNumber: safe._realDotNumber || safe.dotNumber,
    legalName: safe.legalName,
    dbaName: safe.dbaName,
  };
  safe.title = publicListingTitle({ ...identity, title: safe.title, state: safe.state });
  if (safe.description) safe.description = scrubIdentity(safe.description, identity);

  safe.mcNumber = maskNumber(safe.mcNumber);
  if (safe.dotNumber) safe.dotNumber = maskNumber(safe.dotNumber);
  safe.fmcsaData = sanitizeFmcsaData(safe.fmcsaData);

  // The seller's direct line, released on unlock like seller.email/phone.
  safe.contactEmail = null;
  safe.contactPhone = null;

  // Masking the numbers accomplishes nothing while the name and street address
  // travel in clear — either one is a single public FMCSA lookup away from the
  // MC. No public page renders them; buyerController already withholds
  // legalName the same way for unmatched buyers. City/state stay: the cards
  // show them and they are too coarse to identify a carrier.
  safe.legalName = null;
  safe.dbaName = null;
  safe.address = null;

  // The seller's companyName is usually the carrier's legal name verbatim, so
  // it reopens the same hole one level down. The seller's display name stays —
  // knowing who you're buying from is the point of the marketplace.
  if (safe.seller) {
    safe.seller = { ...safe.seller, companyName: null };
  }

  // Belt and braces: never let an unmasked DOT ride along under another name.
  delete safe._realDotNumber;

  return safe;
}

// Keys that identify the carrier rather than describe its safety record.
// Matched case-insensitively against every key in the upstream payloads, which
// are typed `any` and reshape whenever MorPro/FMCSA change — a denylist walked
// over the whole tree beats allowlisting thirteen sections of unknown shape.
// `insurerName` and the BASIC category names deliberately do not match.
const IDENTITY_KEYS = new Set([
  'legalname', 'dbaname', 'carriername', 'companyname', 'ownername', 'contactname',
  'dotnumber', 'usdot', 'usdotnumber', 'mcnumber', 'docketnumber', 'docket',
  'phone', 'telephone', 'phonenumber', 'cellphone', 'fax',
  'email', 'emailaddress',
  'street', 'phystreet', 'mailingstreet',
  'address', 'physicaladdress', 'mailingaddress', 'addressline1', 'addressline2',
  'zip', 'zipcode', 'postalcode',
  'ein', 'taxid',
]);

function redactTree(node: any): any {
  if (Array.isArray(node)) return node.map(redactTree);
  if (!node || typeof node !== 'object') return node;

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    out[key] = IDENTITY_KEYS.has(key.toLowerCase()) ? null : redactTree(value);
  }
  return out;
}

/**
 * Strip carrier identity out of the /listings/:id/carrier-intel bundle for a
 * viewer who has not unlocked the listing.
 *
 * Two passes, because one is not enough on its own. The key walk handles fields
 * we can name; the value scrub then removes any surviving occurrence of this
 * listing's real MC, DOT or legal name — including numbers embedded in free text
 * or in a section whose shape we have not seen. Nothing here is guesswork: the
 * caller knows the true values, so it can verify its own output.
 */
export function redactCarrierIntel(
  bundle: any,
  identity: { mcNumber?: string | null; dotNumber?: string | null; legalName?: string | null }
): any {
  const redacted = redactTree(bundle);

  const secrets = [identity.mcNumber, identity.dotNumber, identity.legalName]
    .map((s) => (s ?? '').toString().trim())
    // Two characters or fewer would match far too much of the payload.
    .filter((s) => s.length > 2);

  if (secrets.length === 0) return redacted;

  let serialized = JSON.stringify(redacted);
  for (const secret of secrets) {
    // Escape for use as a literal pattern, then blank every occurrence.
    const pattern = new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    serialized = serialized.replace(pattern, '');
  }

  return JSON.parse(serialized);
}
