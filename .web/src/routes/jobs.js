"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");

const { listJobs, getJob } = require("../lib/jobsRoot");
const { Job } = require("../lib/job");
const { writeRunSh } = require("../lib/runsh");
const { parseSchedule, describeSchedule } = require("../lib/schedule");
const { gitInfo } = require("../lib/gitInfo");
const {
  agentLoaded, getLaunchctlPrint, writePlist, bootstrapAgent, bootoutAgent,
} = require("../lib/launchd");
const { autoModeSupported } = require("../lib/modelInfo");
const { withJobLock } = require("../lib/jobLock");
const { nowIsoSeconds, nowStamp } = require("../lib/util");
const { readCliState, saveCliState } = require("../lib/cliState");
const {
  AGENTS_DIR, TEMPLATES, NAME_RE, MODEL_ALIASES, PERMISSION_MODES,
  DEFAULT_TOKEN_FILE, DEFAULT_CLAUDE_BIN, DEFAULT_MODEL, FDA_HELP,
  DEFAULT_JIVA_BIN, DEFAULT_JIVA_CONFIG_FILE, DEFAULT_JIVA_PATH_EXTRA, RUNNERS,
} = require("../config");
const { requireAuth } = require("../middleware/requireAuth");
const { csrfProtect } = require("../middleware/csrf");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(requireAuth);

// ── ls ──────────────────────────────────────────────────────────────────
router.get(
  "/",
  asyncHandler(async (req, res) => {
    const jobs = listJobs();
    const out = [];
    for (const job of jobs) {
      const meta = job.meta();
      const last = job.recentRuns(1);
      const rec = last.length ? last[0] : null;
      const loaded = await agentLoaded(job.label);
      const runningPid = job.lockedPid();
      out.push({
        name: job.name,
        enabled: Boolean(meta.enabled),
        launchdLoaded: loaded,
        stale: Boolean(meta.enabled) && !loaded,
        scheduleDescribe: describeSchedule(meta),
        scheduleSpec: (meta.schedule || {}).spec || null,
        runner: meta.runner || "claude",
        model: meta.model || null,
        lastRun: rec,
        running: Boolean(runningPid),
        runningPid,
      });
    }
    res.json({ jobs: out });
  })
);

// ── new job wizard defaults (prefill from the CLI's own shared cache) ───
router.get("/_defaults", (req, res) => {
  res.json({
    defaults: readCliState(),
    defaultModel: DEFAULT_MODEL,
    permissionModes: PERMISSION_MODES,
    runners: RUNNERS,
    defaultJivaConfigFile: DEFAULT_JIVA_CONFIG_FILE,
    defaultJivaPathExtra: DEFAULT_JIVA_PATH_EXTRA,
  });
});

// ── show ────────────────────────────────────────────────────────────────
router.get(
  "/:name",
  asyncHandler(async (req, res) => {
    const job = getJob(req.params.name);
    if (!job) return res.status(404).json({ error: `no such job: ${req.params.name}` });

    const cfg = job.config();
    const meta = job.meta();
    const repo = cfg.REPO_DIR || "";
    const repoExists = repo ? fs.existsSync(repo) : false;
    const git = repoExists ? await gitInfo(repo) : null;

    let promptText = "";
    try {
      promptText = fs.readFileSync(job.prompt, "utf8");
    } catch (e) {
      /* prompt.md missing — surfaced via warnings below */
    }
    let scriptText = "";
    try {
      scriptText = fs.readFileSync(job.runSh, "utf8");
    } catch (e) {
      /* run.sh missing — job is broken; caught by other checks */
    }

    const loaded = await agentLoaded(job.label);
    let launchctlRaw = null;
    if (loaded) {
      const printRes = await getLaunchctlPrint(job.label);
      launchctlRaw = printRes.stdout;
    }

    const runner = cfg.RUNNER || "claude";
    const warnings = [];
    if (!promptText.trim()) warnings.push("prompt.md is empty or missing");
    if (runner === "jiva") {
      warnings.push(
        "Jiva's --code mode has no workspace-boundary enforcement — its file-write and shell tools " +
          "can reach anywhere this user can, not just REPO_DIR. Only use this runner where that's an acceptable risk."
      );
    } else {
      if (MODEL_ALIASES.has(cfg.MODEL || "")) {
        warnings.push(
          `MODEL is the alias "${cfg.MODEL}" — pin a full ID so behaviour and cost don't drift on the next release`
        );
      }
      const supported = autoModeSupported(cfg.MODEL || "");
      if (cfg.PERMISSION_MODE === "auto") {
        if (supported === false) {
          warnings.push(
            `permission mode "auto" with ${cfg.MODEL}: unsupported — the job fails at startup, not gracefully at runtime`
          );
        } else if (supported === null) {
          warnings.push(`permission mode "auto" with an unrecognised model "${cfg.MODEL}" — verify it supports auto mode`);
        }
      }
      if (cfg.PERMISSION_MODE === "bypassPermissions") {
        warnings.push(
          'permission mode "bypassPermissions" disables safety checks entirely — only appropriate for a genuinely isolated repo'
        );
      }
    }
    if (repo && !repoExists) warnings.push(`REPO_DIR does not exist: ${repo}`);
    else if (repo && !git) warnings.push(`${repo} is not a git repo — the run header won't have a commit`);

    res.json({
      name: job.name,
      dir: job.dir,
      config: cfg,
      meta,
      repo: { path: repo, exists: repoExists, git },
      prompt: promptText,
      script: scriptText,
      schedule: {
        spec: (meta.schedule || {}).spec || null,
        describe: describeSchedule(meta),
        entries: (meta.schedule || {}).entries || [],
      },
      launchd: { label: job.label, plistPath: job.plist, plistExists: fs.existsSync(job.plist), loaded, raw: launchctlRaw },
      runningPid: job.lockedPid(),
      recentRuns: [...job.recentRuns(5)].reverse(),
      warnings,
    });
  })
);

