# claude-jobs

Runs Claude Code headlessly on a schedule against a specific repo, with per-job
directories, structured logs, and a REPL CLI (`cjob`) to administer it.

Built to `buildspec.md`. Read that for the reasoning; this file is the operator's view.

---

## Layout

```
~/claude-jobs/
├── .templates/            run.sh.tmpl, prompt.md.tmpl, launchd.plist.tmpl
├── .bin/cjob              the CLI (symlinked to ~/.local/bin/cjob)
├── .state/cjob.json       remembered `new` wizard defaults
├── .state/cjob.history    REPL history
├── .web/                  cjob-web control panel (Node/Express)
└── .agents/               every job lives here — git-ignored, never published
    ├── .archived-logs/    logs kept by `cjob rm --keep-logs`
    └── <job-name>/        a job = a dir with no leading dot and a job.json
        ├── run.sh             executable; what launchd actually runs
        ├── prompt.md          the instruction Claude receives
        ├── job.json           metadata the CLI reads (schedule, enabled, mirrored config)
        ├── state/
        │   ├── last-run.json  exit code, duration, cost, turns, session_id
        │   └── run.lock/      lock DIRECTORY (mkdir is atomic; macOS has no flock)
        └── logs/
            ├── launchd.err    pre-log failures — check here first when a run vanishes
            ├── launchd.out
            └── 2026-07-26/
                ├── 11-58-36.log          human-readable, the primary artifact
                └── 11-58-36.result.json  raw `--output-format json`
```

This repo is public. Job names, prompts, logs and target-repo paths identify real
projects, so they are kept under `.agents/`, which `.gitignore` excludes wholesale —
no job name ever appears in a tracked file or in `.gitignore` itself. Don't put a job
dir anywhere else, and don't name jobs in docs, templates or code comments.

**`run.sh` is the source of truth.** Every knob lives in one block at the top of it.
`job.json` is metadata: `cjob` re-derives it by parsing that block, and it never writes
run.sh values back the other way. `job.json` alone owns `enabled` and `schedule` — but **`enabled` there is only a
mirror**. launchd is the sole authority on whether a job actually fires, and an editor
cannot talk to launchd: hand-setting `"enabled": true` in `job.json` schedules nothing.
Use `cjob enable` / `disable` / `schedule`. `cjob ls` shows `stale` and `cjob doctor`
FAILs when the two disagree, and `cjob edit <job> config` now warns on exit.

Job names must match `^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$` — the name becomes a launchd
label and a filesystem path.

---

## Quickstart

```bash
cjob                       # REPL (tab-completes job names)
cjob doctor                # health check — run this first
cjob new                   # wizard; scaffolds a job but does NOT enable it
cjob run  <job>            # test it now, in the foreground, with a stripped env
cjob enable <job>          # activate the schedule
cjob logs <job>            # what ran today
cjob log  <job>            # print the most recent log
cjob tail <job>            # follow a run live
cjob usage --days 7        # cost/turn dashboard
```

Creation and activation are deliberately separate. Nothing runs on a schedule until
you `enable` it.

Schedule specs: `hourly` · `hourly :07` · `daily 03:00` · `daily 03:00,15:00` ·
`weekdays 09:30` · `weekends 10:00` · `mon,thu 07:00`

`cjob <command>` also works one-shot and exits non-zero on failure, so it is scriptable.

---

## The config block

Open `<job>/run.sh` and edit anything above the `END CONFIG` line.

| Knob | Notes |
|---|---|
| `REPO_DIR` | Claude `cd`s here, which is how it picks up `CLAUDE.md` and `.claude/skills/`. Never inject brain files via the prompt. |
| `EXTRA_DIRS` | Becomes `--add-dir`. Needed for any path outside `REPO_DIR`. |
| `MODEL` | **Pin a full ID.** Aliases (`sonnet`, `opus`, …) float across releases and silently change behaviour and cost. |
| `PERMISSION_MODE` | `auto` \| `dontAsk` \| `acceptEdits` \| `bypassPermissions` — see the auto-mode caveats below. |
| `MAX_TURNS` | See the caveat below: **not enforced by claude 2.1.220.** |
| `MAX_BUDGET_USD` | `--max-budget-usd`. This is a real ceiling. |
| `ALLOWED_TOOLS` / `DISALLOWED_TOOLS` | Allow/deny rules layered on the permission mode. |
| `TIMEOUT_SECONDS` | Wall-clock kill switch, enforced by a watchdog (macOS has no `timeout(1)`). `0` disables. |
| `LOG_RETENTION_DAYS` | Prunes log date-directories by name. `0` disables. |
| `PATH_EXTRA` | Appended to the hermetic PATH. **A scheduled run inherits none of your shell's PATH** — if the job needs `gh`, `node`/`npx`, or anything outside `/usr/bin:/bin`, it must be listed here. |
| `TOKEN_FILE` | `CLAUDE_CODE_OAUTH_TOKEN` source, mode 600. |
| `CLAUDE_BIN` | Pointing this at a stub script is the cheapest way to test run.sh changes. |

