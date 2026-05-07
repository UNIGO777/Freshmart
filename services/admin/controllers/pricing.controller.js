// Pricing endpoints are handled by Product Service (Phase 2).
// This file is a stub — Phase 7 may add admin-specific analytics here.
const { sendSuccess } = require('../../../shared/utils/response.util');
const getPricingOverview = async (_req, res) => sendSuccess(res, 200, 'Pricing overview (Phase 7)', {});
module.exports = { getPricingOverview };
