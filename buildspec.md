# Build spec: `claude-jobs` — a local scheduled-agent runner for macOS

You are building a small system that runs Claude Code headlessly on a schedule against a
specific repo, with per-job directories, structured logs, and a REPL CLI to administer it all.

Read this whole document before writing any code. Section 9 lists non-obvious constraints that
will silently break the system if ignored — several of them are things that look fine in an
interactive terminal and fail only under a scheduler.

---

## 1. Environment (verified — do not re-derive)

| Fact | Value |
|---|---|
| OS | macOS |
| User | `abi`, home `/Users/abi` |
| Claude Code binary | `/Users/abi/.local/bin/claude` |
| Claude Code version | `2.1.220` |
| Plan | Claude Max subscription |
| Auth for headless | `CLAUDE_CODE_OAUTH_TOKEN` (long-lived, one year, from `claude setup-token`) |
| Scheduler | **launchd**, not cron (see §9.1) |
| Admin CLI language | Python 3 (stdlib only — no pip installs) |

Assume nothing else about the machine. Do not install Homebrew packages. Do not use `flock`
(not present on macOS). Do not use `realpath` (not present by default). Stick to what ships
with macOS plus Python 3.

---

## 2. What we're building

Three things:

1. **A per-job runner script** (`run.sh`) — one per job, fully configurable from a variable
   block at the top of the file. This is the thing launchd actually executes.
2. **A job directory convention** — everything belonging to a job (prompt, config, script,
   logs, state, schedule) lives under one directory.
3. **`cjob`** — an interactive REPL CLI to create, inspect, run, schedule, and tail jobs.

---

## 3. Directory layout

```
/Users/abi/claude-jobs/
├── .templates/                     # not a job; skipped by the job scanner
│   ├── run.sh.tmpl
│   ├── prompt.md.tmpl
│   └── launchd.plist.tmpl
├── .state/
│   └── cjob.json                   # CLI-level state (last-used defaults, etc.)
└── .agents/                        # all jobs live here; git-ignored (repo is public)
    ├── nightly-review/             # a job
    │   ├── run.sh                  # executable; the launchd entrypoint
    │   ├── prompt.md               # the brain-facing instruction
    │   ├── job.json                # metadata the CLI reads (schedule, repo, model, enabled)
    │   ├── state/
    │   │   ├── last-run.json       # exit code, duration, cost, turns, session_id
    │   │   └── run.lock/           # lock DIRECTORY (see §9.5)
    │   └── logs/
    │       └── 2026-07-27/
    │           ├── 03-00-04.log    # human-readable, primary artifact
    │           └── 03-00-04.result.json # raw --output-format json result
    └── digest-inbox/
        └── ...
```

Rules:

- A directory directly under `~/claude-jobs/.agents/` is a job **iff** it does not start with
  `.` and contains a `job.json`. Everything else is ignored by the scanner. (Originally jobs sat
  directly under `~/claude-jobs/`; they moved into `.agents/` so one ignore rule keeps every job
  name out of the public repo.)
- Job names must match `^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$`. Reject anything else at creation
  time — the name becomes part of a launchd label and a filesystem path.
- The CLI binary installs to `/Users/abi/.local/bin/cjob` (already on PATH for interactive
  shells).

`job.json` is metadata only — the CLI reads it to display and to generate the plist. The
**source of truth for how the job runs is `run.sh`**, because the user wants to be able to open
that one file and tweak everything. `cjob` may regenerate `job.json` by parsing the variable
block out of `run.sh`; it must never silently overwrite `run.sh` values from `job.json`.

---

## 4. The runner script

Generate this from `.templates/run.sh.tmpl` at job-creation time, substituting the job name and
defaults. Every knob lives in one block at the top, above a clearly-marked line after which the
user isn't expected to edit.

