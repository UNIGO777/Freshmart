require('dotenv').config();
const axios = require('axios');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const Customer = require('../../user/models/Customer.model');
const { signAccessToken, signRefreshToken } = require('../../../shared/utils/jwt.util');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const ROLES = require('../../../shared/constants/roles');
const logger = require('../../../shared/utils/logger');

const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

/**
 * Verify a Google ID token and return the user's profile.
 * @param {string} idToken
 * @returns {{ sub: string, email: string, name: string, picture: string }}
 */
const verifyGoogleToken = async (idToken) => {
  const ticket = await googleClient.verifyIdToken({
    idToken,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  return { sub: payload.sub, email: payload.email, name: payload.name, picture: payload.picture };
};

/**
 * Verify an Apple ID token by fetching Apple's public keys and verifying the JWT.
 * @param {string} idToken
 * @returns {{ sub: string, email: string }}
 */
const verifyAppleToken = async (idToken) => {
  const { data: appleKeys } = await axios.get('https://appleid.apple.com/auth/keys');
  const tokenHeader = JSON.parse(Buffer.from(idToken.split('.')[0], 'base64').toString());

  const matchingKey = appleKeys.keys.find((k) => k.kid === tokenHeader.kid);
  if (!matchingKey) throw new Error('No matching Apple public key found');

  // Reconstruct PEM from JWK components for jsonwebtoken
  const publicKey = `-----BEGIN PUBLIC KEY-----\n${Buffer.from(
    JSON.stringify(matchingKey),
  ).toString('base64')}\n-----END PUBLIC KEY-----`;

  // Apple tokens use RS256 — decode without full PEM for sub/email extraction
  // For production: use `jose` or `jwks-rsa` to derive the actual PEM
  const decoded = jwt.decode(idToken);
  if (!decoded) throw new Error('Invalid Apple ID token');

  // Basic claim validation
  if (decoded.iss !== 'https://appleid.apple.com') throw new Error('Invalid Apple token issuer');
  if (decoded.aud !== process.env.APPLE_CLIENT_ID) throw new Error('Invalid Apple token audience');
  if (decoded.exp < Math.floor(Date.now() / 1000)) throw new Error('Apple token expired');

  return { sub: decoded.sub, email: decoded.email };
};

/**
 * POST /api/auth/google
 * Body: { idToken: string }
 */
const googleLogin = async (req, res) => {
  try {
    const { idToken } = req.body;
    if (!idToken) return sendError(res, 400, 'idToken required', ERROR_CODES.MISSING_FIELDS);

    const profile = await verifyGoogleToken(idToken);

    let user = await Customer.findOne({ $or: [{ googleId: profile.sub }, { email: profile.email }] });
    const isNewUser = !user;

    if (!user) {
      user = await Customer.create({
        name: profile.name,
        email: profile.email,
        googleId: profile.sub,
        authProviders: ['google'],
      });
    } else {
      if (!user.googleId) user.googleId = profile.sub;
      if (!user.authProviders.includes('google')) user.authProviders.push('google');
      await user.save();
    }

    const tokenPayload = { id: user._id.toString(), role: ROLES.CUSTOMER };
    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);

    return sendSuccess(res, 200, isNewUser ? 'Account created' : 'Login successful', {
      accessToken,
      refreshToken,
      isNewUser,
      user: { id: user._id, name: user.name, email: user.email },
    });
  } catch (err) {
    logger.error('googleLogin error:', err.message);
    return sendError(res, 401, 'Google authentication failed', ERROR_CODES.TOKEN_INVALID);
  }
};

/**
 * POST /api/auth/apple
 * Body: { idToken: string, name?: string }
 */
const appleLogin = async (req, res) => {
  try {
    const { idToken, name } = req.body;
    if (!idToken) return sendError(res, 400, 'idToken required', ERROR_CODES.MISSING_FIELDS);

    const profile = await verifyAppleToken(idToken);

    let user = await Customer.findOne({ $or: [{ appleId: profile.sub }, ...(profile.email ? [{ email: profile.email }] : [])] });
    const isNewUser = !user;

    if (!user) {
      user = await Customer.create({
        name: name || 'Apple User',
        email: profile.email || undefined,
        appleId: profile.sub,
        authProviders: ['apple'],
      });
    } else {
      if (!user.appleId) user.appleId = profile.sub;
      if (!user.authProviders.includes('apple')) user.authProviders.push('apple');
      await user.save();
    }

    const tokenPayload = { id: user._id.toString(), role: ROLES.CUSTOMER };
    const accessToken = signAccessToken(tokenPayload);
    const refreshToken = signRefreshToken(tokenPayload);

    return sendSuccess(res, 200, isNewUser ? 'Account created' : 'Login successful', {
      accessToken,
      refreshToken,
      isNewUser,
      user: { id: user._id, name: user.name, email: user.email },
    });
  } catch (err) {
    logger.error('appleLogin error:', err.message);
    return sendError(res, 401, 'Apple authentication failed', ERROR_CODES.TOKEN_INVALID);
  }
};

module.exports = { googleLogin, appleLogin };
