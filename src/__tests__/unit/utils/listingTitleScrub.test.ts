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
