/**
 * Language detection middleware.
 *
 * Priority: ?lang query param → Accept-Language header → customer profile language → 'en'
 *
 * Sets req.lang = 'hi' | 'en' so downstream controllers don't repeat the logic.
 * Used primarily by the Product Service to localise product names.
 */
const langMiddleware = (req, _res, next) => {
  // 1. Explicit query param overrides everything (?lang=hi)
  if (req.query.lang === 'hi' || req.query.lang === 'en') {
    req.lang = req.query.lang;
    return next();
  }

  // 2. Standard HTTP Accept-Language header  (e.g. "hi-IN,hi;q=0.9,en;q=0.8")
  const acceptLang = req.headers['accept-language'] || '';
  if (acceptLang.toLowerCase().startsWith('hi')) {
    req.lang = 'hi';
    return next();
  }

  // 3. Default to English
  req.lang = 'en';
  next();
};

module.exports = { langMiddleware };
