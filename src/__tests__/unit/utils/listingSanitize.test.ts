import {
  maskNumber,
  sanitizeFmcsaData,
  sanitizeListing,
  redactCarrierIntel,
} from '../../../utils/listingSanitize';

// The shape actually stored in Listing.fmcsaData, taken from a live record.
// It repeats the MC and DOT the masking is meant to withhold, and adds the
// seller's phone, email and street address.
const REAL_SNAPSHOT = JSON.stringify({
  dotNumber: '1866712',
  mcNumber: '674843',
  legalName: 'CANTY ENTERPRISES INC',
  phone: '(704) 264-5763',
  email: 'CANTYENTERPRISESINC@GMAIL.COM',
  ein: '12-3456789',
  location: { street: '12424 PINE VALLEY CLUB DR', city: 'CHARLOTTE', state: 'NC', zip: '28277' },
  physicalAddress: '12424 PINE VALLEY CLUB DR, CHARLOTTE, NC',
  powerUnits: 15,
  driverOosRate: 4.2,
  crashTotal: 3,
  safetyRating: 'SATISFACTORY',
});

describe('maskNumber', () => {
  it('hides every digit, and the digit count', () => {
    expect(maskNumber('674843')).toBe('•••••••');
    expect(maskNumber('1866712')).toBe('•••••••');
  });

  it('passes through empty values untouched', () => {
    expect(maskNumber('')).toBe('');
  });
});

describe('sanitizeFmcsaData', () => {
  it('drops every identifying field from a stored snapshot', () => {
    const out = JSON.parse(sanitizeFmcsaData(REAL_SNAPSHOT) as string);

    expect(out).not.toHaveProperty('mcNumber');
    expect(out).not.toHaveProperty('dotNumber');
    expect(out).not.toHaveProperty('phone');
    expect(out).not.toHaveProperty('email');
    expect(out).not.toHaveProperty('ein');
    expect(out).not.toHaveProperty('legalName');
    expect(out).not.toHaveProperty('location');
    expect(out).not.toHaveProperty('physicalAddress');
  });

  it('keeps the safety aggregates the marketplace cards render', () => {
    const out = JSON.parse(sanitizeFmcsaData(REAL_SNAPSHOT) as string);

    expect(out.driverOosRate).toBe(4.2);
    expect(out.crashTotal).toBe(3);
    expect(out.safetyRating).toBe('SATISFACTORY');
  });

  it('handles the nested snapshot shape the same way', () => {
    const nested = JSON.stringify({ carrier: JSON.parse(REAL_SNAPSHOT) });
    const out = JSON.parse(sanitizeFmcsaData(nested) as string);

    expect(out).not.toHaveProperty('mcNumber');
    expect(out.crashTotal).toBe(3);
  });

  it('withholds rather than passes through unparseable input', () => {
    expect(sanitizeFmcsaData('{not json')).toBeNull();
    expect(sanitizeFmcsaData(null)).toBeNull();
  });

  it('returns null when a snapshot carries no safety fields at all', () => {
    expect(sanitizeFmcsaData(JSON.stringify({ mcNumber: '674843' }))).toBeNull();
  });
});

describe('sanitizeListing', () => {
  const listing = {
    id: 'abc',
    mcNumber: '674843',
    dotNumber: '1866712',
    contactEmail: 'seller@example.com',
    contactPhone: '555-0100',
    fmcsaData: REAL_SNAPSHOT,
    legalName: 'CANTY ENTERPRISES INC',
    dbaName: 'CANTY TRUCKING',
    address: '12424 PINE VALLEY CLUB DR, CHARLOTTE, NC',
    city: 'CHARLOTTE',
    askingPrice: '15000.00',
    state: 'NC',
  };

  it('leaves no route to the real MC or DOT anywhere in the payload', () => {
    const out = sanitizeListing(listing);
    const serialized = JSON.stringify(out);

    expect(serialized).not.toContain('674843');
    expect(serialized).not.toContain('1866712');
    expect(out.mcNumber).toBe('•••••••');
    expect(out.dotNumber).toBe('•••••••');
  });

  it('withholds the seller contact details', () => {
    const out = sanitizeListing(listing);

    expect(out.contactEmail).toBeNull();
    expect(out.contactPhone).toBeNull();
    expect(JSON.stringify(out)).not.toContain('seller@example.com');
  });

  it('withholds the name and street address, which lead straight back to the MC', () => {
    const out = sanitizeListing(listing);

    expect(out.legalName).toBeNull();
    expect(out.dbaName).toBeNull();
    expect(out.address).toBeNull();
    expect(JSON.stringify(out)).not.toContain('CANTY');
    expect(JSON.stringify(out)).not.toContain('PINE VALLEY');
  });

  it('withholds the seller companyName, which repeats the carrier name', () => {
    const out = sanitizeListing({
      ...listing,
      seller: { id: 's1', name: 'Patricia Canty', companyName: 'CANTY ENTERPRISES INC', trustScore: 70 },
    });

    expect(out.seller.companyName).toBeNull();
    expect(JSON.stringify(out)).not.toContain('CANTY ENTERPRISES');
    // The seller's display name is the point of the marketplace — it stays.
    expect(out.seller.name).toBe('Patricia Canty');
    expect(out.seller.trustScore).toBe(70);
  });

  it('keeps city and state, which the cards show', () => {
    const out = sanitizeListing(listing);

    expect(out.city).toBe('CHARLOTTE');
    expect(out.state).toBe('NC');
  });

  it('never emits _realDotNumber', () => {
    const out = sanitizeListing({ ...listing, _realDotNumber: '1866712' });

    expect(out).not.toHaveProperty('_realDotNumber');
  });

  it('keeps the non-identifying listing fields intact', () => {
    const out = sanitizeListing(listing);

    expect(out.askingPrice).toBe('15000.00');
    expect(out.state).toBe('NC');
    expect(out.id).toBe('abc');
  });

  it('accepts a Sequelize instance via toJSON', () => {
    const instance = { toJSON: () => ({ ...listing }) };
    const out = sanitizeListing(instance);

    expect(out.mcNumber).toBe('•••••••');
  });
});

