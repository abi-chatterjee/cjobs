"use strict";

const express = require("express");
const {
  COOKIE_NAME, SESSION_TTL_MS, isConfigured, verifyPassword, createSessionToken, verifySessionToken,
} = require("../lib/auth");
const rateLimit = require("../lib/rateLimit");
const { loginRateLimit } = require("../middleware/rateLimit");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

router.post(
  "/login",
  loginRateLimit,
  asyncHandler(async (req, res) => {
    if (!isConfigured()) {
      return res.status(503).json({
        error: "no password configured — run `node setup-password.js` on the server machine first",
      });
    }
    const password = (req.body && req.body.password) || "";
    // Small constant delay regardless of outcome slows down brute-forcing
    // beyond what the lockout alone provides.
    await sleep(300);
    if (typeof password !== "string" || !verifyPassword(password)) {
      rateLimit.recordFailure(req.ip);
      return res.status(401).json({ error: "invalid password" });
    }
    rateLimit.recordSuccess(req.ip);
    const { token, payload } = createSessionToken();
    res.cookie(COOKIE_NAME, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: req.secure,
      maxAge: SESSION_TTL_MS,
      path: "/",
    });
    res.json({ ok: true, csrfToken: payload.csrf });
  })
);

router.post("/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME, { path: "/" });
  res.json({ ok: true });
});

router.get("/status", (req, res) => {
  const token = req.cookies && req.cookies[COOKIE_NAME];
  const session = verifySessionToken(token);
  if (!session) return res.json({ authenticated: false, needsSetup: !isConfigured() });
  res.json({ authenticated: true, csrfToken: session.csrf });
});

module.exports = router;