```bash
#!/bin/bash
# ─────────────────────────────────────────────────────────────
#  CONFIG — edit anything in this block
# ─────────────────────────────────────────────────────────────

JOB_NAME="nightly-review"

# The repo Claude runs inside. Its CLAUDE.md / .claude/ dir is the "brain".
REPO_DIR="/Users/abi/code/my-brain-repo"

# Extra directories Claude may read/write (space-separated, may be empty).
EXTRA_DIRS=()

# Model — PIN A FULL ID, not an alias. Aliases float across releases and
# will change this job's behavior and cost without you touching anything.
MODEL="claude-sonnet-5"

# Permission mode: auto | dontAsk | acceptEdits | bypassPermissions
PERMISSION_MODE="auto"

# Hard ceilings. These are the load-bearing part of "predictable usage".
MAX_TURNS=25
MAX_BUDGET_USD=3

# Optional extra allow-rules layered on top of the permission mode.
ALLOWED_TOOLS=""          # e.g. "Read,Grep,Glob,Bash(git log:*)"
DISALLOWED_TOOLS=""       # e.g. "Bash(git push:*),WebFetch"

# Wall-clock kill switch, seconds. 0 disables.
TIMEOUT_SECONDS=1800

# Retention: delete log date-directories older than this many days. 0 disables.
LOG_RETENTION_DAYS=30

# Where the token lives (chmod 600).
TOKEN_FILE="/Users/abi/.secrets/claude_oauth_token"

CLAUDE_BIN="/Users/abi/.local/bin/claude"

# ─────────────────────────────────────────────────────────────
#  END CONFIG — you shouldn't need to edit below here
# ─────────────────────────────────────────────────────────────
```

### Behaviour below the config line

1. `set -uo pipefail`. **Not** `set -e` — we want to reach the footer-writing and lock-release
   code even when `claude` exits non-zero.
2. Build a hermetic environment:
   - `export PATH="/Users/abi/.local/bin:/usr/bin:/bin:/usr/sbin:/sbin"`
   - `export HOME="/Users/abi"`
   - `unset ANTHROPIC_API_KEY` — **required**, see §9.2
   - `export CLAUDE_CODE_OAUTH_TOKEN="$(cat "$TOKEN_FILE")"`
   - Fail loudly with a clear message if `$TOKEN_FILE` is missing or empty.
3. Acquire the lock (§9.5). If already held, append one line to today's log noting the skip and
   exit 0 — a skipped run is not a failure.
4. Compute log paths:
   - `LOG_DIR="$JOB_DIR/logs/$(date +%Y-%m-%d)"`
   - `LOG_FILE="$LOG_DIR/$(date +%H-%M-%S).log"`
   - `RESULT_FILE="${LOG_FILE%.log}.result.json"`
   - `mkdir -p "$LOG_DIR"`
   - Use local time, not UTC. Derive the timestamp **once** into a variable so the `.log` and
     `.result.json` can't straddle a second boundary and end up with mismatched names.
5. Write a header to `$LOG_FILE`: job name, ISO-8601 start time, model, permission mode, repo
   path, current git branch and short SHA of `$REPO_DIR`, and the resolved `claude --version`.
   This is what makes a six-month-old log interpretable.
6. `cd "$REPO_DIR"` — hard-fail if it doesn't exist. Running in the repo is how Claude picks up
   `CLAUDE.md` and `.claude/skills/`; do not try to inject the brain files via the prompt.
7. Invoke:

```bash
"$CLAUDE_BIN" -p "$(cat "$JOB_DIR/prompt.md")" \
  --model "$MODEL" \
  --permission-mode "$PERMISSION_MODE" \
  --max-turns "$MAX_TURNS" \
  --max-budget-usd "$MAX_BUDGET_USD" \
  --output-format json \
  ${ALLOWED_TOOLS:+--allowedTools "$ALLOWED_TOOLS"} \
  ${DISALLOWED_TOOLS:+--disallowedTools "$DISALLOWED_TOOLS"} \
  "${ADD_DIR_ARGS[@]}" \
  > "$RESULT_FILE" 2>> "$LOG_FILE"
```

   Wrap in a timeout if `TIMEOUT_SECONDS > 0`. macOS has no `timeout(1)`; implement it by
   backgrounding `claude`, recording its PID, and running a watchdog subshell that sleeps then
   `kill`s. Record in the log whether the run was killed by the watchdog versus exited on its own
   — those are very different failures.
8. Append to `$LOG_FILE`: the pretty-printed result JSON, then a footer with exit code, wall
   duration, and the `result`, `num_turns`, `total_cost_usd`, `is_error`, and `session_id`
   fields pulled out of `$RESULT_FILE`. Parse with `python3 -c`, not `grep`/`sed` — the result
   text is free-form model output and will contain braces and quotes.
9. Write `state/last-run.json` with the same fields plus the log path.
10. Prune log date-directories older than `LOG_RETENTION_DAYS`.
11. Release the lock (trap on EXIT so it releases on crash too). Exit with claude's exit code.

