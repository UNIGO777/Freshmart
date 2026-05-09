require('dotenv').config();
const { createRemoteJWKSet, jwtVerify } = require('jose');
const { OAuth2Client } = require('google-auth-library');
const Customer = require('../../user/models/Customer.model');
const { signAccessToken, signRefreshToken } = require('../../../shared/utils/jwt.util');
const { sendSuccess, sendError } = require('../../../shared/utils/response.util');
const ERROR_CODES = require('../../../shared/constants/errorCodes');
const ROLES = require('../../../shared/constants/roles');
const logger = require('../../../shared/utils/logger');

// Apple JWKS endpoint — cached remotely by jose (auto-refreshed)
const APPLE_JWKS = createRemoteJWKSet(new URL('https://appleid.apple.com/auth/keys'));

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
 * Verify an Apple ID token using Apple's JWKS endpoint via jose.
 * Performs full RS256 signature verification, issuer, audience, and expiry checks.
 * @param {string} idToken
 * @returns {{ sub: string, email: string }}
 */
const verifyAppleToken = async (idToken) => {
  const { payload } = await jwtVerify(idToken, APPLE_JWKS, {
    issuer: 'https://appleid.apple.com',
    audience: process.env.APPLE_CLIENT_ID,
  });
  return { sub: payload.sub, email: payload.email };
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
