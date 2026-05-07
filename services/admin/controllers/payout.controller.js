// Phase 7 — full implementation deferred
const { sendSuccess } = require('../../../shared/utils/response.util');
const listPayouts = async (_req, res) => sendSuccess(res, 200, 'Payouts (Phase 7)', []);
const triggerPayout = async (_req, res) => sendSuccess(res, 200, 'Payout (Phase 7)', {});
module.exports = { listPayouts, triggerPayout };
