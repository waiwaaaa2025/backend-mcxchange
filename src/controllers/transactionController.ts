import { Response } from 'express';
import { body } from 'express-validator';
import { transactionService } from '../services/transactionService';
import stripeService from '../services/stripeService';
import { asyncHandler, NotFoundError, ForbiddenError, BadRequestError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { PaymentMethod, TransactionStatus, Transaction, Listing, User, Offer } from '../models';
import { calculatePlatformFee, sellerNetPayout } from '../utils/helpers';
import { config } from '../config';

// Validation rules
export const paymentValidation = [
  body('paymentMethod')
    .isIn(['STRIPE', 'ZELLE', 'WIRE', 'CHECK'])
    .withMessage('Invalid payment method'),
  body('reference').optional().trim(),
];

export const messageValidation = [
  body('content').trim().notEmpty().withMessage('Message content is required'),
];

// Get transaction by ID
export const getTransaction = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  const transaction = await transactionService.getTransactionById(id, req.user.id);

  res.json({
    success: true,
    data: transaction,
  });
});

// Get user's transactions
export const getMyTransactions = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const transactions = await transactionService.getUserTransactions(req.user.id, req.user.role);

  res.json({
    success: true,
    data: transactions,
  });
});

// Buyer accepts terms
export const buyerAcceptTerms = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  const transaction = await transactionService.buyerAcceptTerms(id, req.user.id);

  res.json({
    success: true,
    data: transaction,
    message: 'Terms accepted',
  });
});

// Seller accepts terms
export const sellerAcceptTerms = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  const transaction = await transactionService.sellerAcceptTerms(id, req.user.id);

  res.json({
    success: true,
    data: transaction,
    message: 'Terms accepted',
  });
});

// Pay deposit
export const payDeposit = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { paymentMethod, reference } = req.body;

  const payment = await transactionService.recordDeposit(
    id,
    req.user.id,
    paymentMethod as PaymentMethod,
    reference
  );

  res.json({
    success: true,
    data: payment,
    message: paymentMethod === 'STRIPE'
      ? 'Processing payment...'
      : 'Deposit submitted. Awaiting admin verification.',
  });
});

// Verify deposit (admin)
export const verifyDeposit = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id, paymentId } = req.params;

  await transactionService.verifyDeposit(id, req.user.id, paymentId);

  res.json({
    success: true,
    message: 'Deposit verified',
  });
});

// Buyer approval
export const buyerApprove = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  const transaction = await transactionService.buyerApprove(id, req.user.id);

  res.json({
    success: true,
    data: transaction,
    message: 'Buyer approval recorded',
  });
});

// Seller approval
export const sellerApprove = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  const transaction = await transactionService.sellerApprove(id, req.user.id);

  res.json({
    success: true,
    data: transaction,
    message: 'Seller approval recorded',
  });
});

// Admin approval
export const adminApprove = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  const transaction = await transactionService.adminApprove(id, req.user.id);

  res.json({
    success: true,
    data: transaction,
    message: 'Admin approval recorded. Ready for final payment.',
  });
});

// Pay final amount
export const payFinal = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { paymentMethod, reference } = req.body;

  const payment = await transactionService.recordFinalPayment(
    id,
    req.user.id,
    paymentMethod as PaymentMethod,
    reference
  );

  res.json({
    success: true,
    data: payment,
    message: paymentMethod === 'STRIPE'
      ? 'Processing payment...'
      : 'Payment submitted. Awaiting admin verification.',
  });
});

// Verify final payment (admin)
export const verifyFinalPayment = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id, paymentId } = req.params;

  await transactionService.verifyFinalPayment(id, req.user.id, paymentId);

  res.json({
    success: true,
    message: 'Payment verified. Transaction completed.',
  });
});

// Cancel transaction
export const cancelTransaction = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { reason } = req.body;

  await transactionService.cancelTransaction(id, req.user.id, reason || 'No reason provided');

  res.json({
    success: true,
    message: 'Transaction cancelled',
  });
});

// Open dispute
export const openDispute = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { reason } = req.body;

  if (!reason) {
    res.status(400).json({ success: false, error: 'Dispute reason is required' });
    return;
  }

  const transaction = await transactionService.openDispute(id, req.user.id, reason);

  res.json({
    success: true,
    data: transaction,
    message: 'Dispute opened',
  });
});

// Send message
export const sendMessage = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { content } = req.body;

  const message = await transactionService.sendMessage(id, req.user.id, content);

  res.json({
    success: true,
    data: message,
  });
});

// Update status (admin)
export const updateStatus = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { status, notes } = req.body;

  const transaction = await transactionService.updateStatus(
    id,
    req.user.id,
    status as TransactionStatus,
    notes
  );

  res.json({
    success: true,
    data: transaction,
    message: 'Status updated',
  });
});

