import { sellerNetPayout } from '../../../utils/helpers';

describe('sellerNetPayout', () => {
  it('pays agreed minus fee when the deal closed below asking (the bug)', () => {
    // $20,000 asking, $15,000 agreed, 3% fee — was owed $20,000 before.
    expect(sellerNetPayout(15000, 450, null, 20000)).toBe(14550);
  });
  it('pays the asking price when the buyer paid above it (Domilea keeps the spread)', () => {
    expect(sellerNetPayout(13000, 390, null, 10000)).toBe(10000);
  });
  it('uses a negotiated seller net instead of asking, under the same cap', () => {
    expect(sellerNetPayout(13000, 390, 11000, 10000)).toBe(11000);
    expect(sellerNetPayout(13000, 390, 15000, 10000)).toBe(12610);
  });
  it('falls back to agreed minus fee with no asking price', () => {
    expect(sellerNetPayout(9250, 277.5)).toBe(8972.5);
  });
});
