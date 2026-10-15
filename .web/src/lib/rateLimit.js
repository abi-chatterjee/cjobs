"use strict";

// Per-IP login throttle/lockout, in-memory only (resets on server restart —
// acceptable for a single-user tool). 5 failures within a 10-minute window
// triggers a 15-minute lockout.

const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const attempts = new Map(); // ip -> { failures: [timestamps], lockUntil }

function status(ip) {
  const entry = attempts.get(ip);
  if (!entry) return { locked: false };
  if (entry.lockUntil && Date.now() < entry.lockUntil) {
    return { locked: true, retryAfterMs: entry.lockUntil - Date.now() };
  }
  return { locked: false };
}

function recordFailure(ip) {
  const now = Date.now();
  let entry = attempts.get(ip);
  if (!entry) {
    entry = { failures: [], lockUntil: 0 };
    attempts.set(ip, entry);
  }
  entry.failures = entry.failures.filter((t) => now - t < FAILURE_WINDOW_MS);
  entry.failures.push(now);
  if (entry.failures.length >= MAX_FAILURES) {
    entry.lockUntil = now + LOCKOUT_MS;
    entry.failures = [];
  }
}

function recordSuccess(ip) {
  attempts.delete(ip);
}

module.exports = { status, recordFailure, recordSuccess };
