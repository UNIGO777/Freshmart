const mongoose = require('mongoose');
const { z } = require('zod');
const Rider = require('../../user/models/Rider.model');
const RiderWallet = require('../../delivery/models/RiderWallet.model');
const WalletTransaction = require('../../delivery/models/WalletTransaction.model');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const logger = require('../../../shared/utils/logger');

// ── GET /rider-wallets ──────────────────────────────────────────
const listRiderWallets = async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    // Build rider filter
    const riderFilter = {};
    if (req.query.search) {
      const re = new RegExp(req.query.search, 'i');
      riderFilter.$or = [{ name: re }, { phone: re }];
    }

    // Find matching riders
    const riders = await Rider.find(riderFilter)
      .select('name phone vehicleType bankDetails isOnline isApproved')
      .sort({ createdAt: -1 })
      .lean();

    const riderIds = riders.map((r) => r._id);

    // Fetch wallets for these riders
    const wallets = await RiderWallet.find({ riderId: { $in: riderIds } }).lean();
    const walletMap = Object.fromEntries(wallets.map((w) => [w.riderId.toString(), w]));

    // Build combined list
    let combined = riders.map((r) => {
      const w = walletMap[r._id.toString()];
      return {
        _id: r._id,
        name: r.name,
        phone: r.phone,
        vehicleType: r.vehicleType,
        isOnline: r.isOnline,
        isApproved: r.isApproved,
        bankDetails: r.bankDetails || null,
        hasBankDetails: !!(r.bankDetails?.accountNumber),
        balance: w?.balance ?? 0,
        totalEarned: w?.totalEarned ?? 0,
        totalWithdrawn: w?.totalWithdrawn ?? 0,
        totalDeductions: w?.totalDeductions ?? 0,
      };
    });

    // Sort by balance high→low if requested
    if (req.query.sort === 'balance') {
      combined.sort((a, b) => b.balance - a.balance);
    }

    // Filter by bank details status
    if (req.query.bankStatus === 'added') {
      combined = combined.filter((r) => r.hasBankDetails);
    } else if (req.query.bankStatus === 'missing') {
      combined = combined.filter((r) => !r.hasBankDetails);
    }

    const total = combined.length;
    const paginated = combined.slice(skip, skip + limit);

    return sendSuccess(res, 200, 'Rider wallets fetched', { wallets: paginated, total, page, limit });
  } catch (err) {
    logger.error('listRiderWallets error:', err);
    return sendError(res, 500, 'Failed to fetch rider wallets', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /rider-wallets/stats ────────────────────────────────────
const getWalletStats = async (_req, res) => {
  try {
    const [agg] = await RiderWallet.aggregate([
      {
        $group: {
          _id: null,
          totalRiders: { $sum: 1 },
          totalBalance: { $sum: '$balance' },
          totalPaidOut: { $sum: '$totalWithdrawn' },
          totalDeductions: { $sum: '$totalDeductions' },
        },
      },
    ]);

    return sendSuccess(res, 200, 'Wallet stats fetched', {
      totalRiders: agg?.totalRiders ?? 0,
      totalBalance: agg?.totalBalance ?? 0,
      totalPaidOut: agg?.totalPaidOut ?? 0,
      totalDeductions: agg?.totalDeductions ?? 0,
    });
  } catch (err) {
    logger.error('getWalletStats error:', err);
    return sendError(res, 500, 'Failed to fetch wallet stats', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── GET /rider-wallets/:riderId ─────────────────────────────────
const getRiderWalletDetail = async (req, res) => {
  try {
    const { riderId } = req.params;

    const rider = await Rider.findById(riderId)
      .select('name phone vehicleType bankDetails isOnline isApproved kyc performance rating')
      .lean();
    if (!rider) return sendError(res, 404, 'Rider not found', ERROR_CODES.NOT_FOUND);

    const wallet = await RiderWallet.findOne({ riderId }).lean();

    // Transactions with pagination
    const page  = Math.max(1, parseInt(req.query.page)  || 1);
    const limit = Math.min(100, parseInt(req.query.limit) || 20);
    const skip  = (page - 1) * limit;

    const txFilter = { riderId: new mongoose.Types.ObjectId(riderId) };
    if (req.query.type) txFilter.type = req.query.type;
    if (req.query.from || req.query.to) {
      txFilter.createdAt = {};
      if (req.query.from) txFilter.createdAt.$gte = new Date(req.query.from);
      if (req.query.to) {
        const toDate = new Date(req.query.to);
        toDate.setHours(23, 59, 59, 999);
        txFilter.createdAt.$lte = toDate;
      }
    }

    const [transactions, txTotal] = await Promise.all([
      WalletTransaction.find(txFilter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      WalletTransaction.countDocuments(txFilter),
    ]);

    return sendSuccess(res, 200, 'Rider wallet detail', {
      rider,
      wallet: wallet || { balance: 0, totalEarned: 0, totalWithdrawn: 0, totalDeductions: 0 },
      transactions,
      txTotal,
      txPage: page,
      txLimit: limit,
    });
  } catch (err) {
    logger.error('getRiderWalletDetail error:', err);
    return sendError(res, 500, 'Failed to fetch rider wallet detail', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── POST /rider-wallets/:riderId/withdraw ───────────────────────
const withdrawSchema = z.object({
  amount:    z.number().positive(),
  reference: z.string().min(1),
  notes:     z.string().optional(),
});

const processWithdrawal = async (req, res) => {
  try {
    const { riderId } = req.params;
    const parsed = withdrawSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }

    const { amount, reference, notes } = parsed.data;

    const wallet = await RiderWallet.findOne({ riderId });
    if (!wallet) return sendError(res, 404, 'Wallet not found', ERROR_CODES.NOT_FOUND);
    if (amount > wallet.balance) {
      return sendError(res, 400, 'Amount exceeds wallet balance', ERROR_CODES.VALIDATION_ERROR);
    }

    wallet.balance -= amount;
    wallet.totalWithdrawn += amount;
    await wallet.save();

    const tx = await WalletTransaction.create({
      riderId,
      type: 'withdrawal',
      amount,
      balanceAfter: wallet.balance,
      description: `Admin withdrawal — Ref: ${reference}${notes ? ` — ${notes}` : ''}`,
      processedBy: req.user.id,
      processedByName: req.user.name || 'Admin',
    });

    // Emit socket event to rider
    try {
      const axios = require('axios');
      const SOCKET_URL = `http://localhost:${process.env.PORT_SOCKET || 3010}`;
      await axios.post(`${SOCKET_URL}/internal/emit`, {
        room: `user:${riderId}`,
        event: 'wallet:updated',
        payload: { balance: wallet.balance, transaction: tx },
      }, { timeout: 3000 }).catch(() => {});
    } catch { /* socket emit is best-effort */ }

    return sendSuccess(res, 200, 'Withdrawal processed', { wallet, transaction: tx });
  } catch (err) {
    logger.error('processWithdrawal error:', err);
    return sendError(res, 500, 'Failed to process withdrawal', ERROR_CODES.INTERNAL_ERROR);
  }
};

// ── POST /rider-wallets/:riderId/deduct ─────────────────────────
const deductSchema = z.object({
  amount:   z.number().positive(),
  reason:   z.string().min(1),
  category: z.enum(['penalty', 'refund', 'adjustment', 'other']).optional(),
});

const processDeduction = async (req, res) => {
  try {
    const { riderId } = req.params;
    const parsed = deductSchema.safeParse(req.body);
    if (!parsed.success) {
      return sendError(res, 400, 'Validation failed', ERROR_CODES.VALIDATION_ERROR, parsed.error.flatten());
    }

    const { amount, reason, category } = parsed.data;

    let wallet = await RiderWallet.findOne({ riderId });
    if (!wallet) {
      wallet = await RiderWallet.create({ riderId, balance: 0 });
    }

    wallet.balance -= amount;
    wallet.totalDeductions += amount;
    await wallet.save();

    const tx = await WalletTransaction.create({
      riderId,
      type: 'deduction',
      amount,
      balanceAfter: wallet.balance,
      description: `${category ? `[${category}] ` : ''}${reason}`,
      reason,
      processedBy: req.user.id,
      processedByName: req.user.name || 'Admin',
    });

    // Emit socket event to rider
    try {
      const axios = require('axios');
      const SOCKET_URL = `http://localhost:${process.env.PORT_SOCKET || 3010}`;
      await axios.post(`${SOCKET_URL}/internal/emit`, {
        room: `user:${riderId}`,
        event: 'wallet:updated',
        payload: { balance: wallet.balance, transaction: tx },
      }, { timeout: 3000 }).catch(() => {});
    } catch { /* socket emit is best-effort */ }

    return sendSuccess(res, 200, 'Deduction processed', { wallet, transaction: tx });
  } catch (err) {
    logger.error('processDeduction error:', err);
    return sendError(res, 500, 'Failed to process deduction', ERROR_CODES.INTERNAL_ERROR);
  }
};

module.exports = {
  listRiderWallets,
  getWalletStats,
  getRiderWalletDetail,
  processWithdrawal,
  processDeduction,
};
