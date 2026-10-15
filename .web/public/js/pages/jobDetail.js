import { api } from "../lib/fetchJson.js";
import {
  escapeHtml, fmtCost, fmtDuration, fmtWhen, exitPill, modal, toast, nav,
} from "../lib/common.js";

const CONFIG_LABELS = {
  REPO_DIR: "Repo dir", MODEL: "Model", PERMISSION_MODE: "Permission mode",
  MAX_TURNS: "Max turns", MAX_BUDGET_USD: "Max budget (USD)", ALLOWED_TOOLS: "Allowed tools",
  DISALLOWED_TOOLS: "Disallowed tools", TIMEOUT_SECONDS: "Timeout (s)",
  LOG_RETENTION_DAYS: "Log retention (days)", PATH_EXTRA: "Extra PATH",
  TOKEN_FILE: "Token file", CLAUDE_BIN: "Claude binary", EXTRA_DIRS: "Extra dirs",
};

const CONFIG_LABELS_JIVA = {
  REPO_DIR: "Workspace dir", JIVA_MAX_ITERATIONS: "Max iterations",
  JIVA_CONFIG_FILE: "Jiva config file", JIVA_DIRECTIVE_FILE: "Directive file",
  JIVA_INPUT_PRICE_PER_1M: "Input $/1M tokens", JIVA_OUTPUT_PRICE_PER_1M: "Output $/1M tokens",
  TIMEOUT_SECONDS: "Timeout (s)", LOG_RETENTION_DAYS: "Log retention (days)",
  PATH_EXTRA: "Extra PATH", JIVA_BIN: "Jiva binary",
};

