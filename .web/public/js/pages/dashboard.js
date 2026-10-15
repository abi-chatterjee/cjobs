import { api } from "../lib/fetchJson.js";
import { escapeHtml, fmtCost, fmtWhen, exitPill, toast } from "../lib/common.js";

export async function render(main, params) {
  main.innerHTML = `
    <div class="page-header">
      <div>
        <h1>Jobs</h1>
        <div class="subtitle">Scheduled Claude Code jobs on this machine</div>
      </div>
      <div class="actions">
        <a class="btn primary" href="#/new">+ New job</a>
      </div>
    </div>
    <div id="content"><div class="empty">Loading…</div></div>
  `;
  const content = main.querySelector("#content");

  let stopped = false;
  async function load() {
    const { jobs } = await api("/api/jobs");
    if (stopped) return;
    if (!jobs.length) {
      content.innerHTML = `<div class="card"><div class="empty">No jobs yet — <a href="#/new">create one</a>.</div></div>`;
      return;
    }
    content.innerHTML = `
      <div class="card" style="padding:0; overflow-x:auto;">
        <table class="data">
          <thead><tr>
            <th>Job</th><th>On</th><th>Schedule</th><th>Runner/Model</th><th>Last run</th><th>Exit</th><th>Cost</th><th></th>
          </tr></thead>
          <tbody>
            ${jobs.map(rowHtml).join("")}
          </tbody>
        </table>
      </div>
    `;
    content.querySelectorAll("tr[data-job]").forEach((tr) => {
      tr.addEventListener("click", (e) => {
        if (e.target.closest("button")) return;
        location.hash = `#/jobs/${encodeURIComponent(tr.dataset.job)}`;
      });
    });
    content.querySelectorAll("button[data-run]").forEach((btn) => {
      btn.addEventListener("click", async (e) => {
        e.stopPropagation();
        const name = btn.dataset.run;
        btn.disabled = true;
        btn.textContent = "Starting…";
        try {
          await api(`/api/jobs/${encodeURIComponent(name)}/run`, { method: "POST" });
          location.hash = `#/jobs/${encodeURIComponent(name)}/tail`;
        } catch (err) {
          toast(err.message, "error");
          btn.disabled = false;
          btn.textContent = "Run now";
        }
      });
    });
  }

  function rowHtml(j) {
    const name = escapeHtml(j.name);
    let onPill = j.enabled
      ? j.stale ? '<span class="pill yellow">stale</span>' : '<span class="pill green">on</span>'
      : '<span class="pill gray">off</span>';
    if (j.running) onPill += ' <span class="pill accent">running</span>';
    const engine = j.runner === "jiva" ? "jiva" : j.model || "—";
    return `
      <tr data-job="${name}" class="clickable">
        <td><strong>${name}</strong></td>
        <td>${onPill}</td>
        <td>${escapeHtml(j.scheduleDescribe)}</td>
        <td class="mono">${escapeHtml(engine)}</td>
        <td>${fmtWhen(j.lastRun)}</td>
        <td>${exitPill(j.lastRun)}</td>
        <td>${fmtCost(j.lastRun ? j.lastRun.total_cost_usd : null)}</td>
        <td><button class="small" data-run="${name}" ${j.running ? "disabled" : ""}>${j.running ? "Running…" : "Run now"}</button></td>
      </tr>
    `;
  }

  await load();
  const timer = setInterval(() => load().catch(() => {}), 8000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
