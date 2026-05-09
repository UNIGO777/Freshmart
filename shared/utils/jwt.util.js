require('dotenv').config();
const jwt = require('jsonwebtoken');

const ACCESS_SECRET = process.env.JWT_SECRET;
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET;

// Guard: refuse to start with known-insecure placeholder secrets
const WEAK_SECRETS = ['change_me', 'secret', 'jwt_secret', 'your_secret'];
if (!ACCESS_SECRET || WEAK_SECRETS.includes(ACCESS_SECRET)) {
  console.error('[FATAL] JWT_SECRET is missing or insecure. Set a strong random value in .env');
  process.exit(1);
}
if (!REFRESH_SECRET || WEAK_SECRETS.includes(REFRESH_SECRET)) {
  console.error('[FATAL] JWT_REFRESH_SECRET is missing or insecure. Set a strong random value in .env');
  process.exit(1);
}
const ACCESS_EXPIRY = process.env.JWT_EXPIRY || '15m';
const REFRESH_EXPIRY = process.env.JWT_REFRESH_EXPIRY || '30d';

/**
 * Sign an access token.
 * @param {{ id: string, role: string }} payload
 * @returns {string}
 */
const signAccessToken = (payload) => {
  return jwt.sign(payload, ACCESS_SECRET, { expiresIn: ACCESS_EXPIRY });
};

/**
 * Sign a refresh token.
 * @param {{ id: string, role: string }} payload
 * @returns {string}
 */
const signRefreshToken = (payload) => {
  return jwt.sign(payload, REFRESH_SECRET, { expiresIn: REFRESH_EXPIRY });
};

/**
 * Verify an access token.
 * @param {string} token
 * @returns {{ id: string, role: string, iat: number, exp: number }}
 */
const verifyAccessToken = (token) => {
  return jwt.verify(token, ACCESS_SECRET);
};

/**
 * Verify a refresh token.
 * @param {string} token
 * @returns {{ id: string, role: string, iat: number, exp: number }}
 */
const verifyRefreshToken = (token) => {
  return jwt.verify(token, REFRESH_SECRET);
};

module.exports = { signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken };
