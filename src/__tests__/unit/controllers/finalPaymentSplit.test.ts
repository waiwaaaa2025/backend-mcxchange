import { parseFinalPaymentSplit } from '../../../controllers/webhookController';

describe('parseFinalPaymentSplit', () => {
  it('reads a Connect split (cents) as paid to the seller', () => {
    expect(
      parseFinalPaymentSplit({ type: 'final_payment', sellerPayout: '1000000', applicationFee: '200000', payoutMode: 'connect_split' })
    ).toEqual({ sellerPayout: 10000, platformFee: 2000, paidViaConnect: true });
  });

  it('reads the platform-collected path (cents) as needing a manual payout', () => {
    expect(
      parseFinalPaymentSplit({ type: 'final_payment', sellerPayout: '1000000', applicationFee: '200000', payoutMode: 'manual' })
    ).toEqual({ sellerPayout: 10000, platformFee: 2000, paidViaConnect: false });
  });

  it('handles legacy Connect sessions without payoutMode', () => {
    expect(parseFinalPaymentSplit({ sellerPayout: '1000000', applicationFee: '200000' })).toEqual({
      sellerPayout: 10000,
      platformFee: 2000,
      paidViaConnect: true,
    });
  });

  it('handles legacy fallback sessions that sent dollars under platformFee', () => {
    // The bug: this used to be stored as $100 payout and $0 fee.
    expect(parseFinalPaymentSplit({ sellerPayout: '10000', platformFee: '2000' })).toEqual({
      sellerPayout: 10000,
      platformFee: 2000,
      paidViaConnect: false,
    });
  });
});
