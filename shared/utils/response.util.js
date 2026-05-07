/**
 * Send a successful JSON response.
 * @param {import('express').Response} res
 * @param {number} statusCode
 * @param {string} message
 * @param {*} [data]
 */
const sendSuccess = (res, statusCode = 200, message = 'Success', data = null) => {
  const payload = { success: true, message };
  if (data !== null) payload.data = data;
  return res.status(statusCode).json(payload);
};

/**
 * Send an error JSON response.
 * @param {import('express').Response} res
 * @param {number} statusCode
 * @param {string} message
 * @param {string} [errorCode]
 * @param {*} [details]
 */
const sendError = (res, statusCode = 500, message = 'Something went wrong', errorCode = null, details = null) => {
  const payload = { success: false, message };
  if (errorCode) payload.errorCode = errorCode;
  if (details) payload.details = details;
  return res.status(statusCode).json(payload);
};

module.exports = { sendSuccess, sendError };
