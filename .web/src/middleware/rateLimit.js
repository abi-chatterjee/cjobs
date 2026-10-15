"use strict";

const rateLimit = require("../lib/rateLimit");

/** Applied only to POST /api/auth/login. Blocks with 429 while locked out;
 * otherwise lets the route handler record the attempt's outcome. */
function loginRateLimit(req, res, next) {
  const ip = req.ip;
  const st = rateLimit.status(ip);
  if (st.locked) {
    const retrySec = Math.ceil(st.retryAfterMs / 1000);
    res.set("Retry-After", String(retrySec));
    return res.status(429).json({ error: `too many attempts — try again in ${retrySec}s` });
  }
  next();
}

module.exports = { loginRateLimit };