// Create deposit checkout session (Stripe) for a transaction
export const createDepositCheckout = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  // Get the transaction with listing
  const transaction = await Transaction.findByPk(id, {
    include: [
      {
        model: Listing,
        as: 'listing',
      },
    ],
  });

  if (!transaction) {
    throw new NotFoundError('Transaction not found');
  }

  // Verify the buyer owns this transaction
  if (transaction.buyerId !== req.user.id) {
    throw new ForbiddenError('You do not have permission to pay for this transaction');
  }

  // Verify transaction is awaiting deposit
  if (transaction.status !== TransactionStatus.AWAITING_DEPOSIT) {
    throw new BadRequestError('Transaction is not awaiting deposit payment');
  }

  // Get buyer info
  const buyer = await User.findByPk(req.user.id);
  if (!buyer) {
    throw new NotFoundError('Buyer not found');
  }

  // Get or create Stripe customer for the buyer (validates existing ID and recreates if invalid)
  const customer = await stripeService.getOrCreateCustomer(
    buyer.id,
    buyer.email,
    buyer.name,
    buyer.stripeCustomerId || undefined
  );
  const stripeCustomerId = customer.id;

  // Update user's stripeCustomerId if it changed (new customer created or old one was invalid)
  if (stripeCustomerId !== buyer.stripeCustomerId) {
    await buyer.update({ stripeCustomerId });
  }

  // Accept custom deposit amount from request body, default to $1,000
  const depositAmountDollars = req.body.depositAmount ? Number(req.body.depositAmount) : 1000;
  if (depositAmountDollars < 1 || depositAmountDollars > 1000000) {
    throw new BadRequestError('Deposit amount must be between $1 and $1,000,000');
  }
  const depositAmountCents = Math.round(depositAmountDollars * 100);

  // Get MC number from listing
  const mcNumber = transaction.listing?.mcNumber || 'Unknown';

  // Create Stripe checkout session
  const frontendUrl = config.frontendUrl || 'http://localhost:5173';
  const result = await stripeService.createDepositCheckout({
    customerId: stripeCustomerId,
    amount: depositAmountCents,
    buyerId: req.user.id,
    transactionId: transaction.id,
    offerId: transaction.offerId || '',
    mcNumber: mcNumber,
    successUrl: `${frontendUrl}/transaction/${transaction.id}?deposit=success`,
    cancelUrl: `${frontendUrl}/transaction/${transaction.id}?deposit=cancelled`,
  });

  if (!result.success) {
    throw new BadRequestError(result.error || 'Failed to create checkout session');
  }

  res.json({
    success: true,
    data: {
      sessionId: result.sessionId,
      url: result.url,
    },
  });
});

