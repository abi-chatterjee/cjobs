"use strict";

const { COOKIE_NAME, verifySessionToken } = require("../lib/auth");

/** Express middleware: rejects any request without a valid session cookie.
 * Attaches the decoded session payload (incl. the csrf claim) to req.session. */
function requireAuth(req, res, next) {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  const session = verifySessionToken(token);
  if (!session) {
    return res.status(401).json({ error: "authentication required" });
  }
  req.session = session;
  next();
}

/** Same check, for the WebSocket upgrade path (no res.json there). Returns
 * the session payload or null. */
function verifyRequestAuth(req) {
  const cookieHeader = req.headers.cookie || "";
  const match = cookieHeader
    .split(";")
    .map((s) => s.trim())
    .find((s) => s.startsWith(COOKIE_NAME + "="));
  if (!match) return null;
  const token = decodeURIComponent(match.slice(COOKIE_NAME.length + 1));
  return verifySessionToken(token);
}

module.exports = { requireAuth, verifyRequestAuth };