describe('redactCarrierIntel', () => {
  // Mirrors the live /carrier-data/report shape: identity sits on `carrier`,
  // and the SMS block repeats the DOT.
  const BUNDLE = {
    carrierReport: {
      carrier: {
        dotNumber: '1866712',
        mcNumber: '674843',
        legalName: 'CANTY ENTERPRISES INC',
        phone: '(704) 264-5763',
        email: 'CANTYENTERPRISESINC@GMAIL.COM',
        location: { street: '12424 PINE VALLEY CLUB DR', city: 'CHARLOTTE', state: 'NC', zip: '28277' },
        powerUnits: 15,
        safetyRating: 'SATISFACTORY',
      },
      documents: {
        dockets: [{ docketNumber: 'MC-674843', type: 'COMMON', status: 'ACTIVE' }],
      },
      safety: { basicScores: [{ category: 'Unsafe Driving', percentile: 42 }] },
    },
    sms: { dotNumber: '1866712', totalCrashes: 3, driverOosRate: 4.2 },
    cargoTypes: ['General Freight'],
    authority: { commonAuthorityStatus: 'A', grantDate: '2009-03-19' },
    insurance: [{ insurerName: 'PROGRESSIVE', policyNumber: 'P-99', coverageAmount: 1000000 }],
  };

  const IDENTITY = {
    mcNumber: '674843',
    dotNumber: '1866712',
    legalName: 'CANTY ENTERPRISES INC',
  };

  it('leaves no trace of the MC, DOT or legal name anywhere in the bundle', () => {
    const serialized = JSON.stringify(redactCarrierIntel(BUNDLE, IDENTITY));

    expect(serialized).not.toContain('674843');
    expect(serialized).not.toContain('1866712');
    expect(serialized).not.toContain('CANTY ENTERPRISES');
  });

  it('nulls contact and address fields wherever they are nested', () => {
    const out = redactCarrierIntel(BUNDLE, IDENTITY);

    expect(out.carrierReport.carrier.phone).toBeNull();
    expect(out.carrierReport.carrier.email).toBeNull();
    expect(out.carrierReport.carrier.legalName).toBeNull();
    expect(out.carrierReport.carrier.location.street).toBeNull();
    expect(out.carrierReport.carrier.location.zip).toBeNull();
    expect(out.carrierReport.documents.dockets[0].docketNumber).toBeNull();
  });

  it('scrubs the docket number even though it is not a bare MC string', () => {
    const out = redactCarrierIntel(BUNDLE, IDENTITY);

    expect(JSON.stringify(out.carrierReport.documents)).not.toContain('674843');
  });

  it('keeps the safety record, which is what the panel is for', () => {
    const out = redactCarrierIntel(BUNDLE, IDENTITY);

    expect(out.sms.totalCrashes).toBe(3);
    expect(out.sms.driverOosRate).toBe(4.2);
    expect(out.carrierReport.carrier.powerUnits).toBe(15);
    expect(out.carrierReport.safety.basicScores[0].percentile).toBe(42);
    expect(out.carrierReport.carrier.location.city).toBe('CHARLOTTE');
    expect(out.authority.commonAuthorityStatus).toBe('A');
    expect(out.cargoTypes).toEqual(['General Freight']);
  });

  it('does not mistake the insurer name for the carrier name', () => {
    const out = redactCarrierIntel(BUNDLE, IDENTITY);

    expect(out.insurance[0].insurerName).toBe('PROGRESSIVE');
    expect(out.insurance[0].coverageAmount).toBe(1000000);
  });

  it('ignores identity values too short to match safely', () => {
    const out = redactCarrierIntel({ safety: { percentile: 42 } }, { dotNumber: '42' });

    expect(out.safety.percentile).toBe(42);
  });
});
