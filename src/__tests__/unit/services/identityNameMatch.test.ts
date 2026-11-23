jest.mock('../../../models', () => ({ User: {}, PlatformSetting: {} }));
jest.mock('../../../services/stripeService', () => ({ stripeService: {} }));
jest.mock('../../../services/emailService', () => ({ emailService: {} }));

import { buildNameCheck, nameMismatches } from '../../../services/identityNameService';

const check = (name: string, first: string, last: string, card: string | null) =>
  nameMismatches(buildNameCheck({ name, identityFirstName: first, identityLastName: last, cardholderName: card }));

describe('name match gate (account = ID = card)', () => {
  it('passes when all three are the same person (case, middle initial)', () => {
    expect(check('John Smith', 'JOHN', 'SMITH', 'John A Smith')).toEqual([]);
  });
  it('passes with accents and compound surnames', () => {
    expect(check('José García-López', 'JOSE', 'GARCIA LOPEZ', 'JOSE GARCIA')).toEqual([]);
  });
  it('flags an account name that differs from the ID', () => {
    expect(check('Johnny S', 'JOHN', 'SMITH', 'John Smith')).toEqual(['ID name does not match account name']);
  });
  it("flags someone else's card", () => {
    expect(check('John Smith', 'JOHN', 'SMITH', 'Maria Lopez')).toEqual(['cardholder name does not match ID name']);
  });
  it('flags if any one of several cards is a stranger', () => {
    expect(check('John Smith', 'JOHN', 'SMITH', 'John Smith / Maria Lopez')).toEqual(['cardholder name does not match ID name']);
  });
  it('does not block when no cardholder name is on file', () => {
    expect(check('John Smith', 'JOHN', 'SMITH', null)).toEqual([]);
  });
});
