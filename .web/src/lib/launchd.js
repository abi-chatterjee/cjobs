"use strict";

const fs = require("fs");
const path = require("path");
const { run } = require("./procRun");
const { TEMPLATES, LAUNCH_AGENTS, DOMAIN, LABEL_PREFIX } = require("../config");
const { renderCalendar } = require("./schedule");

function launchctl(args, timeoutMs = 30000) {
  return run(["launchctl", ...args], { timeoutMs });
}

async function agentLoaded(label) {
  const res = await launchctl(["print", `${DOMAIN}/${label}`]);
  return res.rc === 0;
}

async function getLaunchctlPrint(label) {
  return launchctl(["print", `${DOMAIN}/${label}`]);
}

async function getenv(name) {
  return launchctl(["getenv", name]);
}

/** Labels currently loaded in launchd with the cjob prefix, from `launchctl
 * list` (parses the last whitespace-separated field of each line). */
async function listLoadedLabels() {
  const res = await launchctl(["list"]);
  const labels = new Set();
  if (res.rc !== 0) return labels;
  const lines = res.stdout.split("\n").slice(1);
  for (const line of lines) {
    const bits = line.trim().split(/\s+/).filter(Boolean);
    if (bits.length && bits[bits.length - 1].startsWith(LABEL_PREFIX)) {
      labels.add(bits[bits.length - 1]);
    }
  }
  return labels;
}

function listPlistLabels() {
  const labels = new Set();
  let names;
  try {
    names = fs.readdirSync(LAUNCH_AGENTS);
  } catch (e) {
    return labels;
  }
  for (const name of names) {
    if (name.startsWith(LABEL_PREFIX) && name.endsWith(".plist")) {
      labels.add(name.slice(0, -".plist".length));
    }
  }
  return labels;
}

/** Port of write_plist: template substitution -> tmp file -> `plutil -lint`
 * -> atomic rename. Deletes the tmp file on lint failure. */
async function writePlist(job, entries) {
  const tmplPath = path.join(TEMPLATES, "launchd.plist.tmpl");
  const tmpl = fs.readFileSync(tmplPath, "utf8");
  const body = tmpl
    .split("@@LABEL@@").join(job.label)
    .split("@@RUN_SH@@").join(job.runSh)
    .split("@@LOG_ROOT@@").join(job.logsDir)
    .split("@@CALENDAR@@").join(renderCalendar(entries));

  fs.mkdirSync(LAUNCH_AGENTS, { recursive: true });
  fs.mkdirSync(job.logsDir, { recursive: true });

  const tmp = job.plist + ".tmp";
  fs.writeFileSync(tmp, body);
  const lint = await run(["plutil", "-lint", tmp], { timeoutMs: 15000 });
  if (lint.rc !== 0) {
    fs.unlinkSync(tmp);
    throw new Error("generated plist is invalid: " + (lint.stderr || lint.stdout).trim());
  }
  fs.renameSync(tmp, job.plist);
  return job.plist;
}

/** Port of do_enable's bootstrap step: bootstrap, falling back to `load -w`
 * on failure; reloads (bootout then bootstrap) if already loaded so the
 * current plist takes effect. */
async function bootstrapAgent(job) {
  if (await agentLoaded(job.label)) {
    await launchctl(["bootout", `${DOMAIN}/${job.label}`]);
  }
  let res = await launchctl(["bootstrap", DOMAIN, job.plist]);
  let viaFallback = false;
  if (res.rc !== 0) {
    viaFallback = true;
    res = await launchctl(["load", "-w", job.plist]);
  }
  if (res.rc !== 0) {
    return {
      ok: false,
      message: `launchctl ${viaFallback ? "load -w" : "bootstrap"} failed (rc=${res.rc}): ${
        (res.stderr || res.stdout).trim() || "no output"
      }`,
    };
  }
  if (!(await agentLoaded(job.label))) {
    return { ok: false, message: `launchctl reported success but ${job.label} is not loaded` };
  }
  return { ok: true };
}

/** Port of do_disable's bootout step: bootout, falling back to `unload -w`. */
async function bootoutAgent(job) {
  let res = await launchctl(["bootout", `${DOMAIN}/${job.label}`]);
  let viaFallback = false;
  if (res.rc !== 0) {
    viaFallback = true;
    res = await launchctl(["unload", "-w", job.plist]);
  }
  if (res.rc !== 0) {
    return {
      ok: false,
      message: `launchctl ${viaFallback ? "unload -w" : "bootout"} failed (rc=${res.rc}): ${
        (res.stderr || res.stdout).trim() || "no output"
      }`,
    };
  }
  return { ok: true };
}

module.exports = {
  launchctl, agentLoaded, getLaunchctlPrint, getenv, listLoadedLabels, listPlistLabels,
  writePlist, bootstrapAgent, bootoutAgent,
};
