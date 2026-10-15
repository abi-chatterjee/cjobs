"use strict";

const fs = require("fs");
const path = require("path");
const { run } = require("./procRun");
const { redact } = require("./redact");
const { listJobs } = require("./jobsRoot");
const { gitInfo } = require("./gitInfo");
const { launchctl, getenv, listLoadedLabels, listPlistLabels } = require("./launchd");
const { autoModeSupported } = require("./modelInfo");
const {
  HOME, LAUNCH_AGENTS, LABEL_PREFIX, DEFAULT_TOKEN_FILE, DEFAULT_CLAUDE_BIN,
  MODEL_ALIASES, FDA_HELP,
} = require("../config");

function distinctValues(cfgs, key, fallback) {
  const vals = new Set(cfgs.map(([, cfg]) => cfg[key] || fallback));
  const sorted = [...vals].sort();
  return sorted.length ? sorted : [fallback];
}

function usersOf(cfgs, key, value, fallback) {
  return cfgs.filter(([, cfg]) => (cfg[key] || fallback) === value).map(([j]) => j.name);
}

function stripAllWhitespace(s) {
  return s.replace(/\s+/g, "");
}

/** Builds the hermetic env used to smoke-test a token, matching
 * cjob's stripped_env(). */
function strippedEnv(tokenFile) {
  const env = {
    PATH: "/Users/abi/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    HOME,
  };
  if (tokenFile) {
    try {
      const token = stripAllWhitespace(fs.readFileSync(tokenFile, "utf8"));
      if (token) env.CLAUDE_CODE_OAUTH_TOKEN = token;
    } catch (e) {
      /* handled by the "token is live" check reporting no token to test */
    }
  }
  return env;
}

/** Async generator yielding one doctor result per check, in cjob's own
 * check order (1-11), so callers can stream progress incrementally. Each
 * yielded item: {n, name, status: "PASS"|"FAIL"|"WARN"|"SKIP", detail, remedy}. */