// ── new ─────────────────────────────────────────────────────────────────
router.post(
  "/",
  csrfProtect,
  asyncHandler(async (req, res) => {
    const body = req.body || {};
    const errors = {};

    const name = String(body.name || "").trim();
    if (!NAME_RE.test(name)) {
      errors.name = "must match ^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$ — becomes a launchd label and a path";
    } else if (fs.existsSync(path.join(AGENTS_DIR, name))) {
      errors.name = `${name} already exists`;
    }

    const runner = RUNNERS.includes(body.runner) ? body.runner : "claude";

    let canon = null, entries = null;
    try {
      ({ canon, entries } = parseSchedule(body.schedule || ""));
    } catch (e) {
      errors.schedule = e.message;
    }

    const timeoutSeconds = String(body.timeoutSeconds ?? "").trim();
    if (!/^\d+$/.test(timeoutSeconds)) errors.timeoutSeconds = "an integer (0 disables)";

    const logRetentionDays = String(body.logRetentionDays ?? "").trim();
    if (!/^\d+$/.test(logRetentionDays)) errors.logRetentionDays = "an integer (0 disables)";

    const pathExtra = String(body.pathExtra || "");

    if (runner === "jiva") {
      return createJivaJob(req, res, { name, errors, canon, entries, timeoutSeconds, logRetentionDays, pathExtra });
    }
    return createClaudeJob(req, res, { name, errors, canon, entries, timeoutSeconds, logRetentionDays, pathExtra });
  })
);

