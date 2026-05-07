// Phase 7 — full implementation deferred
const { sendSuccess } = require('../../../shared/utils/response.util');
const getDashboard = async (_req, res) => sendSuccess(res, 200, 'Dashboard (Phase 7)', {});
module.exports = { getDashboard };