Every knob is read at invocation time, so editing run.sh takes effect on the next run
with no regeneration step.

---

## Reading a log

Each log opens with a header (job, ISO start time, model, mode, ceilings, repo path,
git branch + short SHA + dirty flag, resolved `claude --version`, the exact PATH) and
closes with a machine-greppable footer:

```
cjob.exit_code=0
cjob.duration_seconds=5
cjob.killed_by_watchdog=no
cjob.termination=exited on its own
cjob.is_error=false
cjob.num_turns=1
cjob.total_cost_usd=0.0200766
cjob.session_id=8dcd02bc-…
```

`cjob logs` / `usage` read that footer. Three terminations are distinguished, because
they are very different failures: `exited on its own`, `KILLED BY WATCHDOG`, and
`terminated by signal N`. A run whose log has a header but no footer shows as
`no footer` — it died before it could finish writing.

`claude` can exit **0 while `is_error` is true**, so never judge a run by exit code
alone; the footer's `is_error` is what matters.

---

## Gotchas that will bite

**Use launchd, not cron.** A cron fire time that passes while the Mac is asleep is
skipped outright. launchd runs a missed `StartCalendarInterval` on wake. (Verified here:
a job scheduled two minutes out fired on time and `launchctl print` showed `runs = 2`.)

**`ANTHROPIC_API_KEY` silently hijacks billing.** If present, it takes precedence over
the subscription credential — the job still works, it just quietly bills Console credits
instead of the Max plan. `run.sh` unsets it unconditionally; `doctor` checks the
launchctl environment, this shell, and `~/.zshrc` / `.zprofile` / `.zshenv` /
`.bash_profile` / `.profile`.

**Full Disk Access must be granted to `/bin/bash`.** The plist invokes `/bin/bash`, so
that is the binary TCC judges. Without it a scheduled run cannot read `~/Documents`,
`~/Desktop`, `~/Downloads` or iCloud Drive:
System Settings → Privacy & Security → Full Disk Access → **+** → `Cmd+Shift+G` → `/bin/bash`

**Interactive `/login` credentials do not work under launchd** — they live in the
Keychain, which a background job generally cannot unlock. Hence the token file.

**Test with `env -i`.** `cjob run` already does this. Inheriting your shell's PATH and
environment makes a passing test prove nothing.

**`total_cost_usd` is not a bill.** It is an equivalent-API-cost estimate. On a Max plan
you are spending plan quota (a rolling 5-hour window plus a weekly cap), and a scheduled
job competes with your interactive usage for the same quota — an argument for 3am.

**Auto mode has teeth.** It needs Opus 4.6+, Sonnet 4.6+ or Fable 5 (`cjob new` now
refuses to scaffold an unsupported pairing, because it fails at *startup*, not at
runtime). Under `-p` there is nobody to fall back to prompting, so repeated classifier
blocks **abort the session** — if runs die early, narrow the prompt or add explicit allow
rules rather than raising turn limits. Classifier calls also cost tokens on every shell
command and network call. `defaultMode: "auto"` in a repo's `.claude/settings.json` is
deliberately ignored; don't write it there.

**Never use `--bare`** — it skips hooks, skills, plugins, MCP and CLAUDE.md discovery,
which defeats running inside a brain repo, and it doesn't read
`CLAUDE_CODE_OAUTH_TOKEN` anyway.

---

## Two findings specific to this install

**1. `--max-turns` is not enforced by claude 2.1.220.** It is accepted without error but
is absent from `claude --help`, so `MAX_TURNS` cannot be relied on as a ceiling.
`MAX_BUDGET_USD` and `TIMEOUT_SECONDS` are the limits that actually bind.
`run.sh` still passes the flag (harmless, and forward-compatible), and `doctor` re-checks
`--help` on every run so the warning disappears by itself once a build supports it.

**2. `~/.secrets/claude_oauth_token` contains an internal line break** (111 bytes over 2
lines). `run.sh` strips all whitespace, so runs are unaffected — but any tool that only
trims the ends will send a malformed `Authorization` header. If you regenerate it:

```bash
claude setup-token | tr -d '[:space:]' > ~/.secrets/claude_oauth_token
chmod 600 ~/.secrets/claude_oauth_token
```
