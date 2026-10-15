"use strict";

const fs = require("fs");
const { spawn } = require("child_process");

// In-memory {jobName -> entry} registry for runs this web server itself
// launched. Mirrors cjob's `do_run`: `/usr/bin/env -i /bin/bash run.sh` with
// a fully empty environment — run.sh builds its own hermetic PATH/HOME/token
// internally, so this only needs to hand it a clean slate.
const registry = new Map();

function isRunning(jobName) {
  const entry = registry.get(jobName);
  return Boolean(entry && !entry.exited);
}

function getRunEntry(jobName) {
  return registry.get(jobName) || null;
}

/** Starts run.sh detached from any HTTP request lifecycle. Returns
 * immediately; callers stream progress separately via lib/tailer.js. */
function startRun(job) {
  if (isRunning(job.name)) {
    return { started: false, alreadyRunning: true, pid: registry.get(job.name).pid };
  }
  try {
    fs.chmodSync(job.runSh, 0o755); // mirrors do_run's auto-chmod-if-needed
  } catch (e) {
    return { started: false, error: `cannot chmod run.sh: ${e.message}` };
  }

  let child;
  try {
    child = spawn("/usr/bin/env", ["-i", "/bin/bash", job.runSh], {
      stdio: "ignore",
      detached: true,
    });
  } catch (e) {
    return { started: false, error: `cannot run: ${e.message}` };
  }

  const entry = { child, pid: child.pid, startedAt: Date.now(), exited: false };
  registry.set(job.name, entry);
  child.on("exit", (code, signal) => {
    entry.exited = true;
    entry.exitCode = code;
    entry.exitSignal = signal;
  });
  child.on("error", (err) => {
    entry.exited = true;
    entry.error = err;
  });
  child.unref();
  return { started: true, pid: child.pid };
}

/** SIGTERM then SIGKILL (after a grace period) for a run this server itself
 * launched. run.sh traps TERM and its EXIT trap still runs cleanup (kills
 * the underlying claude subprocess, releases the lock), so this cascades
 * correctly rather than orphaning anything. */
function stopRun(jobName) {
  const entry = registry.get(jobName);
  if (!entry || entry.exited) {
    return { stopped: false, reason: "not running via this server" };
  }
  try {
    entry.child.kill("SIGTERM");
  } catch (e) {
    return { stopped: false, reason: e.message };
  }
  if (entry.killTimer) clearTimeout(entry.killTimer);
  entry.killTimer = setTimeout(() => {
    if (!entry.exited) {
      try {
        entry.child.kill("SIGKILL");
      } catch (e) {
        /* already gone */
      }
    }
  }, 10000);
  return { stopped: true };
}

module.exports = { startRun, stopRun, isRunning, getRunEntry };
