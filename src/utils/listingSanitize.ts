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

/**
 * Strip a listing down to what a viewer who has not unlocked it may see.
 * Accepts a Sequelize instance or a plain object; always returns a plain object.
 */
export function sanitizeListing(listing: any): any {
  const safe = listing?.toJSON ? listing.toJSON() : { ...listing };

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
