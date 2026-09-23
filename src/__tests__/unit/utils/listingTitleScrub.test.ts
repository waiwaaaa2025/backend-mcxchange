import { publicListingTitle, scrubIdentity, sanitizeListing } from '../../../utils/listingSanitize';

const id = { mcNumber: '558123', dotNumber: '1328075', legalName: 'LDN EXPRESS INC', dbaName: 'LDN' };

describe('listing title/description scrub', () => {
  it('replaces the auto-filled "<name> - DOT #<dot>" title with a neutral one', () => {
    expect(publicListingTitle({ ...id, title: 'LDN EXPRESS INC - DOT #1328075', state: 'GA' }))
      .toBe('GA Motor Carrier Authority');
  });

  it('keeps the seller-written part of a title', () => {
    expect(publicListingTitle({ ...id, title: 'Clean 5yr authority, Amazon ready - MC 558123', state: 'GA' }))
      .toBe('Clean 5yr authority, Amazon ready');
  });

  it('removes numbers and names from descriptions, case-insensitively', () => {
    const out = scrubIdentity('ldn express inc for sale. USDOT: 1328075, MC#558123. Call us.', id);
    expect(out).not.toMatch(/1328075|558123|ldn/i);
    expect(out).toContain('for sale');
  });

  it('sanitizeListing never returns identity in title or description', () => {
    const safe = sanitizeListing({ ...id, title: 'LDN EXPRESS INC - DOT #1328075', description: 'DOT 1328075', state: 'GA' });
    expect(JSON.stringify([safe.title, safe.description])).not.toMatch(/1328075|558123|LDN/i);
  });
});

describe('identity leaks found by the anonymous probe', () => {
  it('replaces a seller display name that is the carrier legal name', () => {
    const safe = sanitizeListing({ ...id, title: 't', seller: { name: 'LDN Express', companyName: 'x' } });
    expect(safe.seller.name).toBe('Verified Seller');
    expect(sanitizeListing({ ...id, title: 't', seller: { name: 'Zee' } }).seller.name).toBe('Zee');
  });

  it('redacts docket_number and bare-digit MCs in carrier intel', () => {
    const { redactCarrierIntel } = require('../../../utils/listingSanitize');
    const out = redactCarrierIntel(
      { documents: { dockets: [{ docket_number: '1462480', prefix: 'MC' }] }, note: 'see 1462480' },
      { mcNumber: 'MC1462480', dotNumber: '3939259', legalName: 'MORPRO INC' }
    );
    expect(JSON.stringify(out)).not.toContain('1462480');
  });
});
