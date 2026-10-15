"use strict";

// The CLI is single-shot per invocation, so it never has two writers racing
// the same job.json/run.sh. The web server is long-lived and can receive
// concurrent requests (e.g. a schedule change and a script edit landing at
// once) — this per-job-name promise-chain mutex serializes any
// read-modify-write sequence so they can't interleave.

const chains = new Map();

function withJobLock(jobName, fn) {
  const prev = chains.get(jobName) || Promise.resolve();
  const next = prev.then(fn, fn); // run fn regardless of prior settlement
  // Keep the chain alive even if fn rejects, but don't let unhandled
  // rejections escape from the map's stored promise itself.
  chains.set(jobName, next.catch(() => {}));
  return next;
}

module.exports = { withJobLock };
