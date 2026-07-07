const mongoose = require('mongoose');
const { z } = require('zod');
const Vendor = require('../../user/models/Vendor.model');
const VendorWallet = require('../../vendor/models/VendorWallet.model');
const VendorWalletTransaction = require('../../vendor/models/VendorWalletTransaction.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

// ── GET /vendor-wallets ─────────────────────────────────────────
const listVendorWallets = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    const vendorFilter = {};
    if (req.query.search) {
      const re = new RegExp(req.query.search, 'i');
      vendorFilter.$or = [{ businessName: re }, { phone: re }];
    }

    const vendors = await Vendor.find(vendorFilter)
      .select('businessName phone bankDetails isOnline isApproved')
      .sort({ createdAt: -1 })
      .lean();

    const vendorIds = vendors.map((v) => v._id);
    const wallets = await VendorWallet.find({ vendorId: { $in: vendorIds } }).lean();
    const walletMap = Object.fromEntries(wallets.map((w) => [w.vendorId.toString(), w]));

    let combined = vendors.map((v) => {
      const w = walletMap[v._id.toString()];
      return {
        _id: v._id,
        businessName: v.businessName,
        phone: v.phone,
        isOnline: v.isOnline,
        isApproved: v.isApproved,
        bankDetails: v.bankDetails || null,
        hasBankDetails: !!(v.bankDetails?.accountNumber),
        balance: w?.balance ?? 0,
        totalEarned: w?.totalEarned ?? 0,
        totalWithdrawn: w?.totalWithdrawn ?? 0,
        totalDeductions: w?.totalDeductions ?? 0,
      };
    });

    if (req.query.sort === 'balance') {
      combined.sort((a, b) => b.balance - a.balance);
    }
    if (req.query.bankStatus === 'added') {
      combined = combined.filter((v) => v.hasBankDetails);
    } else if (req.query.bankStatus === 'missing') {
      combined = combined.filter((v) => !v.hasBankDetails);
    }

    const total = combined.length;
    const paginated = combined.slice(skip, skip + limit);

    return sendSuccess(res, 200, 'Vendor wallets fetched', { wallets: paginated, total, page, limit });
  } catch (err) {
    logger.error('listVendorWallets error:', err);
    return sendError(res, 500, 'Failed to fetch vendor wallets', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /vendor-wallets/stats ───────────────────────────────────
const getVendorWalletStats = async (_req, res) => {
  try {
    const [agg] = await VendorWallet.aggregate([
      {
        $group: {
          _id: null,
          totalVendors: { $sum: 1 },
          totalPayable: { $sum: '$balance' },
          totalPaidOut: { $sum: '$totalWithdrawn' },
          totalDeductions: { $sum: '$totalDeductions' },
        },
      },
    ]);

    return sendSuccess(res, 200, 'Vendor wallet stats fetched', {
      totalVendors: agg?.totalVendors ?? 0,
      totalPayable: agg?.totalPayable ?? 0,
      totalPaidOut: agg?.totalPaidOut ?? 0,
      totalDeductions: agg?.totalDeductions ?? 0,
    });
  } catch (err) {
    logger.error('getVendorWalletStats error:', err);
    return sendError(res, 500, 'Failed to fetch vendor wallet stats', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /vendor-wallets/:vendorId ───────────────────────────────
const getVendorWalletDetail = async (req, res) => {
  try {
    const { vendorId } = req.params;

    const vendor = await Vendor.findById(vendorId)
      .select('businessName phone bankDetails isOnline isApproved')
      .lean();
    if (!vendor) return sendError(res, 404, 'Vendor not found', ERROR_CODES.NOT_FOUND);

    const wallet = await VendorWallet.findOne({ vendorId }).lean();

    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    const txFilter = { vendorId: new mongoose.Types.ObjectId(vendorId) };
    if (req.query.type) txFilter.type = req.query.type;

    const [transactions, txTotal] = await Promise.all([
      VendorWalletTransaction.find(txFilter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      VendorWalletTransaction.countDocuments(txFilter),
    ]);

    return sendSuccess(res, 200, 'Vendor wallet detail', {
      vendor,
      wallet: wallet || { balance: 0, totalEarned: 0, totalWithdrawn: 0, totalDeductions: 0 },
      transactions,
      txTotal,
      txPage: page,
      txLimit: limit,
    });
  } catch (err) {
    logger.error('getVendorWalletDetail error:', err);
    return sendError(res, 500, 'Failed to fetch vendor wallet detail', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── POST /vendor-wallets/:vendorId/payout ───────────────────────
const payoutSchema = z.object({
  amount:    z.number().positive(),
  reference: z.string().min(1),
  notes:     z.string().optional(),
});

const processVendorPayout = async (req, res) => {
  try {
    const { vendorId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(vendorId)) {
      return sendError(res, 400, 'Invalid vendor id', ERROR_CODES.VALIDATION_ERROR);
    }
    const parsed = payoutSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }

    const { amount, reference, notes } = parsed.data;

    // Atomic guard — cannot pay out more than the vendor is owed.
    const wallet = await VendorWallet.findOneAndUpdate(
      { vendorId, balance: { $gte: amount } },
      { $inc: { balance: -amount, totalWithdrawn: amount } },
      { new: true },
    );
    if (!wallet) {
      const existing = await VendorWallet.findOne({ vendorId }).lean();
      const bal = existing?.balance ?? 0;
      return sendError(res, 400, `Amount exceeds the vendor wallet balance (₹${bal})`, ERROR_CODES.VALIDATION_ERROR);
    }

    const tx = await VendorWalletTransaction.create({
      vendorId,
      type: 'payout',
      amount,
      balanceAfter: wallet.balance,
      description: `Payout by admin — Ref: ${reference}${notes ? ` — ${notes}` : ''}`,
      reference,
      processedBy: req.user.id,
      processedByName: req.user.name || 'Admin',
    });

    // Notify vendor in real-time (reuse the existing wallet-update event shape)
    try {
      const axios = require('axios');
      const SOCKET_URL = `http://localhost:${process.env.PORT_SOCKET || 3010}`;
      await axios.post(`${SOCKET_URL}/internal/emit`, {
        room: `vendor:${vendorId}`,
        event: 'vendor:wallet-update',
        payload: {
          // NOTE: deliberately no `debited` field — the vendor dashboard interprets
          // `debited` as an earnings reversal and subtracts it from "Today's earnings".
          // A payout only reduces the wallet balance, not today's earnings.
          balance: wallet.balance,
          totalEarned: wallet.totalEarned,
          totalWithdrawn: wallet.totalWithdrawn,
          totalDeductions: wallet.totalDeductions,
          paidOut: amount,
          reason: 'payout',
        },
      }, { timeout: 3000 }).catch(() => {});
    } catch { /* socket emit is best-effort */ }

    return sendSuccess(res, 200, 'Payout processed', { wallet, transaction: tx });
  } catch (err) {
    logger.error('processVendorPayout error:', err);
    return sendError(res, 500, 'Failed to process payout', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = {
  listVendorWallets,
  getVendorWalletStats,
  getVendorWalletDetail,
  processVendorPayout,
};
