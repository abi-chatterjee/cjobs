"use strict";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Double-submit CSRF check: the session cookie is httpOnly (so JS can't
 * read it to mirror it — good, that's what stops token theft via XSS in
 * OTHER apps sharing this browser), but the client learns the same csrf
 * value from the JSON body of /api/auth/login and /api/auth/status and
 * echoes it back in X-CSRF-Token on state-changing requests. Must run
 * after requireAuth (needs req.session). */
function csrfProtect(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();
  const header = req.get("X-CSRF-Token");
  if (!header || !req.session || header !== req.session.csrf) {
    return res.status(403).json({ error: "csrf token missing or invalid" });
  }
  next();
}

module.exports = { csrfProtect };