---

## 5. `prompt.md`

Created from a template that includes a standing preamble the user can edit or delete. The
preamble exists because a headless run has nobody to answer a question:

```markdown
<!-- Standing instructions for unattended runs. -->
You are running unattended on a schedule. There is no human available.
- Never ask a clarifying question. If a decision is ambiguous, pick the most conservative
  option, proceed, and record the ambiguity in your final summary.
- Finish with a concrete artifact: a written file, a commit, or an explicit "nothing to do".
- Do not end a turn waiting for confirmation.

<!-- Your task below. -->
```

The runner passes this file's contents as the prompt. Keep it a file, not a heredoc inside
`run.sh`, so it can be edited without touching the executable.

---

## 6. Scheduling with launchd

One agent per job at
`/Users/abi/Library/LaunchAgents/com.abi.claudejob.<job-name>.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.abi.claudejob.JOB_NAME</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>/Users/abi/claude-jobs/JOB_NAME/run.sh</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>0</integer>
  </dict>
  <key>StandardErrorPath</key>
  <string>/Users/abi/claude-jobs/JOB_NAME/logs/launchd.err</string>
  <key>StandardOutPath</key>
  <string>/Users/abi/claude-jobs/JOB_NAME/logs/launchd.out</string>
  <key>ProcessType</key><string>Background</string>
</dict>
</plist>
```

`StartCalendarInterval` may also be an *array* of dicts for multiple fire times per day —
support that. Note that `launchd.err` / `launchd.out` sit at `logs/` root, outside the dated
subdirectories; they catch failures that happen before `run.sh` can open its own log, which is
exactly the class of bug you'll hit first.

Load/unload with:

```bash
launchctl bootstrap gui/$(id -u) <plist>     # enable
launchctl bootout   gui/$(id -u)/<label>     # disable
launchctl kickstart -k gui/$(id -u)/<label>  # run now
launchctl print     gui/$(id -u)/<label>     # inspect
```

Fall back to `launchctl load -w` / `unload -w` only if `bootstrap` errors — and surface the real
error rather than swallowing it.

---

## 7. The `cjob` REPL

Python 3, stdlib only, `cmd.Cmd` plus `readline` for history and tab-completion. Launching
`cjob` with no arguments enters the REPL; `cjob <command> ...` runs a single command and exits,
so the same code serves both interactive and scripted use.

### Commands

| Command | Behaviour |
|---|---|
| `ls` | Table of jobs: name, enabled?, schedule (human-readable, e.g. "daily 03:00"), model, last run time, last exit code, last cost. |
| `show <job>` | Full detail: resolved config from `run.sh`'s variable block, repo path + current branch, prompt preview, plist status from `launchctl print`, last 5 runs. |
| `new` | Interactive wizard → job name, repo dir, model, permission mode, schedule, ceilings. Scaffolds the directory, renders templates, `chmod +x run.sh`, opens `prompt.md` in `$EDITOR`. Does **not** enable the schedule; creation and activation are separate steps. |
| `edit <job> [prompt\|script\|config]` | Opens the relevant file in `$EDITOR`. Defaults to `prompt`. |
| `run <job>` | Executes `run.sh` in the foreground, streaming output. Must set up the same clean environment the scheduler would (see §9.7) so a passing `run` means something. |
| `logs <job> [--date YYYY-MM-DD]` | Lists log files for a date (default today, falling back to most recent date with runs), with time, exit code, duration, cost. |
| `log <job> [<date> <time>]` | Prints one log. Bare form = most recent run. |
| `tail <job>` | Follows the newest log file live. Useful next to `run`. |
| `enable <job>` / `disable <job>` | Bootstrap / bootout the launchd agent. Update `job.json`. |
| `schedule <job> <spec>` | Sets fire time(s). Accept `daily 03:00`, `weekdays 09:30`, `hourly`, `mon,thu 07:00`. Rewrite the plist, and if currently enabled, bootout + bootstrap to apply. |
| `usage [<job>] [--days N]` | Aggregates `total_cost_usd` and `num_turns` across `.result.json` files. This is the "predictable usage" dashboard. |
| `rm <job>` | Disables, then deletes after a typed confirmation of the job name. Offers to keep logs. |
| `doctor` | Runs every check in §8. |
| `help`, `quit` | Standard. |

### UX requirements