export async function render(main, { name, tab }) {
  main.innerHTML = `<div class="empty">Loading…</div>`;
  let data;
  try {
    data = await api(`/api/jobs/${encodeURIComponent(name)}`);
  } catch (err) {
    main.innerHTML = `<div class="banner error">${escapeHtml(err.message)}</div>`;
    return;
  }

  const activeTab = tab || "overview";
  main.innerHTML = shell(data, activeTab);
  wireHeader(main, data);
  wireTabs(main, data);

  if (activeTab === "overview") renderOverview(main, data);
  else if (activeTab === "prompt") renderEditor(main, data, "prompt");
  else if (activeTab === "script") renderEditor(main, data, "script");

  let stopped = false;
  const timer = setInterval(async () => {
    if (stopped || activeTab !== "overview") return;
    try {
      const fresh = await api(`/api/jobs/${encodeURIComponent(name)}`);
      const badge = main.querySelector("#running-badge-slot");
      if (badge) badge.outerHTML = runningBadge(fresh);
    } catch (e) {
      /* ignore transient poll failures */
    }
  }, 6000);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

function runningBadge(data) {
  return data.runningPid
    ? `<span id="running-badge-slot" class="pill accent">● running (pid ${data.runningPid})</span>`
    : `<span id="running-badge-slot"></span>`;
}

function shell(data, activeTab) {
  const name = escapeHtml(data.name);
  const runner = data.meta.runner || "claude";
  const runnerPill = runner === "jiva"
    ? '<span class="pill accent">jiva</span>'
    : '<span class="pill gray">claude</span>';
  return `
    <div class="page-header">
      <div>
        <h1>${name} ${runnerPill} ${runningBadge(data)}</h1>
        <div class="subtitle mono">${escapeHtml(data.dir)}</div>
      </div>
      <div class="actions" id="header-actions">
        <button id="btn-run" class="primary">Run now</button>
        <button id="btn-tail" class="ghost">Tail</button>
        <button id="btn-toggle-enabled">${data.meta.enabled ? "Disable" : "Enable"}</button>
        <button id="btn-delete" class="ghost" style="color:var(--red)">Delete</button>
      </div>
    </div>
    ${data.warnings.length ? `<div class="banner warn">${data.warnings.map(escapeHtml).join("<br>")}</div>` : ""}
    <div class="tabs">
      <button data-tab="overview" class="${activeTab === "overview" ? "active" : ""}">Overview</button>
      <button data-tab="prompt" class="${activeTab === "prompt" ? "active" : ""}">prompt.md</button>
      <button data-tab="script" class="${activeTab === "script" ? "active" : ""}">run.sh</button>
    </div>
    <div id="tab-content"></div>
  `;
}

function wireTabs(main, data) {
  main.querySelectorAll(".tabs button").forEach((btn) => {
    btn.addEventListener("click", () => nav(`#/jobs/${encodeURIComponent(data.name)}?tab=${btn.dataset.tab}`));
  });
}

function wireHeader(main, data) {
  const name = data.name;

  main.querySelector("#btn-run").addEventListener("click", async () => {
    const btn = main.querySelector("#btn-run");
    btn.disabled = true;
    btn.textContent = "Starting…";
    try {
      await api(`/api/jobs/${encodeURIComponent(name)}/run`, { method: "POST" });
      nav(`#/jobs/${encodeURIComponent(name)}/tail`);
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
      btn.textContent = "Run now";
    }
  });

  main.querySelector("#btn-tail").addEventListener("click", () => nav(`#/jobs/${encodeURIComponent(name)}/tail`));

  main.querySelector("#btn-toggle-enabled").addEventListener("click", async () => {
    const btn = main.querySelector("#btn-toggle-enabled");
    const willEnable = !data.meta.enabled;
    if (willEnable && !(data.schedule.entries || []).length) {
      toast("Set a schedule before enabling this job.", "error");
      return;
    }
    btn.disabled = true;
    try {
      await api(`/api/jobs/${encodeURIComponent(name)}/${willEnable ? "enable" : "disable"}`, { method: "POST" });
      toast(willEnable ? "Job enabled." : "Job disabled.");
      render(main.closest("#main") || main, { name, tab: "overview" });
    } catch (err) {
      toast(err.message, "error");
      btn.disabled = false;
    }
  });

  main.querySelector("#btn-delete").addEventListener("click", async () => {
    const ok = await modal({
      title: `Delete ${name}`,
      danger: true,
      confirmLabel: "Delete",
      bodyHtml: `
        <p>This disables the launchd agent and deletes the job directory. Type <strong>${escapeHtml(name)}</strong> to confirm.</p>
        <div class="field"><input type="text" id="rm-confirm-input" placeholder="${escapeHtml(name)}" /></div>
        <label style="display:flex; align-items:center; gap:6px; font-weight:400;"><input type="checkbox" id="rm-keep-logs" style="width:auto;" checked /> Keep logs (archived)</label>
      `,
      onMount: {
        getValue: (backdrop) => ({
          typedName: backdrop.querySelector("#rm-confirm-input").value,
          keepLogs: backdrop.querySelector("#rm-keep-logs").checked,
        }),
      },
    });
    if (!ok) return;
    try {
      await api(`/api/jobs/${encodeURIComponent(name)}`, { method: "DELETE", body: ok });
      toast(`Deleted ${name}.`);
      nav("#/");
    } catch (err) {
      toast(err.message, "error");
    }
  });
}

function renderOverview(main, data) {
  const tabContent = main.querySelector("#tab-content");
  const cfg = data.config;
  const labels = data.meta.runner === "jiva" ? CONFIG_LABELS_JIVA : CONFIG_LABELS;
  const configRows = Object.keys(labels)
    .map((key) => {
      let val = cfg[key];
      if (Array.isArray(val)) val = val.length ? val.join(" ") : '<span style="color:var(--text-faint)">none</span>';
      else if (val === "" || val === undefined) val = '<span style="color:var(--text-faint)">empty</span>';
      else val = escapeHtml(val);
      return `<dt>${labels[key]}</dt><dd class="mono">${val}</dd>`;
    })
    .join("");

  const repo = data.repo;
  const repoLine = !repo.exists
    ? `<span class="pill red">missing</span> ${escapeHtml(repo.path)}`
    : repo.git
    ? `${escapeHtml(repo.path)} — <span class="mono">${escapeHtml(repo.git.branch)} @ ${escapeHtml(repo.git.sha)}</span>${repo.git.dirty ? ' <span class="pill yellow">dirty</span>' : ""}`
    : `${escapeHtml(repo.path)} — <span class="pill yellow">not a git repo</span>`;

  const runs = data.recentRuns;
  const runsRows = runs.length
    ? runs
        .map(
          (r) => `
        <tr class="clickable" data-date="${r.date}" data-time="${r.time}">
          <td>${fmtWhen(r)}</td>
          <td>${exitPill(r)}</td>
          <td>${fmtDuration(r.duration_seconds)}</td>
          <td>${r.num_turns ?? "—"}</td>
          <td>${fmtCost(r.total_cost_usd)}</td>
        </tr>`
        )
        .join("")
    : `<tr><td colspan="5" class="empty">No runs yet.</td></tr>`;

  tabContent.innerHTML = `
    <div class="card">
      <h2>Schedule &amp; launchd</h2>
      <div class="kv">
        <dt>Schedule</dt><dd>${escapeHtml(data.schedule.describe)} <button class="small" id="btn-edit-schedule" style="margin-left:8px;">Edit</button></dd>
        <dt>launchd label</dt><dd class="mono">${escapeHtml(data.launchd.label)}</dd>
        <dt>Loaded</dt><dd>${data.launchd.loaded ? '<span class="pill green">yes</span>' : '<span class="pill gray">no</span>'}</dd>
      </div>
    </div>
    <div class="card">
      <h2>Config <span class="badge-count">from run.sh</span></h2>
      <div class="kv">${configRows}</div>
    </div>
    <div class="card">
      <h2>Repo</h2>
      <div>${repoLine}</div>
    </div>
    <div class="card">
      <h2>Prompt preview</h2>
      <pre class="log-view" style="max-height:160px;">${escapeHtml((data.prompt || "").split("\n").slice(0, 12).join("\n"))}</pre>
    </div>
    <div class="card" style="padding:0;">
      <h2 style="padding:18px 20px 0;">Last 5 runs</h2>
      <table class="data">
        <thead><tr><th>When</th><th>Exit</th><th>Duration</th><th>Turns</th><th>Cost</th></tr></thead>
        <tbody>${runsRows}</tbody>
      </table>
    </div>
  `;

  tabContent.querySelectorAll("tr[data-date]").forEach((tr) => {
    tr.addEventListener("click", () => {
      nav(`#/jobs/${encodeURIComponent(data.name)}/logs?date=${tr.dataset.date}&time=${tr.dataset.time}`);
    });
  });

  tabContent.querySelector("#btn-edit-schedule").addEventListener("click", async () => {
    await editSchedule(main, data);
  });
}

async function editSchedule(main, data) {
  const current = data.schedule.spec || "";
  const bodyHtml = `
    <div class="field">
      <label>Frequency</label>
      <select id="sched-kind">
        <option value="hourly">Hourly</option>
        <option value="daily">Daily</option>
        <option value="weekdays">Weekdays</option>
        <option value="weekends">Weekends</option>
        <option value="custom">Custom days</option>
      </select>
    </div>
    <div class="field" id="sched-days-wrap" style="display:none;">
      <label>Days</label>
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        ${["sun", "mon", "tue", "wed", "thu", "fri", "sat"]
          .map((d) => `<label style="display:flex;gap:4px;align-items:center;font-weight:400;width:auto;"><input type="checkbox" value="${d}" style="width:auto;"/>${d}</label>`)
          .join("")}
      </div>
    </div>
    <div class="field" id="sched-minute-wrap" style="display:none;">
      <label>Minute past the hour</label>
      <input type="number" id="sched-minute" min="0" max="59" value="0" />
    </div>
    <div class="field" id="sched-times-wrap">
      <label>Times (HH:MM, comma-separated)</label>
      <input type="text" id="sched-times" placeholder="03:00,15:00" />
    </div>
    <div class="field hint">Current: <span class="mono">${escapeHtml(current || "unscheduled")}</span></div>
    <div class="field error" id="sched-error" style="display:none;"></div>
  `;

  const result = await modal({
    title: `Schedule — ${data.name}`,
    confirmLabel: "Save",
    bodyHtml,
    onMount: {
      init: (backdrop) => {
        const kindSel = backdrop.querySelector("#sched-kind");
        const daysWrap = backdrop.querySelector("#sched-days-wrap");
        const minuteWrap = backdrop.querySelector("#sched-minute-wrap");
        const timesWrap = backdrop.querySelector("#sched-times-wrap");
        const update = () => {
          const k = kindSel.value;
          daysWrap.style.display = k === "custom" ? "block" : "none";
          minuteWrap.style.display = k === "hourly" ? "block" : "none";
          timesWrap.style.display = k === "hourly" ? "none" : "block";
        };
        kindSel.addEventListener("change", update);
        update();
      },
      getValue: (backdrop) => {
        const kind = backdrop.querySelector("#sched-kind").value;
        if (kind === "hourly") {
          const minute = backdrop.querySelector("#sched-minute").value || "0";
          return `hourly :${String(minute).padStart(2, "0")}`;
        }
        const times = backdrop.querySelector("#sched-times").value.trim() || "03:00";
        if (kind === "custom") {
          const days = [...backdrop.querySelectorAll("#sched-days-wrap input:checked")].map((c) => c.value);
          if (!days.length) return null;
          return `${days.join(",")} ${times}`;
        }
        return `${kind} ${times}`;
      },
    },
  });

  if (!result) return;
  try {
    await api(`/api/jobs/${encodeURIComponent(data.name)}/schedule`, { method: "PUT", body: { spec: result } });
    toast("Schedule updated.");
    render(main.closest("#main") || main, { name: data.name, tab: "overview" });
  } catch (err) {
    toast(err.message, "error");
  }
}

function renderEditor(main, data, kind) {
  const tabContent = main.querySelector("#tab-content");
  const content = kind === "prompt" ? data.prompt : data.script;
  tabContent.innerHTML = `
    <div class="card">
      <h2>${kind === "prompt" ? "prompt.md" : "run.sh"}</h2>
      ${kind === "script" ? '<div class="banner warn">job.json is regenerated from this file on every save — edit config here, not there.</div>' : ""}
      <textarea class="code" id="editor-area" spellcheck="false">${escapeHtml(content || "")}</textarea>
      <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:10px;">
        <span id="save-note" class="hint" style="color:var(--text-faint); align-self:center;"></span>
        <button class="primary" id="btn-save">Save</button>
      </div>
    </div>
  `;

  tabContent.querySelector("#btn-save").addEventListener("click", async () => {
    const btn = tabContent.querySelector("#btn-save");
    const note = tabContent.querySelector("#save-note");
    const value = tabContent.querySelector("#editor-area").value;
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      const path = kind === "prompt" ? "prompt" : "script";
      const res = await api(`/api/jobs/${encodeURIComponent(data.name)}/${path}`, { method: "PUT", body: { content: value } });
      note.textContent = res && res.note ? res.note : "Saved.";
      toast("Saved.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Save";
    }
  });
}