async function createClaudeJob(req, res, { name, errors, canon, entries, timeoutSeconds, logRetentionDays, pathExtra }) {
  const body = req.body || {};

  let repoDir = String(body.repoDir || "").trim();
  if (repoDir.startsWith("~")) repoDir = repoDir.replace(/^~/, process.env.HOME || "/Users/abi");
  repoDir = path.resolve(repoDir || "");
  if (!body.repoDir || !fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    errors.repoDir = `not a directory: ${body.repoDir || ""}`;
  }

  const model = String(body.model || "").trim();
  if (MODEL_ALIASES.has(model)) {
    errors.model = `"${model}" is an alias; it moves when Anthropic ships a release. Pin a full ID, e.g. claude-sonnet-5`;
  } else if (!model) {
    errors.model = "required";
  }

  const permissionMode = String(body.permissionMode || "").trim();
  const supported = autoModeSupported(model);
  if (!PERMISSION_MODES.includes(permissionMode)) {
    errors.permissionMode = "pick one of: " + PERMISSION_MODES.join(", ");
  } else if (permissionMode === "auto" && supported === false) {
    errors.permissionMode =
      `auto mode needs Opus 4.6+, Sonnet 4.6+ or Fable 5; ${model} does not support it and the job ` +
      "would fail at startup. Use dontAsk, or pick a newer model.";
  }

  const maxTurns = String(body.maxTurns ?? "").trim();
  if (!/^\d+$/.test(maxTurns) || parseInt(maxTurns, 10) <= 0) errors.maxTurns = "a positive integer";

  const maxBudgetUsd = String(body.maxBudgetUsd ?? "").trim();
  if (!/^\d+(\.\d+)?$/.test(maxBudgetUsd)) errors.maxBudgetUsd = "a number";

  if (Object.keys(errors).length) {
    return res.status(400).json({ error: "validation failed", fields: errors });
  }

  const warnings = [];
  let git = null;
  try {
    git = await gitInfo(repoDir);
  } catch (e) {
    git = null;
  }
  if (!git) warnings.push(`${repoDir} is not a git repo — the run header won't have a commit`);
  if (permissionMode === "auto" && supported === null) {
    warnings.push(`cannot verify that ${model} supports auto mode — if it does not, the job fails at startup`);
  }
  if (permissionMode === "bypassPermissions") {
    warnings.push(
      "bypassPermissions disables all safety checks and refuses to start under root/sudo. " +
        "No acceptance dialog is shown under -p. Only use this for a genuinely isolated repo."
    );
  }

  const job = new Job(name);
  fs.mkdirSync(job.stateDir, { recursive: true });
  fs.mkdirSync(job.logsDir, { recursive: true });
  writeRunSh(job.runSh, {
    JOB_NAME: name, REPO_DIR: repoDir, EXTRA_DIRS: [],
    MODEL: model, PERMISSION_MODE: permissionMode, MAX_TURNS: maxTurns,
    MAX_BUDGET_USD: maxBudgetUsd, ALLOWED_TOOLS: "", DISALLOWED_TOOLS: "",
    TIMEOUT_SECONDS: timeoutSeconds, LOG_RETENTION_DAYS: logRetentionDays,
    PATH_EXTRA: pathExtra, TOKEN_FILE: DEFAULT_TOKEN_FILE, CLAUDE_BIN: DEFAULT_CLAUDE_BIN,
  }, "run.sh.tmpl");
  fs.copyFileSync(path.join(TEMPLATES, "prompt.md.tmpl"), job.prompt);

  const meta = job.meta();
  meta.created = nowIsoSeconds();
  meta.enabled = false;
  meta.schedule = { spec: canon, entries };
  job.writeMeta(meta);
  await writePlist(job, entries);

  saveCliState(Object.assign({}, readCliState(), {
    last_runner: "claude",
    repo_dir: repoDir, model, permission_mode: permissionMode, schedule: canon,
    max_turns: parseInt(maxTurns, 10), max_budget_usd: parseFloat(maxBudgetUsd),
    timeout_seconds: parseInt(timeoutSeconds, 10), log_retention_days: parseInt(logRetentionDays, 10),
    path_extra: pathExtra,
  }));

  res.status(201).json({
    ok: true,
    name,
    dir: job.dir,
    warnings,
    fullDiskAccessHelp: FDA_HELP,
    nextSteps: [
      "Grant Full Disk Access to /bin/bash (see fullDiskAccessHelp) if the repo touches ~/Documents, ~/Desktop, ~/Downloads, or iCloud Drive.",
      "Write the task into prompt.md.",
      "Test it with Run Now on the job page.",
      "Enable it once you're happy — creation and activation are separate on purpose.",
    ],
  });
}

