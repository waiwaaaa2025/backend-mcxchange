jest.mock('../../../models', () => ({ User: {}, PlatformSetting: {} }));
jest.mock('../../../services/stripeService', () => ({ stripeService: {} }));
jest.mock('../../../services/emailService', () => ({ emailService: {} }));

import { buildNameCheck, nameMismatches, adoptIdName, isCleanIdName } from '../../../services/identityNameService';

const check = (name: string, first: string, last: string, card: string | null, signupName?: string) =>
  nameMismatches(buildNameCheck({ name, signupName, identityFirstName: first, identityLastName: last, cardholderName: card }));

describe('name check (signup / ID / card), informational only', () => {
  it('nothing to report when all three are the same person', () => {
    expect(check('John Smith', 'JOHN', 'SMITH', 'John A Smith')).toEqual([]);
  });
  it('handles accents and compound surnames', () => {
    expect(check('José García-López', 'JOSE', 'GARCIA LOPEZ', 'JOSE GARCIA')).toEqual([]);
  });
  it('reports a signup name that differs from the ID, even after the account name was replaced', () => {
    expect(check('John Smith', 'JOHN', 'SMITH', 'John Smith', 'Johnny S')).toEqual(['Signed up as "Johnny S" but the ID says "JOHN SMITH"']);
  });
  it("reports someone else's card", () => {
    expect(check('John Smith', 'JOHN', 'SMITH', 'Maria Lopez')).toEqual(['Card is in the name "Maria Lopez", not the ID name "JOHN SMITH"']);
  });
  it('nothing to report when no cardholder name is on file', () => {
    expect(check('John Smith', 'JOHN', 'SMITH', null)).toEqual([]);
  });
});

describe('adoptIdName', () => {
  it('keeps the signup name and sets the account name to the (tidied) ID name', async () => {
    const user: any = { id: 'u1', name: 'Johnny S', identityFirstName: 'JOHN', identityLastName: "O'BRIEN SMITH" };
    user.update = jest.fn(async (u: any) => Object.assign(user, u));
    const nc = await adoptIdName(user);
    expect(user.signupName).toBe('Johnny S');
    expect(user.name).toBe("John O'Brien Smith");
    expect(nc.idMatchesSignup).toBe(false);
    // second run doesn't overwrite the signup name
    await adoptIdName(user);
    expect(user.signupName).toBe('Johnny S');
  });
  it('does nothing without an ID name', async () => {
    const user: any = { id: 'u2', name: 'Jane Doe', update: jest.fn() };
    await adoptIdName(user);
    expect(user.update).not.toHaveBeenCalled();
  });
});

describe('isCleanIdName', () => {
  it('accepts normal Latin names', () => {
    expect(isCleanIdName("JOHN O'BRIEN-SMITH")).toBe(true);
    expect(isCleanIdName('JOSÉ GARCÍA')).toBe(true);
  });
  it('rejects mixed-script OCR junk and single words', () => {
    expect(isCleanIdName('KoпУoг Jamshedovich Bahronov')).toBe(false);
    expect(isCleanIdName('MADONNA')).toBe(false);
  });
});
