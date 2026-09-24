import { parseFinalPaymentSplit } from '../../../controllers/webhookController';

describe('parseFinalPaymentSplit', () => {
  it('Connect split that covers the whole payout', () => {
    // $13,000 agreed, $390 fee, $1,300 deposit → final $11,700 < payout $12,610
    // would be partial; here final covers it (small deposit).
    expect(
      parseFinalPaymentSplit({
        payoutMode: 'connect_split',
        sellerPayout: '1261000',
        applicationFee: '0',
        sellerPayoutTotal: '1261000',
        platformFeeTotal: '39000',
      })
    ).toEqual({ sellerPayout: 12610, platformFee: 390, paidViaConnect: true, paidAtCharge: 12610 });
  });

  it('Connect split that leaves a remainder for the admin release', () => {
    // $15,000 agreed, $450 fee, $1,500 deposit → final $13,500; seller owed $14,550.
    expect(
      parseFinalPaymentSplit({
        payoutMode: 'connect_split',
        sellerPayout: '1350000',
        applicationFee: '0',
        sellerPayoutTotal: '1455000',
        platformFeeTotal: '45000',
      })
    ).toEqual({ sellerPayout: 14550, platformFee: 450, paidViaConnect: true, paidAtCharge: 13500 });
  });

  it('platform-collected final payment (manual release)', () => {
    expect(
      parseFinalPaymentSplit({
        payoutMode: 'manual',
        sellerPayout: '1455000',
        applicationFee: '45000',
        sellerPayoutTotal: '1455000',
        platformFeeTotal: '45000',
      })
    ).toEqual({ sellerPayout: 14550, platformFee: 450, paidViaConnect: false, paidAtCharge: 0 });
  });

  it('payoutMode sessions from before totals were added', () => {
    expect(parseFinalPaymentSplit({ payoutMode: 'connect_split', sellerPayout: '1000000', applicationFee: '200000' })).toEqual({
      sellerPayout: 10000,
      platformFee: 2000,
      paidViaConnect: true,
      paidAtCharge: 10000,
    });
  });

  it('legacy Connect sessions without payoutMode', () => {
    expect(parseFinalPaymentSplit({ sellerPayout: '1000000', applicationFee: '200000' })).toEqual({
      sellerPayout: 10000,
      platformFee: 2000,
      paidViaConnect: true,
      paidAtCharge: 10000,
    });
  });

  it('legacy fallback sessions that sent dollars under platformFee', () => {
    expect(parseFinalPaymentSplit({ sellerPayout: '10000', platformFee: '2000' })).toEqual({
      sellerPayout: 10000,
      platformFee: 2000,
      paidViaConnect: false,
      paidAtCharge: 0,
    });
  });
});