- Tab-complete job names on every command that takes one.
- Colour via raw ANSI codes; suppress when `not sys.stdout.isatty()`.
- Never `shell=True`. Build argument lists.
- Exit non-zero from one-shot mode when the underlying operation failed, so `cjob` is itself
  scriptable.

---

## 8. `doctor` checks

Each check prints PASS/FAIL plus a specific remediation string.

1. `$CLAUDE_BIN` exists and is executable; print `claude --version`.
2. `$TOKEN_FILE` exists, is non-empty, and is mode `600`.
3. `ANTHROPIC_API_KEY` is **not** set in the user's login environment (`launchctl getenv
   ANTHROPIC_API_KEY` and a scan of `~/.zshrc`, `~/.zprofile`, `~/.zshenv`). See §9.2.
4. Token is live: run `claude -p "reply with the single word: ok" --model claude-haiku-4-5-20251001
   --permission-mode dontAsk --max-turns 1 --output-format json` in an env with only the token
   set, and check `is_error` is false. Cheap, and catches an expired token before 3am does.
5. Each job's `REPO_DIR` exists and is a git repo.
6. Each job's `run.sh` is executable.
7. Each enabled job has a loaded launchd agent, and each loaded agent has a job directory
   (catches orphaned plists).
8. `/bin/bash` has Full Disk Access — probe by reading a TCC-protected path such as
   `~/Library/Application Support/com.apple.TCC`; on failure, print the exact System Settings
   navigation from §9.3.
9. Warn if `MODEL` is an alias (`opus`, `sonnet`, `haiku`, `fable`, `best`, `opusplan`) rather
   than a pinned ID.
10. Warn if `PERMISSION_MODE` is `auto` while `MODEL` is outside the set that supports it (§9.4).

---

## 9. Constraints and gotchas — read before implementing

### 9.1 Use launchd, not cron
A cron job whose fire time passes while the Mac is asleep is simply skipped. launchd runs a
missed `StartCalendarInterval` job when the machine wakes. For a nightly job on a laptop this is
the difference between working and appearing to work. (cron also still exists on macOS and would
additionally need Full Disk Access granted to `/usr/sbin/cron`.)

### 9.2 `ANTHROPIC_API_KEY` silently hijacks billing
If an API key is present in the environment, it takes precedence over subscription credentials
once approved. The job would still run — it would just bill Console credits instead of the Max
plan, quietly. `run.sh` must `unset ANTHROPIC_API_KEY` unconditionally, and `doctor` must check
for it in the login environment.

### 9.3 Keychain vs. token, and Full Disk Access
Interactive `/login` credentials live in the Keychain, which a launchd background job generally
cannot unlock. That is why we use `CLAUDE_CODE_OAUTH_TOKEN` from a file. Separately, TCC will
block a scheduled process from reading `~/Documents`, `~/Desktop`, `~/Downloads`, and iCloud
Drive unless the executing binary has Full Disk Access. Because the plist invokes `/bin/bash`,
grant it to `/bin/bash`:

> System Settings → Privacy & Security → Full Disk Access → **+** → `Cmd+Shift+G` → `/bin/bash`

Include this in `cjob new`'s post-creation output, not just in `doctor`.

### 9.4 Auto mode has real preconditions and a real failure mode
Auto mode routes non-trivial actions through a separate classifier model before they run.
Consequences that matter here:

- **Model gating.** On the Anthropic API, auto mode requires Opus 4.6 or later, Sonnet 4.6 or
  later, or Fable 5. Older models — including Sonnet 4.5, Opus 4.5, and any Haiku — do not
  support it. If you pin an unsupported model and set `auto`, the job fails at startup, not
  gracefully at runtime.
- **Headless runs abort on repeated blocks.** Interactively, the classifier blocking an action
  three times consecutively (or twenty times total) makes Claude Code fall back to prompting.
  Under `-p` there is nobody to prompt, so repeated blocks **abort the session**. A job that
  routinely bumps against classifier boundaries will look flaky. If `doctor` or `usage` shows
  runs dying early, the fix is narrowing the prompt or adding explicit allow rules, not raising
  `--max-turns`.
- **Classifier calls cost tokens.** Each check sends part of the transcript plus the pending
  action. Reads and working-directory edits skip it, so the overhead is concentrated in shell
  commands and network calls. Budget for auto mode being meaningfully more expensive per turn
  than `dontAsk`. This is directly in tension with "predictable usage" — flag it in `usage`
  output.
- **`defaultMode: "auto"` is ignored from project settings.** Claude Code deliberately ignores
  `auto` in `.claude/settings.json` and `.claude/settings.local.json` so a repo can't grant
  itself the mode. It only works from `~/.claude/settings.json` or from the `--permission-mode`
  flag. We pass the flag, so this is fine — but do not "helpfully" write the mode into the
  repo's settings file, because it will be silently ignored and produce a confusing default-mode
  run.
- **`bypassPermissions` caveats.** It's available as an option in the config block, but it
  disables the safety checks entirely and refuses to start under `root`/`sudo`. Under `-p` no
  acceptance dialog is shown. Treat it as the escape hatch for a genuinely isolated repo, and
  have `cjob new` warn when it's selected.
- **Protected paths.** `.git`, `.claude`, `.vscode`, shell rc files and similar are never
  auto-approved outside `bypassPermissions`; in auto mode those writes route to the classifier.
  If the brain repo expects Claude to edit its own `.claude/` config, that will not work under
  `auto`.

### 9.5 No `flock` on macOS
Implement the lock with `mkdir`, which is atomic:

```bash
LOCK_DIR="$JOB_DIR/state/run.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  # check the recorded PID; if the process is gone, the lock is stale — reclaim it
fi
echo $$ > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT
```

Stale-lock reclamation is mandatory. Without it, one hard reboot mid-run disables the job
permanently and silently.

### 9.6 Pin the model
Aliases like `sonnet` resolve to a built-in default per provider, and that default moves when
Anthropic ships a new release. For a job whose whole point is predictable cost and behaviour,
pin a full ID. Valid IDs at time of writing include `claude-opus-5`, `claude-sonnet-5`,
`claude-fable-5`, `claude-opus-4-8`, `claude-sonnet-4-6`, and `claude-haiku-4-5-20251001`.
Default new jobs to `claude-sonnet-5`.

### 9.7 Test with a stripped environment
`cjob run` and any manual testing must not inherit the interactive shell's PATH and environment,
or the test proves nothing. Invoke as `env -i /bin/bash <path>/run.sh` — if it works with an
empty environment it will work under launchd.

### 9.8 Do not use `--bare`
`--bare` skips hooks, skills, plugins, MCP, and CLAUDE.md discovery — which defeats the entire
point of running inside a brain repo — and it does not read `CLAUDE_CODE_OAUTH_TOKEN`, so it
won't authenticate here anyway.

### 9.9 `total_cost_usd` on a subscription
The cost field in the result JSON is an equivalent-API-cost estimate. On a Max plan you're
consuming plan quota (a rolling 5-hour window plus a weekly cap), not being invoiced that
amount. Label it accordingly in `usage` output — something like "est. API-equivalent" — so it
isn't mistaken for a bill. Also worth surfacing: a scheduled job competes with interactive usage
for the same quota, which is a further argument for a 3am fire time.

---

## 10. Build order

Work in this sequence and verify each stage before moving on:

1. `~/claude-jobs/` skeleton and the three templates.
2. `run.sh` for a single hand-made test job whose prompt is trivial ("write the current git
   branch to `/tmp/cjob-test.txt` and stop"). Verify with `env -i`.
3. Log paths, header/footer, result parsing, `state/last-run.json`.
4. Locking, timeout watchdog, retention pruning.
5. launchd plist generation, `enable`/`disable`/`schedule`. Verify with a fire time two minutes
   out, then confirm the wake-from-sleep behaviour once.
6. `cjob` REPL: `ls`, `show`, `logs`, `log`, `tail`, `run` first; `new`, `edit`, `rm`,
   `schedule`, `usage`, `doctor` second.
7. `doctor`, end to end.

## 11. Acceptance criteria

- `cjob new` produces a job that runs correctly under `env -i` with no manual edits beyond the
  prompt.
- A job scheduled for a time while the lid is closed executes on wake.
- Two concurrent invocations result in exactly one run and one "skipped, already running" log
  line.
- Logs land at `~/claude-jobs/<job>/logs/<YYYY-MM-DD>/<HH-MM-SS>.log` and every log opens with a
  header identifying model, mode, repo, and commit.
- Killing `claude` mid-run still produces a complete log footer and releases the lock.
- `doctor` fails loudly and specifically when the token is removed, when `ANTHROPIC_API_KEY` is
  exported, and when a `REPO_DIR` is renamed.
- Every knob in §4's config block demonstrably changes behaviour when edited.

