import { api } from "../lib/fetchJson.js";
import { escapeHtml, nav, toast } from "../lib/common.js";

export async function render(main, params) {
  main.innerHTML = `<div class="empty">Loading…</div>`;
  const defaultsRes = await api("/api/jobs/_defaults").catch(() => ({
    defaults: {}, permissionModes: [], defaultModel: "", runners: ["claude", "jiva"],
    defaultJivaConfigFile: "", defaultJivaPathExtra: "",
  }));
  const d = defaultsRes.defaults || {};
  const lastRunner = d.last_runner === "jiva" ? "jiva" : "claude";

  main.innerHTML = `
    <div class="page-header">
      <div><h1>New job</h1><div class="subtitle">Creation and activation are separate — you'll test it before enabling.</div></div>
    </div>
    <div id="banner"></div>
    <form id="new-job-form" class="card">
      <div class="row">
        <div class="field">
          <label>Job name</label>
          <input name="name" placeholder="nightly-review" pattern="[a-z0-9](?:[a-z0-9\\-]{0,38}[a-z0-9])?" required />
          <div class="hint">lowercase, digits, hyphens — becomes a launchd label and a path</div>
        </div>
        <div class="field">
          <label>Runner</label>
          <select name="runner" id="runner-select">
            <option value="claude" ${lastRunner === "claude" ? "selected" : ""}>Claude Code — thinking / strategy</option>
            <option value="jiva" ${lastRunner === "jiva" ? "selected" : ""}>Jiva — low-level action execution</option>
          </select>
        </div>
      </div>

      <div data-runner-group="claude">
        <div class="field">
          <label>Repo dir</label>
          <input name="repoDir" placeholder="/Users/abi/code/my-repo" value="${escapeHtml(d.repo_dir || "")}" />
        </div>
        <div class="row">
          <div class="field">
            <label>Model (pinned full ID)</label>
            <input name="model" value="${escapeHtml(d.model || defaultsRes.defaultModel || "claude-sonnet-5")}" />
            <div class="hint">no aliases (opus/sonnet/haiku/...) — they float across releases</div>
          </div>
          <div class="field">
            <label>Permission mode</label>
            <select name="permissionMode">
              ${(defaultsRes.permissionModes || ["auto", "dontAsk", "acceptEdits", "bypassPermissions"])
                .map((m) => `<option value="${m}" ${m === (d.permission_mode || "dontAsk") ? "selected" : ""}>${m}</option>`)
                .join("")}
            </select>
          </div>
        </div>
        <div class="row">
          <div class="field"><label>Max turns</label><input name="maxTurns" type="number" min="1" value="${d.max_turns || 25}" /></div>
          <div class="field"><label>Max budget (USD, est.)</label><input name="maxBudgetUsd" value="${d.max_budget_usd ?? 3}" /></div>
        </div>
        <div class="field hint">
          Allowed/disallowed tools and extra directories default empty — edit run.sh after creation to set them.
        </div>
      </div>

      <div data-runner-group="jiva" style="display:none;">
        <div class="banner warn">
          Jiva's --code mode has no workspace-boundary enforcement — its file-write and shell tools can reach
          anywhere this user can, not just the workspace dir below. Only use it where that's acceptable.
        </div>
        <div class="field">
          <label>Workspace dir</label>
          <input name="repoDirJiva" placeholder="/Users/abi/code/my-repo" value="${escapeHtml(d.jiva_repo_dir || d.repo_dir || "")}" />
        </div>
        <div class="row">
          <div class="field"><label>Max iterations</label><input name="jivaMaxIterations" type="number" min="1" value="${d.jiva_max_iterations || 30}" /></div>
          <div class="field">
            <label>Jiva config file</label>
            <input name="jivaConfigFile" value="${escapeHtml(d.jiva_config_file || defaultsRes.defaultJivaConfigFile || "")}" />
          </div>
        </div>
        <div class="field">
          <label>Directive file (blank = auto-discover jiva-directive.md / CLAUDE.md / AGENTS.md)</label>
          <input name="jivaDirectiveFile" value="${escapeHtml(d.jiva_directive_file || "")}" />
        </div>
        <div class="row">
          <div class="field">
            <label>Input $/1M tokens (blank = no cost tracked)</label>
            <input name="jivaInputPricePer1M" value="${escapeHtml(d.jiva_input_price_per_1m ?? "")}" />
          </div>
          <div class="field">
            <label>Output $/1M tokens (blank = no cost tracked)</label>
            <input name="jivaOutputPricePer1M" value="${escapeHtml(d.jiva_output_price_per_1m ?? "")}" />
          </div>
        </div>
        <div class="field hint">Jiva has no cost API (provider-agnostic) — cost is only computed if you set both prices.</div>
      </div>

      <div class="field">
        <label>Schedule</label>
        <input name="schedule" value="${escapeHtml(d.schedule || "daily 03:00")}" required />
        <div class="hint">hourly | hourly :07 | daily 03:00 | daily 03:00,15:00 | weekdays 09:30 | weekends 10:00 | mon,thu 07:00</div>
      </div>
      <div class="row">
        <div class="field"><label>Timeout (s, 0 disables)</label><input name="timeoutSeconds" type="number" min="0" value="${d.timeout_seconds ?? 1800}" required /></div>
        <div class="field"><label>Log retention (days, 0 disables)</label><input name="logRetentionDays" type="number" min="0" value="${d.log_retention_days ?? 30}" required /></div>
      </div>
      <div class="field" id="path-extra-field">
        <label>Extra PATH entries (colon-separated)</label>
        <input name="pathExtra" value="${escapeHtml(d.path_extra || "")}" />
        <div class="hint" id="path-extra-hint"></div>
      </div>

      <div style="display:flex; justify-content:flex-end; gap:8px;">
        <button type="submit" class="primary" id="submit-btn">Create job</button>
      </div>
    </form>
  `;

  const form = main.querySelector("#new-job-form");
  const banner = main.querySelector("#banner");
  const runnerSelect = main.querySelector("#runner-select");
  const pathExtraInput = form.querySelector('input[name="pathExtra"]');
  const pathExtraHint = main.querySelector("#path-extra-hint");

  function updateRunnerGroups() {
    const runner = runnerSelect.value;
    main.querySelectorAll("[data-runner-group]").forEach((el) => {
      el.style.display = el.dataset.runnerGroup === runner ? "block" : "none";
    });
    if (runner === "jiva") {
      pathExtraHint.textContent = "must include the directory jiva/node/npx live in";
      if (!pathExtraInput.value) pathExtraInput.value = defaultsRes.defaultJivaPathExtra || "";
    } else {
      pathExtraHint.textContent = "";
    }
  }
  runnerSelect.addEventListener("change", updateRunnerGroups);
  updateRunnerGroups();

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    banner.innerHTML = "";
    const fd = new FormData(form);
    const body = Object.fromEntries(fd.entries());
    if (body.runner === "jiva") {
      body.repoDir = body.repoDirJiva;
    }
    delete body.repoDirJiva;

    const submitBtn = main.querySelector("#submit-btn");
    submitBtn.disabled = true;
    submitBtn.textContent = "Creating…";
    try {
      const res = await api("/api/jobs", { method: "POST", body });
      if (res.warnings && res.warnings.length) {
        setTimeout(() => toast(res.warnings.join(" · "), "warn"), 300);
      }
      toast(`Created ${res.name}.`);
      nav(`#/jobs/${encodeURIComponent(res.name)}?tab=prompt`);
    } catch (err) {
      if (err.fields) {
        banner.innerHTML = `<div class="banner error">${Object.entries(err.fields)
          .map(([k, v]) => `<strong>${escapeHtml(k)}</strong>: ${escapeHtml(v)}`)
          .join("<br>")}</div>`;
      } else {
        banner.innerHTML = `<div class="banner error">${escapeHtml(err.message)}</div>`;
      }
      submitBtn.disabled = false;
      submitBtn.textContent = "Create job";
    }
  });
}
