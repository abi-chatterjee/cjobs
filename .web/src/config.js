"use strict";

const os = require("os");
const path = require("path");

const HOME = "/Users/abi";
const JOBS_ROOT = path.join(HOME, "claude-jobs");
// Every job (agent) lives under here. The whole dir is git-ignored, so job
// names, prompts, logs and target repo paths never reach the public repo.
const AGENTS_DIR = path.join(JOBS_ROOT, ".agents");
const TEMPLATES = path.join(JOBS_ROOT, ".templates");
const CLI_STATE = path.join(JOBS_ROOT, ".state", "cjob.json");
const LAUNCH_AGENTS = path.join(HOME, "Library", "LaunchAgents");
const LABEL_PREFIX = "com.abi.claudejob.";
const DEFAULT_TOKEN_FILE = path.join(HOME, ".secrets", "claude_oauth_token");
const DEFAULT_CLAUDE_BIN = path.join(HOME, ".local", "bin", "claude");
const DEFAULT_MODEL = "claude-sonnet-5";

// Jiva — the second runner ("low-level action execution" jobs, always
// --code mode). See .bin/cjob's own constants block for the same values —
// kept in lockstep, same as every other port in this codebase.
const DEFAULT_JIVA_BIN = path.join(HOME, ".nvm", "versions", "node", "v24.18.0", "bin", "jiva");
const DEFAULT_JIVA_CONFIG_FILE = path.join(HOME, ".jiva", "config.json");
const DEFAULT_JIVA_PATH_EXTRA = path.join(HOME, ".nvm", "versions", "node", "v24.18.0", "bin");
const RUNNERS = ["claude", "jiva"];

const WEB_ROOT = path.join(JOBS_ROOT, ".web");
const WEB_STATE_DIR = path.join(WEB_ROOT, ".state");
const SECRETS_DIR = path.join(HOME, ".secrets");
const AUTH_FILE = path.join(SECRETS_DIR, "cjobweb_auth.json");

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$/;
const MODEL_ALIASES = new Set(["opus", "sonnet", "haiku", "fable", "best", "opusplan"]);
const PERMISSION_MODES = ["auto", "dontAsk", "acceptEdits", "bypassPermissions"];

// Full IDs known to support auto mode, per buildspec §9.4.
const AUTO_SUPPORTED = new Set([
  "claude-opus-5", "claude-sonnet-5", "claude-fable-5",
  "claude-opus-4-8", "claude-sonnet-4-8",
  "claude-opus-4-6", "claude-sonnet-4-6",
]);

const FDA_HELP =
  "System Settings -> Privacy & Security -> Full Disk Access -> +\n" +
  "    then Cmd+Shift+G and enter:  /bin/bash\n" +
  "  The plist invokes /bin/bash, so the grant must be on /bin/bash itself.";

const DOMAIN = "gui/" + os.userInfo().uid;

const CONFIG_KEYS = [
  "JOB_NAME", "REPO_DIR", "EXTRA_DIRS", "MODEL", "PERMISSION_MODE",
  "MAX_TURNS", "MAX_BUDGET_USD", "ALLOWED_TOOLS", "DISALLOWED_TOOLS",
  "TIMEOUT_SECONDS", "LOG_RETENTION_DAYS", "PATH_EXTRA", "TOKEN_FILE",
  "CLAUDE_BIN",
];

const CONFIG_KEYS_JIVA = [
  "JOB_NAME", "REPO_DIR", "JIVA_MAX_ITERATIONS", "JIVA_CONFIG_FILE",
  "JIVA_DIRECTIVE_FILE", "JIVA_INPUT_PRICE_PER_1M", "JIVA_OUTPUT_PRICE_PER_1M",
  "TIMEOUT_SECONDS", "LOG_RETENTION_DAYS", "PATH_EXTRA", "JIVA_BIN",
];

const DAY_KEYS = {
  sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2,
  tuesday: 2, wed: 3, weds: 3, wednesday: 3, thu: 4, thur: 4,
  thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6,
};
const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const SCHEDULE_HELP =
  "specs:  hourly | hourly :07 | daily 03:00 | daily 03:00,15:00 | " +
  "weekdays 09:30 | weekends 10:00 | mon,thu 07:00";

const SECRET_RE = /(sk-ant-[A-Za-z0-9]{4})[A-Za-z0-9_-]{8,}/g;

module.exports = {
  HOME, JOBS_ROOT, AGENTS_DIR, TEMPLATES, CLI_STATE, LAUNCH_AGENTS, LABEL_PREFIX,
  DEFAULT_TOKEN_FILE, DEFAULT_CLAUDE_BIN, DEFAULT_MODEL,
  DEFAULT_JIVA_BIN, DEFAULT_JIVA_CONFIG_FILE, DEFAULT_JIVA_PATH_EXTRA, RUNNERS,
  WEB_ROOT, WEB_STATE_DIR, SECRETS_DIR, AUTH_FILE,
  NAME_RE, MODEL_ALIASES, PERMISSION_MODES, AUTO_SUPPORTED, FDA_HELP,
  DOMAIN, CONFIG_KEYS, CONFIG_KEYS_JIVA, DAY_KEYS, DAY_NAMES, SCHEDULE_HELP, SECRET_RE,
};