// Create final payment checkout session
// Collects the full remaining balance to the platform's Stripe account.
// If the seller has a fully onboarded Connect account, the payment is
// automatically split (seller payout via Connect, platform keeps commission).
// Otherwise, the full amount goes to the platform for manual payout later.
export const createFinalPaymentCheckout = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  // Get transaction with listing and seller
  const transaction = await Transaction.findByPk(id, {
    include: [
      { model: Listing, as: 'listing' },
      { model: User, as: 'seller' },
    ],
  });

  if (!transaction) {
    throw new NotFoundError('Transaction not found');
  }

  // Verify the buyer owns this transaction
  if (transaction.buyerId !== req.user.id) {
    throw new ForbiddenError('You do not have permission to pay for this transaction');
  }

  // Verify transaction is ready for final payment
  if (transaction.status !== TransactionStatus.PAYMENT_PENDING) {
    throw new BadRequestError('Transaction is not ready for final payment');
  }

  // Get buyer
  const buyer = await User.findByPk(req.user.id);
  if (!buyer) {
    throw new NotFoundError('Buyer not found');
  }

  // Get or create Stripe customer for the buyer
  const customer = await stripeService.getOrCreateCustomer(
    buyer.id,
    buyer.email,
    buyer.name,
    buyer.stripeCustomerId || undefined
  );
  const stripeCustomerId = customer.id;

  if (stripeCustomerId !== buyer.stripeCustomerId) {
    await buyer.update({ stripeCustomerId });
  }

  // Calculate amounts. The seller is owed their asking price (or a negotiated
  // net) capped at agreed − platform fee; Domilea keeps the rest.
  const listing = (transaction as any).listing;
  const agreedPrice = Number(transaction.agreedPrice);
  const depositAmount = Number(transaction.depositAmount || 0);
  const finalPaymentAmount = agreedPrice - depositAmount;
  const offer = transaction.offerId ? await Offer.findByPk(transaction.offerId, { attributes: ['sellerAmount'] }) : null;
  const feeBasis = transaction.platformFee != null ? Number(transaction.platformFee) : calculatePlatformFee(agreedPrice);
  const sellerPayout = sellerNetPayout(agreedPrice, feeBasis, offer?.sellerAmount, listing?.askingPrice);
  const platformCommission = Math.round((agreedPrice - sellerPayout) * 100) / 100; // Domilea's total take
  // The deposit was collected by Domilea, so this charge may not cover the
  // whole seller payout; any rest is released by an admin at closing.
  const sellerFromThisCharge = Math.min(sellerPayout, Math.max(finalPaymentAmount, 0));

  if (finalPaymentAmount <= 0) {
    throw new BadRequestError('Invalid final payment amount');
  }

  const mcNumber = listing?.mcNumber || 'N/A';
  const frontendUrl = config.frontendUrl || 'http://localhost:5173';

  // Check if seller has a fully onboarded Connect account for auto-split
  const seller = await User.findByPk(transaction.sellerId);
  let useConnectSplit = false;
  if (seller?.stripeAccountId) {
    useConnectSplit = await stripeService.isAccountOnboarded(seller.stripeAccountId);
  }

  let result;

  if (useConnectSplit && seller?.stripeAccountId) {
    // Seller has Connect account — auto-split payment
    result = await stripeService.createFinalPaymentCheckout({
      customerId: stripeCustomerId,
      amount: Math.round(finalPaymentAmount * 100),
      sellerPayout: Math.round(sellerFromThisCharge * 100),
      extraMetadata: {
        sellerPayoutTotal: String(Math.round(sellerPayout * 100)),
        platformFeeTotal: String(Math.round(platformCommission * 100)),
      },
      sellerConnectedAccountId: seller.stripeAccountId,
      buyerId: req.user.id,
      sellerId: transaction.sellerId,
      transactionId: transaction.id,
      mcNumber,
      successUrl: `${frontendUrl}/transaction/${transaction.id}?payment=success`,
      cancelUrl: `${frontendUrl}/transaction/${transaction.id}?payment=cancelled`,
    });
  } else {
    // No seller Connect account — collect full amount to platform
    result = await stripeService.createDepositCheckout({
      customerId: stripeCustomerId,
      amount: Math.round(finalPaymentAmount * 100),
      buyerId: req.user.id,
      transactionId: transaction.id,
      offerId: transaction.offerId || '',
      mcNumber,
      successUrl: `${frontendUrl}/transaction/${transaction.id}?payment=success`,
      cancelUrl: `${frontendUrl}/transaction/${transaction.id}?payment=cancelled`,
      productName: 'MC Authority - Final Payment',
      productDescription: `Final payment for MC #${mcNumber} purchase`,
      // Amounts in cents under the same keys as the Connect split, so the
      // webhook records them the same way. payoutMode tells it the platform
      // holds the funds and an admin must release the seller's payout.
      metadata: {
        type: 'final_payment',
        sellerId: transaction.sellerId,
        sellerPayout: String(Math.round(sellerPayout * 100)),
        applicationFee: String(Math.round(platformCommission * 100)),
        sellerPayoutTotal: String(Math.round(sellerPayout * 100)),
        platformFeeTotal: String(Math.round(platformCommission * 100)),
        payoutMode: 'manual',
      },
    });
  }

  if (!result.success) {
    throw new BadRequestError(result.error || 'Failed to create payment checkout session');
  }

  // Update transaction with payment split details
  await transaction.update({
    sellerPayout: sellerPayout,
    platformFee: platformCommission,
    finalPaymentAmount: finalPaymentAmount,
  });

  res.json({
    success: true,
    data: {
      sessionId: result.sessionId,
      url: result.url,
    },
    message: 'Payment checkout session created',
  });
});

