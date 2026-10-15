"use strict";

const fs = require("fs");
const path = require("path");
const { readRun } = require("./logs");

const POLL_MS = 400;
const FIND_LOG_DEFAULT_TIMEOUT_MS = 20000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Finds the newest log file for a job, polling briefly if none exist yet —
 * mirrors cjob's `do_tail`, which polls recent_runs(1) up to a 20s deadline
 * so it can be started just before (or just after) a run begins. */
async function findNewestLog(job, deadlineMs = FIND_LOG_DEFAULT_TIMEOUT_MS) {
  const start = Date.now();
  for (;;) {
    const runs = job.recentRuns(1);
    if (runs.length) return runs[0].log;
    if (Date.now() - start > deadlineMs) return null;
    await sleep(1000);
  }
}

function readNewBytes(logPath, offset) {
  let size = 0;
  try {
    size = fs.statSync(logPath).size;
  } catch (e) {
    return { text: "", offset };
  }
  if (size <= offset) return { text: "", offset };
  const fd = fs.openSync(logPath, "r");
  try {
    const len = size - offset;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    return { text: buf.toString("utf8"), offset: size };
  } finally {
    fs.closeSync(fd);
  }
}

/** Poll-based `tail -f` for a single log file (not fs.watch, which is
 * unreliable on macOS for frequent small appends). Calls onData(chunk) for
 * newly appended text and onDone(summary) exactly once, when the run is
 * known to be finished.
 *
 * `getTrackedEntry()` (optional) returns the runner-registry entry for a
 * run this server itself launched — when present, the child's own 'exit'
 * event is the authoritative end-of-run signal. Without it (e.g. tailing a
 * launchd-triggered 3am run this server didn't start), completion is
 * inferred from the RUN FOOTER's `cjob.finished=` line appearing in newly
 * streamed text, with a short grace period to catch trailing output.
 *
 * Returns a stop() function to cancel early (e.g. the client disconnected). */
function followLog(logPath, { onData, onDone, getTrackedEntry } = {}) {
  let offset = 0;
  let stopped = false;
  let footerSeenAt = null;

  const drain = () => {
    const { text, offset: newOffset } = readNewBytes(logPath, offset);
    offset = newOffset;
    if (text) {
      onData && onData(text);
      if (/^cjob\.finished=/m.test(text)) footerSeenAt = Date.now();
    }
  };

  const finish = () => {
    if (stopped) return;
    stopped = true;
    const dateDir = path.basename(path.dirname(logPath));
    const hhmmss = path.basename(logPath, ".log");
    const summary = readRun(logPath, dateDir, hhmmss);
    onDone && onDone(summary);
  };

  (async () => {
    while (!stopped) {
      drain();
      const entry = getTrackedEntry ? getTrackedEntry() : null;
      if (entry && entry.exited) {
        await sleep(250); // one more beat to let a final flush land
        drain();
        finish();
        return;
      }
      if (!entry && footerSeenAt && Date.now() - footerSeenAt > 1500) {
        finish();
        return;
      }
      await sleep(POLL_MS);
    }
  })();

  return () => {
    stopped = true;
  };
}

module.exports = { findNewestLog, followLog };