async function createJivaJob(req, res, { name, errors, canon, entries, timeoutSeconds, logRetentionDays, pathExtra }) {
  const body = req.body || {};

  let repoDir = String(body.repoDir || "").trim();
  if (repoDir.startsWith("~")) repoDir = repoDir.replace(/^~/, process.env.HOME || "/Users/abi");
  repoDir = path.resolve(repoDir || "");
  if (!body.repoDir || !fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) {
    errors.repoDir = `not a directory: ${body.repoDir || ""}`;
  }

  const maxIterations = String(body.jivaMaxIterations ?? "").trim();
  if (!/^\d+$/.test(maxIterations) || parseInt(maxIterations, 10) <= 0) {
    errors.jivaMaxIterations = "a positive integer";
  }

  let configFile = String(body.jivaConfigFile || DEFAULT_JIVA_CONFIG_FILE).trim();
  if (configFile.startsWith("~")) configFile = configFile.replace(/^~/, process.env.HOME || "/Users/abi");
  configFile = path.resolve(configFile);
  if (!fs.existsSync(configFile) || !fs.statSync(configFile).isFile()) {
    errors.jivaConfigFile = `not a file: ${configFile}`;
  }

  const directiveFile = String(body.jivaDirectiveFile || "").trim();

  const inputPrice = String(body.jivaInputPricePer1M ?? "").trim();
  if (inputPrice && !/^\d+(\.\d+)?$/.test(inputPrice)) errors.jivaInputPricePer1M = "a number, or blank";
  const outputPrice = String(body.jivaOutputPricePer1M ?? "").trim();
  if (outputPrice && !/^\d+(\.\d+)?$/.test(outputPrice)) errors.jivaOutputPricePer1M = "a number, or blank";

  if (Object.keys(errors).length) {
    return res.status(400).json({ error: "validation failed", fields: errors });
  }

  const warnings = [
    "Jiva's --code mode has no workspace-boundary enforcement — its file-write and shell tools can " +
      "reach anywhere this user can, not just this directory. Only proceed if that's an acceptable risk.",
  ];
  let git = null;
  try {
    git = await gitInfo(repoDir);
  } catch (e) {
    git = null;
  }
  if (!git) warnings.push(`${repoDir} is not a git repo — the run header won't have a commit`);

  const job = new Job(name);
  fs.mkdirSync(job.stateDir, { recursive: true });
  fs.mkdirSync(job.logsDir, { recursive: true });
  writeRunSh(job.runSh, {
    JOB_NAME: name, REPO_DIR: repoDir,
    JIVA_MAX_ITERATIONS: maxIterations, JIVA_CONFIG_FILE: configFile,
    JIVA_DIRECTIVE_FILE: directiveFile, JIVA_INPUT_PRICE_PER_1M: inputPrice,
    JIVA_OUTPUT_PRICE_PER_1M: outputPrice, TIMEOUT_SECONDS: timeoutSeconds,
    LOG_RETENTION_DAYS: logRetentionDays, PATH_EXTRA: pathExtra || DEFAULT_JIVA_PATH_EXTRA, JIVA_BIN: DEFAULT_JIVA_BIN,
  }, "run-jiva.sh.tmpl");
  fs.copyFileSync(path.join(TEMPLATES, "prompt.md.tmpl"), job.prompt);

  const meta = job.meta();
  meta.created = nowIsoSeconds();
  meta.enabled = false;
  meta.schedule = { spec: canon, entries };
  job.writeMeta(meta);
  await writePlist(job, entries);

  saveCliState(Object.assign({}, readCliState(), {
    last_runner: "jiva",
    jiva_repo_dir: repoDir, jiva_max_iterations: parseInt(maxIterations, 10),
    jiva_config_file: configFile, jiva_directive_file: directiveFile,
    jiva_input_price_per_1m: inputPrice, jiva_output_price_per_1m: outputPrice,
    jiva_path_extra: pathExtra, schedule: canon,
    timeout_seconds: parseInt(timeoutSeconds, 10), log_retention_days: parseInt(logRetentionDays, 10),
  }));

  res.status(201).json({
    ok: true,
    name,
    dir: job.dir,
    warnings,
    fullDiskAccessHelp: FDA_HELP,
    nextSteps: [
      "Write the task into prompt.md.",
      "Test it with Run Now on the job page.",
      "Enable it once you're happy — creation and activation are separate on purpose.",
    ],
  });
}

// ── edit: prompt ────────────────────────────────────────────────────────
router.put(
  "/:name/prompt",
  csrfProtect,
  asyncHandler(async (req, res) => {
    const job = getJob(req.params.name);
    if (!job) return res.status(404).json({ error: "no such job" });
    const content = req.body && typeof req.body.content === "string" ? req.body.content : null;
    if (content === null) return res.status(400).json({ error: "content (string) is required" });
    await withJobLock(job.name, async () => {
      fs.writeFileSync(job.prompt, content);
      res.json({ ok: true });
    });
  })
);

// ── edit: script (run.sh) ────────────────────────────────────────────────
router.put(
  "/:name/script",
  csrfProtect,
  asyncHandler(async (req, res) => {
    const job = getJob(req.params.name);
    if (!job) return res.status(404).json({ error: "no such job" });
    const content = req.body && typeof req.body.content === "string" ? req.body.content : null;
    if (content === null) return res.status(400).json({ error: "content (string) is required" });
    await withJobLock(job.name, async () => {
      fs.writeFileSync(job.runSh, content);
      try {
        fs.accessSync(job.runSh, fs.constants.X_OK);
      } catch (e) {
        fs.chmodSync(job.runSh, 0o755);
      }
      const meta = job.meta(); // resyncs job.json from the edited CONFIG block
      res.json({ ok: true, meta, note: "job.json resynced from run.sh" });
    });
  })
);

