import { mentionsAuthority } from '../../../utils/authorityTalk';

describe('mentionsAuthority', () => {
  it.each([
    'Does this come with the MC?',
    'what is your mc number',
    'MC#1363203 still active?',
    'Is the M.C. for sale too?',
    'Do you have authority with this truck',
    'USDOT 3794297?',
    'my dot number is 1234567',
    'DOT# 3794297',
    'send me the docket',
    'is it on FMCSA',
    'motor carrier included?',
  ])('blocks %s', (msg) => expect(mentionsAuthority(msg)).toBe(true));

  it.each([
    'Does it have a current annual DOT inspection?',
    'Are the tires DOT approved?',
    'How many miles on the engine?',
    'Can I pick it up in Houston next week?',
    'Is the reefer unit working? 12000 hours?',
    'Mechanic inspection before purchase ok?',
    'Price negotiable for 2 units?',
  ])('allows %s', (msg) => expect(mentionsAuthority(msg)).toBe(false));
});