// Verify deposit payment status - used when returning from Stripe checkout
// This checks Stripe directly and updates the transaction if paid
export const verifyDepositStatus = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  // Get the transaction
  const transaction = await Transaction.findByPk(id, {
    include: [{ model: Listing, as: 'listing' }],
  });

  if (!transaction) {
    throw new NotFoundError('Transaction not found');
  }

  // Verify the buyer owns this transaction
  if (transaction.buyerId !== req.user.id) {
    throw new ForbiddenError('You do not have permission to verify this transaction');
  }

  // If already marked as deposit received, return success
  if (transaction.status !== TransactionStatus.AWAITING_DEPOSIT) {
    res.json({
      success: true,
      data: {
        status: transaction.status,
        depositPaid: true,
        depositPaidAt: transaction.depositPaidAt,
      },
      message: 'Deposit already confirmed',
    });
    return;
  }

  // Check for recent successful checkout sessions for this transaction
  const sessions = await stripeService.listCheckoutSessions(transaction.id);

  if (sessions.success && sessions.sessions && sessions.sessions.length > 0) {
    // Find a completed/paid session for deposit
    const paidSession = sessions.sessions.find(
      (s: any) => s.payment_status === 'paid' && s.metadata?.type === 'deposit'
    );

    if (paidSession) {
      const amountPaid = paidSession.amount_total ? paidSession.amount_total / 100 : 1000;

      // Update transaction status
      await transaction.update({
        status: TransactionStatus.DEPOSIT_RECEIVED,
        depositAmount: amountPaid,
        depositPaidAt: new Date(),
      });

      res.json({
        success: true,
        data: {
          status: TransactionStatus.DEPOSIT_RECEIVED,
          depositPaid: true,
          depositPaidAt: new Date(),
          amount: amountPaid,
        },
        message: 'Deposit verified and confirmed',
      });
      return;
    }
  }

  // No paid session found
  res.json({
    success: true,
    data: {
      status: transaction.status,
      depositPaid: false,
    },
    message: 'Deposit payment not yet confirmed',
  });
});

// ============================================
// Admin Create Transaction
// ============================================

// Validation for admin create transaction
export const adminCreateTransactionValidation = [
  body('listingId').trim().notEmpty().withMessage('Listing ID is required'),
  body('buyerId').trim().notEmpty().withMessage('Buyer ID is required'),
  body('agreedPrice').isNumeric().withMessage('Agreed price must be a number'),
  body('depositAmount').optional().isNumeric().withMessage('Deposit amount must be a number'),
  body('notes').optional().trim(),
];

// Admin creates a transaction manually
export const adminCreateTransaction = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { listingId, buyerId, agreedPrice, depositAmount, notes } = req.body;

  const transaction = await transactionService.adminCreateTransaction(req.user.id, {
    listingId,
    buyerId,
    agreedPrice: Number(agreedPrice),
    depositAmount: depositAmount ? Number(depositAmount) : undefined,
    notes,
  });

  res.status(201).json({
    success: true,
    data: transaction,
    message: 'Transaction created successfully',
  });
});

// Get available buyers for admin transaction creation
export const getAvailableBuyers = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { search } = req.query;

  const buyers = await transactionService.getAvailableBuyers(search as string);

  res.json({
    success: true,
    data: buyers,
  });
});

// Get available listings for admin transaction creation
export const getAvailableListings = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { search } = req.query;

  const listings = await transactionService.getAvailableListings(search as string);

  res.json({
    success: true,
    data: listings,
  });
});

// Admin sends notification emails for an existing transaction
export const adminSendTransactionEmails = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  const result = await transactionService.adminSendTransactionEmails(id, req.user.id);

  res.json({
    success: true,
    data: result,
    message: `Notification emails sent to buyer (${result.buyerEmail}) and seller (${result.sellerEmail})`,
  });
});

// Admin deletes a transaction
export const adminDeleteTransaction = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;

  const result = await transactionService.adminDeleteTransaction(req.user.id, id);

  res.json({
    success: true,
    message: result.message,
  });
});

// Validation for confirm escrow
export const confirmEscrowValidation = [
  body('amount').isNumeric().withMessage('Amount is required'),
  body('paymentMethod').isIn(['ZELLE', 'WIRE', 'CHECK', 'STRIPE']).withMessage('Invalid payment method'),
];

// Admin confirms payment received into escrow
export const adminConfirmEscrow = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401).json({ success: false, error: 'Not authenticated' });
    return;
  }

  const { id } = req.params;
  const { amount, paymentMethod, notes } = req.body;

  const transaction = await Transaction.findByPk(id);

  if (!transaction) {
    throw new NotFoundError('Transaction not found');
  }

  await transaction.update({
    escrowStatus: 'FUNDED',
    escrowAmount: Number(amount),
    escrowConfirmedAt: new Date(),
    escrowConfirmedBy: req.user.id,
    escrowPaymentMethod: paymentMethod,
    adminNotes: notes
      ? `${transaction.adminNotes ? transaction.adminNotes + '\n' : ''}[Escrow] ${paymentMethod} payment of $${Number(amount).toLocaleString()} confirmed. ${notes}`
      : transaction.adminNotes,
  });

  res.json({
    success: true,
    data: {
      escrowStatus: 'FUNDED',
      escrowAmount: Number(amount),
      escrowConfirmedAt: new Date(),
      escrowPaymentMethod: paymentMethod,
    },
    message: `$${Number(amount).toLocaleString()} confirmed in escrow via ${paymentMethod}`,
  });
});
