const { verifyAccessToken } = require('../../shared/utils/jwt.util');
const { sendError } = require('../../shared/utils/response.util');
const ERROR_CODES = require('../../shared/constants/errorCodes');

/**
 * Verify the Bearer JWT access token on every protected route.
 * Attaches decoded payload to req.user = { id, role }.
 */
const authenticate = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return sendError(res, 401, 'No token provided', ERROR_CODES.UNAUTHORIZED);
  }

  const token = authHeader.split(' ')[1];

  try {
    const decoded = verifyAccessToken(token);
    req.user = { id: decoded.id, role: decoded.role };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return sendError(res, 401, 'Token expired', ERROR_CODES.TOKEN_EXPIRED);
    }
    return sendError(res, 401, 'Invalid token', ERROR_CODES.TOKEN_INVALID);
  }
};

module.exports = { authenticate };