// ── enable ──────────────────────────────────────────────────────────────
router.post(
  "/:name/enable",
  csrfProtect,
  asyncHandler(async (req, res) => {
    const job = getJob(req.params.name);
    if (!job) return res.status(404).json({ error: "no such job" });
    await withJobLock(job.name, async () => {
      const meta = job.meta();
      const entries = (meta.schedule || {}).entries;
      if (!entries || !entries.length) {
        return res.status(400).json({ error: `${job.name} has no schedule — set one first` });
      }
      try {
        fs.accessSync(job.runSh, fs.constants.X_OK);
      } catch (e) {
        try {
          fs.chmodSync(job.runSh, 0o755);
        } catch (e2) {
          return res.status(500).json({ error: `run.sh is not executable and chmod failed: ${e2.message}` });
        }
      }
      try {
        await writePlist(job, entries);
      } catch (e) {
        return res.status(500).json({ error: e.message });
      }
      const result = await bootstrapAgent(job);
      if (!result.ok) return res.status(500).json({ error: result.message });
      meta.enabled = true;
      job.writeMeta(meta);
      res.json({ ok: true, enabled: true, schedule: describeSchedule(meta) });
    });
  })
);

// ── disable ─────────────────────────────────────────────────────────────
router.post(
  "/:name/disable",
  csrfProtect,
  asyncHandler(async (req, res) => {
    const job = getJob(req.params.name);
    if (!job) return res.status(404).json({ error: "no such job" });
    await withJobLock(job.name, async () => {
      const meta = job.meta();
      if (!(await agentLoaded(job.label))) {
        meta.enabled = false;
        job.writeMeta(meta);
        return res.json({ ok: true, enabled: false, note: `${job.name} was not loaded; marked disabled` });
      }
      const result = await bootoutAgent(job);
      if (!result.ok) return res.status(500).json({ error: result.message });
      meta.enabled = false;
      job.writeMeta(meta);
      res.json({ ok: true, enabled: false });
    });
  })
);

// ── schedule ────────────────────────────────────────────────────────────
router.put(
  "/:name/schedule",
  csrfProtect,
  asyncHandler(async (req, res) => {
    const job = getJob(req.params.name);
    if (!job) return res.status(404).json({ error: "no such job" });
    let canon, entries;
    try {
      ({ canon, entries } = parseSchedule((req.body && req.body.spec) || ""));
    } catch (e) {
      return res.status(400).json({ error: e.message });
    }
    await withJobLock(job.name, async () => {
      const meta = job.meta();
      meta.schedule = { spec: canon, entries };
      job.writeMeta(meta);
      await writePlist(job, entries);

      const wasActive = meta.enabled || (await agentLoaded(job.label));
      if (wasActive) {
        const result = await bootstrapAgent(job);
        if (!result.ok) {
          meta.enabled = false;
          job.writeMeta(meta);
          return res.status(500).json({ error: `${result.message} — job is now DISABLED` });
        }
      }
      res.json({ ok: true, schedule: canon, entries });
    });
  })
);

// ── rm ──────────────────────────────────────────────────────────────────
router.delete(
  "/:name",
  csrfProtect,
  asyncHandler(async (req, res) => {
    const job = getJob(req.params.name);
    if (!job) return res.status(404).json({ error: "no such job" });
    const { typedName, keepLogs } = req.body || {};
    if (typedName !== job.name) {
      return res.status(400).json({ error: "typed name did not match — nothing deleted" });
    }
    await withJobLock(job.name, async () => {
      if (await agentLoaded(job.label)) {
        const result = await bootoutAgent(job);
        if (await agentLoaded(job.label)) {
          return res.status(500).json({
            error: `could not unload ${job.label} — refusing to delete a job launchd still knows about: ${result.message || ""}`,
          });
        }
      }
      if (fs.existsSync(job.plist)) {
        try {
          fs.unlinkSync(job.plist);
        } catch (e) {
          /* non-fatal; mirrors the CLI's warn-and-continue */
        }
      }
      let kept = null;
      if (keepLogs) {
        const archiveRoot = path.join(AGENTS_DIR, ".archived-logs");
        fs.mkdirSync(archiveRoot, { recursive: true });
        kept = path.join(archiveRoot, job.name);
        if (fs.existsSync(kept)) kept = `${kept}-${nowStamp()}`;
        try {
          fs.renameSync(job.logsDir, kept);
        } catch (e) {
          kept = null;
        }
      }
      fs.rmSync(job.dir, { recursive: true, force: true });
      res.json({ ok: true, deleted: job.name, keptLogsAt: kept });
    });
  })
);

module.exports = router;