async function* runDoctor({ quick = false } = {}) {
  const jobs = listJobs();
  const cfgs = jobs.map((j) => [j, j.config()]);
  let n = 0;
  const next = (name, status, detail, remedy) => ({ n: ++n, name, status, detail: detail || "", remedy: remedy || "" });

  // 1 — claude binary
  const bins = distinctValues(cfgs, "CLAUDE_BIN", DEFAULT_CLAUDE_BIN);
  let claudeBin;
  {
    const goodBins = [];
    const notes = [];
    const problems = [];
    for (const binPath of bins) {
      const who = usersOf(cfgs, "CLAUDE_BIN", binPath, DEFAULT_CLAUDE_BIN).join(", ") || "default";
      let executable = false;
      try {
        const st = fs.statSync(binPath);
        if (st.isFile()) {
          fs.accessSync(binPath, fs.constants.X_OK); // throws if not executable
          executable = true;
        }
      } catch (e) {
        executable = false;
      }
      if (!executable) {
        problems.push(`${binPath}: not executable (used by ${who})`);
        continue;
      }
      const res = await run([binPath, "--version"], { timeoutMs: 30000 });
      if (res.rc !== 0) {
        problems.push(`${binPath}: \`--version\` failed rc=${res.rc} (used by ${who})`);
        continue;
      }
      goodBins.push(binPath);
      notes.push(`${binPath} — ${res.stdout.trim()}`);
    }
    if (problems.length) {
      yield next(
        "claude binary", "FAIL", problems.join("; "),
        "install Claude Code (claude install stable), or fix CLAUDE_BIN in\n" +
          "    the job's run.sh — run.sh is the source of truth"
      );
    } else {
      yield next("claude binary", "PASS", notes.join("; "));
    }
    claudeBin = goodBins.length ? goodBins[0] : bins[0];
  }

  // 2 — token files
  const tokens = distinctValues(cfgs, "TOKEN_FILE", DEFAULT_TOKEN_FILE);
  let goodTokens = [];
  {
    const notes = [];
    const problems = [];
    for (const tokenPath of tokens) {
      const who = usersOf(cfgs, "TOKEN_FILE", tokenPath, DEFAULT_TOKEN_FILE).join(", ") || "default";
      let st;
      try {
        st = fs.statSync(tokenPath);
      } catch (e) {
        problems.push(`${tokenPath}: missing (used by ${who})`);
        continue;
      }
      if (!st.isFile()) {
        problems.push(`${tokenPath}: missing (used by ${who})`);
        continue;
      }
      const mode = st.mode & 0o777;
      let body;
      try {
        body = fs.readFileSync(tokenPath, "utf8").trim();
      } catch (e) {
        problems.push(`${tokenPath}: cannot read (${e.message})`);
        continue;
      }
      if (!body) {
        problems.push(`${tokenPath}: empty (used by ${who})`);
      } else if (mode !== 0o600) {
        problems.push(`${tokenPath}: mode ${mode.toString(8)}, want 600`);
      } else {
        goodTokens.push(tokenPath);
        notes.push(`${tokenPath} — ${body.length} bytes, mode 600`);
      }
    }
    if (problems.length) {
      yield next(
        "token file", "FAIL", problems.join("; "),
        tokens.map((p) => `claude setup-token > ${p} && chmod 600 ${p}`).join("\n    ")
      );
    } else {
      yield next("token file", "PASS", notes.join("; "));
    }
  }
  const tokenFile = goodTokens.length ? goodTokens[0] : tokens[0];

  // 3 — ANTHROPIC_API_KEY absent from login environment
  {
    const problems = [];
    const envRes = await getenv("ANTHROPIC_API_KEY");
    if (envRes.rc === 0 && envRes.stdout.trim()) {
      problems.push("launchctl getenv ANTHROPIC_API_KEY is set (launchctl unsetenv ANTHROPIC_API_KEY)");
    }
    for (const rcfile of [".zshrc", ".zprofile", ".zshenv", ".bash_profile", ".profile"]) {
      const p = path.join(HOME, rcfile);
      let text;
      try {
        if (!fs.statSync(p).isFile()) continue;
        text = fs.readFileSync(p, "utf8");
      } catch (e) {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const bare = lines[i].trim();
        if (bare.startsWith("#") || !bare.includes("ANTHROPIC_API_KEY")) continue;
        if (/\b(export|set|setenv)\b.*ANTHROPIC_API_KEY|^ANTHROPIC_API_KEY=/.test(bare)) {
          problems.push(`~/${rcfile}:${i + 1} sets it`);
        }
      }
    }
    if (process.env.ANTHROPIC_API_KEY) {
      problems.push("it is set in this web server process's environment");
    }
    if (problems.length) {
      yield next(
        "ANTHROPIC_API_KEY absent", "FAIL", problems.join("; "),
        "An API key takes precedence over the subscription credential, so\n" +
          "    the job would quietly bill Console credits instead of the Max plan.\n" +
          "    Remove it from the login environment. (run.sh unsets it too.)"
      );
    } else {
      yield next("ANTHROPIC_API_KEY absent", "PASS", "not in launchctl env, shell rc files, or this process");
    }
  }

  // 4 — token is live
  if (quick) {
    yield next("token is live", "SKIP", "skipped (quick mode)");
  } else if (!(goodTokens.length && bins.length && typeof claudeBin === "string")) {
    yield next("token is live", "SKIP", "skipped — no usable token/binary");
  } else {
    const env = strippedEnv(tokenFile);
    if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
      yield next("token is live", "FAIL", "no token to test", "see the token file check");
    } else {
      const res = await run(
        [
          claudeBin, "-p", "reply with the single word: ok",
          "--model", "claude-haiku-4-5-20251001",
          "--permission-mode", "dontAsk", "--max-turns", "1",
          "--output-format", "json",
        ],
        { env, cwd: HOME, timeoutMs: 180000 }
      );
      let data = null;
      try {
        data = JSON.parse(res.stdout);
      } catch (e) {
        /* fall through to raw-output branch */
      }
      if (data && typeof data === "object" && !data.is_error) {
        yield next("token is live", "PASS", `haiku replied: ${JSON.stringify(String(data.result || "")).slice(0, 42)}`);
      } else if (data && typeof data === "object") {
        const detail = redact(String(data.result || "")).slice(0, 240);
        let remedy = `the token is expired or revoked — regenerate:\n    claude setup-token > ${tokenFile} && chmod 600 ${tokenFile}`;
        if (detail.includes("invalid value") || detail.includes("Authorization")) {
          remedy =
            `the token was rejected as malformed, not expired —\n` +
            `    ${tokenFile} most likely contains a stray line break.\n` +
            `    Rewrite it on one line:\n` +
            `    claude setup-token | tr -d '[:space:]' > ${tokenFile} && chmod 600 ${tokenFile}`;
        }
        yield next("token is live", "FAIL", detail, remedy);
      } else {
        yield next(
          "token is live", "FAIL",
          `no JSON result (rc=${res.rc}) ${redact((res.stderr || res.stdout).trim()).slice(0, 240)}`,
          "run the same command by hand to see the failure"
        );
      }
    }
  }

  // 5 — job repos
  if (!cfgs.length) {
    yield next("job repos", "SKIP", "no jobs defined");
  } else {
    const bad = [];
    for (const [job, cfg] of cfgs) {
      const repo = cfg.REPO_DIR || "";
      if (!repo) {
        bad.push(`${job.name}: REPO_DIR is empty`);
        continue;
      }
      let isDir = false;
      try {
        isDir = fs.statSync(repo).isDirectory();
      } catch (e) {
        isDir = false;
      }
      if (!isDir) {
        bad.push(`${job.name}: ${repo} does not exist`);
        continue;
      }
      if (!(await gitInfo(repo))) {
        bad.push(`${job.name}: ${repo} is not a git repo`);
      }
    }
    if (bad.length) {
      yield next(
        "job repos", "FAIL", bad.join("; "),
        "fix REPO_DIR in the job's run.sh (run.sh is the source of truth),\n" +
          "    then check the job's detail page to confirm"
      );
    } else {
      yield next("job repos", "PASS", `${cfgs.length} repo(s) present and git-tracked`);
    }
  }

  // 6 — run.sh executable
  if (!jobs.length) {
    yield next("run.sh executable", "SKIP", "no jobs defined");
  } else {
    const bad = jobs.filter((j) => {
      try {
        fs.accessSync(j.runSh, fs.constants.X_OK);
        return false;
      } catch (e) {
        return true;
      }
    });
    if (bad.length) {
      yield next(
        "run.sh executable", "FAIL", "not executable: " + bad.map((j) => j.name).join(", "),
        "chmod +x " + bad.map((j) => j.runSh).join(" ")
      );
    } else {
      yield next("run.sh executable", "PASS", `${jobs.length} script(s) executable`);
    }
  }

  // 7 — launchd agents match jobs
  {
    const loadedLabels = await listLoadedLabels();
    const plistLabels = listPlistLabels();
    const troubles = [];
    for (const job of jobs) {
      const meta = job.meta();
      if (meta.enabled && !loadedLabels.has(job.label)) {
        troubles.push(`${job.name} is enabled in job.json but not loaded (enable it again from its job page)`);
      }
    }
    const known = new Set(jobs.map((j) => j.label));
    const allLabels = [...new Set([...loadedLabels, ...plistLabels])].sort();
    for (const label of allLabels) {
      if (!known.has(label)) {
        troubles.push(
          `orphan: ${label} has no job directory ` +
            `(launchctl bootout gui/$(id -u)/${label}; rm ${LAUNCH_AGENTS}/${label}.plist)`
        );
      }
    }
    if (troubles.length) {
      yield next("launchd agents", "FAIL", troubles.join("; "), "see parentheses above");
    } else {
      yield next(
        "launchd agents", "PASS",
        `${loadedLabels.size} loaded, ${plistLabels.size} plist(s), no orphans`
      );
    }
  }

  // 8 — Full Disk Access for /bin/bash
  {
    const probe = path.join(HOME, "Library", "Application Support", "com.apple.TCC", "TCC.db");
    const res = await run(
      ["/bin/bash", "-c", 'head -c 16 "$1" >/dev/null 2>&1 && echo yes || echo no', "_", probe],
      { timeoutMs: 15000 }
    );
    if (res.stdout.trim() === "yes") {
      yield next("Full Disk Access", "PASS", "/bin/bash can read TCC-protected paths");
    } else {
      yield next(
        "Full Disk Access", "FAIL", `/bin/bash cannot read ${probe}`,
        "TCC will block a scheduled run from reading ~/Documents, ~/Desktop,\n" +
          "    ~/Downloads and iCloud Drive. Grant it to /bin/bash (the plist\n" +
          "    invokes /bin/bash, so the grant must be on the shell, not the repo):\n" +
          "    " + FDA_HELP.replace(/\n/g, "\n    ") + "\n" +
          "    Caveat: this probe reflects the web server's ability to spawn\n" +
          "    /bin/bash. The definitive test is one scheduled run that touches\n" +
          "    such a path."
      );
    }
  }

  // 9 — models pinned
  {
    const aliased = cfgs.filter(([, cfg]) => MODEL_ALIASES.has(cfg.MODEL || ""));
    if (!cfgs.length) {
      yield next("models pinned", "SKIP", "no jobs defined");
    } else if (aliased.length) {
      yield next(
        "models pinned", "WARN",
        aliased.map(([j, cfg]) => `${j.name} uses the alias "${cfg.MODEL}"`).join("; "),
        "Aliases resolve to a floating default that moves when Anthropic\n" +
          "    ships a release, changing this job's behaviour and cost without\n" +
          "    you touching anything. Pin a full ID, e.g. claude-sonnet-5."
      );
    } else {
      yield next("models pinned", "PASS", `all ${cfgs.length} job(s) pin a full model ID`);
    }
  }

  // 10 — auto-mode preconditions
  {
    const autoBad = [];
    const autoUnknown = [];
    const autoOkJobs = [];
    for (const [job, cfg] of cfgs) {
      if (cfg.PERMISSION_MODE !== "auto") continue;
      const model = cfg.MODEL || "";
      const supported = autoModeSupported(model);
      if (supported === true) autoOkJobs.push(job.name);
      else if (supported === false) autoBad.push(`${job.name}: ${model} does not support auto mode`);
      else autoUnknown.push(`${job.name}: cannot verify ${model} supports auto mode`);
    }
    const anyAuto = cfgs.some(([, cfg]) => cfg.PERMISSION_MODE === "auto");
    if (!anyAuto) {
      yield next("auto-mode model gating", "PASS", "no job uses auto mode");
    } else if (autoBad.length) {
      yield next(
        "auto-mode model gating", "FAIL", autoBad.join("; "),
        "Auto mode needs Opus 4.6+, Sonnet 4.6+, or Fable 5. With an\n" +
          "    unsupported model the job fails at startup, not gracefully at\n" +
          "    runtime. Switch PERMISSION_MODE to dontAsk or pin a newer model."
      );
    } else if (autoUnknown.length) {
      yield next(
        "auto-mode model gating", "WARN", autoUnknown.join("; "),
        "verify the model supports auto mode (Opus 4.6+/Sonnet 4.6+/Fable 5)"
      );
    } else {
      yield next("auto-mode model gating", "PASS", `auto mode ok for: ${autoOkJobs.join(", ")}`);
    }
  }

  // 11 — is --max-turns honoured by this claude build?
  {
    if (typeof claudeBin !== "string") {
      yield next("--max-turns honoured", "SKIP", "could not read `claude --help`");
    } else {
      const res = await run([claudeBin, "--help"], { timeoutMs: 30000 });
      if (res.rc !== 0) {
        yield next("--max-turns honoured", "SKIP", "could not read `claude --help`");
      } else if (res.stdout.includes("--max-turns")) {
        yield next("--max-turns honoured", "PASS", "advertised by claude --help");
      } else {
        const verRes = await run([claudeBin, "--version"], { timeoutMs: 30000 });
        yield next(
          "--max-turns honoured", "WARN",
          `claude ${verRes.stdout.trim() || "?"} does not advertise --max-turns in --help`,
          "The flag is accepted without error but is not documented in this\n" +
            "    build, so do not rely on MAX_TURNS as a ceiling. MAX_BUDGET_USD\n" +
            "    (--max-budget-usd) and TIMEOUT_SECONDS are the enforced limits."
        );
      }
    }
  }
}

module.exports = { runDoctor };
