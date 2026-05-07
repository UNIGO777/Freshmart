const { sendError } = require('../../shared/utils/response.util');
const ERROR_CODES = require('../../shared/constants/errorCodes');

/**
 * Factory — returns middleware that only allows the specified roles.
 * Must be used AFTER authenticate middleware.
 * @param {...string} allowedRoles
 */
const requireRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return sendError(res, 401, 'Not authenticated', ERROR_CODES.UNAUTHORIZED);
    }

    if (!allowedRoles.includes(req.user.role)) {
      return sendError(res, 403, 'Access denied for your role', ERROR_CODES.FORBIDDEN);
    }

    next();
  };
};

module.exports = { requireRole };
