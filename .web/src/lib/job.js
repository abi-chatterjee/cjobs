"use strict";

const fs = require("fs");
const path = require("path");
const {
  AGENTS_DIR, LAUNCH_AGENTS, LABEL_PREFIX, DEFAULT_TOKEN_FILE, DEFAULT_CLAUDE_BIN,
  DEFAULT_JIVA_BIN, DEFAULT_JIVA_CONFIG_FILE,
} = require("../config");
const { parseRunSh, cfgInt, cfgNum } = require("./runsh");
const { readRun } = require("./logs");
const { nowIsoSeconds, atomicWriteJson } = require("./util");

class Job {
  constructor(name) {
    this.name = name;
    this.dir = path.join(AGENTS_DIR, name);
  }

  get runSh() { return path.join(this.dir, "run.sh"); }
  get prompt() { return path.join(this.dir, "prompt.md"); }
  get jobJson() { return path.join(this.dir, "job.json"); }
  get stateDir() { return path.join(this.dir, "state"); }
  get logsDir() { return path.join(this.dir, "logs"); }
  get label() { return LABEL_PREFIX + this.name; }
  get plist() { return path.join(LAUNCH_AGENTS, this.label + ".plist"); }
  get lockDir() { return path.join(this.stateDir, "run.lock"); }

  /** run.sh's CONFIG block, parsed (never executed). Source of truth. */
  config() {
    return parseRunSh(this.runSh);
  }

  /** Port of Job.meta(): job.json re-synced from run.sh on every read. run.sh
   * always wins for the keys it owns; job.json owns only enabled/schedule/
   * created. Pass sync=false to read job.json as-is (no resync, no write). */
  meta(sync = true) {
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(this.jobJson, "utf8"));
      if (!meta || typeof meta !== "object" || Array.isArray(meta)) meta = {};
    } catch (e) {
      meta = {};
    }
    if (!sync) return meta;

    const cfg = this.config();
    const runner = cfg.RUNNER || "claude";
    let derived;
    if (runner === "jiva") {
      derived = {
        name: this.name,
        runner: "jiva",
        repo_dir: cfg.REPO_DIR || "",
        timeout_seconds: cfgInt(cfg, "TIMEOUT_SECONDS"),
        log_retention_days: cfgInt(cfg, "LOG_RETENTION_DAYS"),
        jiva_max_iterations: cfgInt(cfg, "JIVA_MAX_ITERATIONS", 30),
        jiva_config_file: cfg.JIVA_CONFIG_FILE || DEFAULT_JIVA_CONFIG_FILE,
        jiva_directive_file: cfg.JIVA_DIRECTIVE_FILE || "",
        jiva_input_price_per_1m: cfgNum(cfg, "JIVA_INPUT_PRICE_PER_1M", null),
        jiva_output_price_per_1m: cfgNum(cfg, "JIVA_OUTPUT_PRICE_PER_1M", null),
        jiva_bin: cfg.JIVA_BIN || DEFAULT_JIVA_BIN,
      };
    } else {
      derived = {
        name: this.name,
        runner: "claude",
        repo_dir: cfg.REPO_DIR || "",
        model: cfg.MODEL || "",
        permission_mode: cfg.PERMISSION_MODE || "",
        max_turns: cfgInt(cfg, "MAX_TURNS"),
        max_budget_usd: cfgNum(cfg, "MAX_BUDGET_USD"),
        timeout_seconds: cfgInt(cfg, "TIMEOUT_SECONDS"),
        log_retention_days: cfgInt(cfg, "LOG_RETENTION_DAYS"),
        extra_dirs: cfg.EXTRA_DIRS || [],
        allowed_tools: cfg.ALLOWED_TOOLS || "",
        disallowed_tools: cfg.DISALLOWED_TOOLS || "",
        token_file: cfg.TOKEN_FILE || DEFAULT_TOKEN_FILE,
        claude_bin: cfg.CLAUDE_BIN || DEFAULT_CLAUDE_BIN,
      };
    }

    let changed = false;
    for (const [k, v] of Object.entries(derived)) {
      if (JSON.stringify(meta[k]) !== JSON.stringify(v)) changed = true;
      meta[k] = v;
    }
    if (meta.enabled === undefined) meta.enabled = false;
    if (meta.schedule === undefined) meta.schedule = {};
    if (meta.created === undefined) meta.created = null;

    if (changed && fs.existsSync(this.dir) && fs.statSync(this.dir).isDirectory()) {
      this.writeMeta(meta);
    }
    return meta;
  }

  writeMeta(meta) {
    meta.synced_from_run_sh = nowIsoSeconds();
    atomicWriteJson(this.jobJson, meta);
  }

  lastRun() {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.stateDir, "last-run.json"), "utf8"));
    } catch (e) {
      return null;
    }
  }

  logDates() {
    let names;
    try {
      names = fs.readdirSync(this.logsDir);
    } catch (e) {
      return [];
    }
    const dates = names.filter((n) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(n)) return false;
      try {
        return fs.statSync(path.join(this.logsDir, n)).isDirectory();
      } catch (e) {
        return false;
      }
    });
    return dates.sort();
  }

  runsOn(date) {
    const dir = path.join(this.logsDir, date);
    let names;
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".log")).sort();
    } catch (e) {
      return [];
    }
    return names.map((name) => readRun(path.join(dir, name), date, name.slice(0, -4)));
  }

  recentRuns(limit = 5) {
    let out = [];
    const dates = this.logDates();
    for (let i = dates.length - 1; i >= 0; i--) {
      out = this.runsOn(dates[i]).concat(out);
      if (out.length >= limit) break;
    }
    return limit ? out.slice(-limit) : out;
  }

  /** Port of locked_pid(): returns the live PID holding run.lock, or null if
   * unlocked/stale. Mirrors cjob's behavior of treating ANY error from the
   * liveness probe (not just "no such process") as "not alive". */
  lockedPid() {
    let pid;
    try {
      const raw = fs.readFileSync(path.join(this.lockDir, "pid"), "utf8").trim();
      if (!/^-?\d+$/.test(raw)) return null;
      pid = parseInt(raw, 10);
    } catch (e) {
      return null;
    }
    try {
      process.kill(pid, 0);
      return pid;
    } catch (e) {
      return null;
    }
  }
}

module.exports = { Job };
