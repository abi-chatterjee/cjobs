"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { AUTH_FILE } = require("../config");

const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h
const COOKIE_NAME = "cjobweb_sess";

let cached = null;
let cachedAt = 0;

function loadAuthConfig() {
  // Re-read occasionally rather than caching forever, so re-running
  // setup-password.js while the server is up is picked up without a restart.
  if (cached && Date.now() - cachedAt < 5000) return cached;
  try {
    cached = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8"));
  } catch (e) {
    cached = null;
  }
  cachedAt = Date.now();
  return cached;
}

function isConfigured() {
  return loadAuthConfig() !== null;
}

function verifyPassword(password) {
  const cfg = loadAuthConfig();
  if (!cfg) return false;
  const { salt, hash, N, r, p, keylen } = cfg.scrypt;
  const derived = crypto.scryptSync(String(password), Buffer.from(salt, "hex"), keylen, { N, r, p });
  const expected = Buffer.from(hash, "hex");
  if (derived.length !== expected.length) return false;
  return crypto.timingSafeEqual(derived, expected);
}

function b64url(buf) {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(str) {
  let s = str.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Buffer.from(s, "base64");
}

function sign(payloadObj) {
  const cfg = loadAuthConfig();
  const payload = b64url(Buffer.from(JSON.stringify(payloadObj), "utf8"));
  const mac = crypto.createHmac("sha256", cfg.sessionSecret).update(payload).digest();
  return `${payload}.${b64url(mac)}`;
}

/** Verifies a signed session token, returning its payload or null. Stateless
 * (no server-side session store) — only the persisted sessionSecret matters,
 * so sessions survive a server restart. */
function verifySessionToken(token) {
  const cfg = loadAuthConfig();
  if (!cfg || !token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, sig] = parts;
  const expectedMac = crypto.createHmac("sha256", cfg.sessionSecret).update(payload).digest();
  const expectedSig = b64url(expectedMac);
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  let obj;
  try {
    obj = JSON.parse(fromB64url(payload).toString("utf8"));
  } catch (e) {
    return null;
  }
  if (!obj || typeof obj.exp !== "number" || Date.now() > obj.exp) return null;
  return obj;
}

function createSessionToken() {
  const now = Date.now();
  const payload = {
    sub: "abi",
    csrf: crypto.randomBytes(24).toString("hex"),
    iat: now,
    exp: now + SESSION_TTL_MS,
  };
  return { token: sign(payload), payload };
}

module.exports = {
  COOKIE_NAME, SESSION_TTL_MS, isConfigured, verifyPassword, createSessionToken, verifySessionToken,
};
