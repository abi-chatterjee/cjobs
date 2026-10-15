import { api } from "../lib/fetchJson.js";
import { escapeHtml, fmtCost, fmtDuration } from "../lib/common.js";
import { renderCostBarChart } from "../lib/chart.js";

export async function render(main, params) {
  main.innerHTML = `<div class="empty">Loading…</div>`;
  const { jobs } = await api("/api/jobs").catch(() => ({ jobs: [] }));

  const days = parseInt(params.days || "7", 10) || 7;
  const jobFilter = params.job || "";

  main.innerHTML = `
    <div class="page-header">
      <div><h1>Usage</h1><div class="subtitle">Est. API-equivalent cost — see note below, not a bill</div></div>
      <div class="actions">
        <select id="job-select">
          <option value="">All jobs</option>
          ${jobs.map((j) => `<option value="${escapeHtml(j.name)}" ${j.name === jobFilter ? "selected" : ""}>${escapeHtml(j.name)}</option>`).join("")}
        </select>
        <select id="days-select">
          ${[7, 14, 30, 90].map((d) => `<option value="${d}" ${d === days ? "selected" : ""}>${d} days</option>`).join("")}
        </select>
      </div>
    </div>
    <div id="content"><div class="empty">Loading…</div></div>
  `;

  main.querySelector("#job-select").addEventListener("change", (e) => update(e.target.value, days));
  main.querySelector("#days-select").addEventListener("change", (e) => update(jobFilter, parseInt(e.target.value, 10)));

  async function update(job, d) {
    location.hash = `#/usage?days=${d}${job ? `&job=${encodeURIComponent(job)}` : ""}`;
    const content = main.querySelector("#content");
    content.innerHTML = `<div class="empty">Loading…</div>`;
    const qs = new URLSearchParams({ days: String(d) });
    if (job) qs.set("job", job);
    let data;
    try {
      data = await api(`/api/usage?${qs}`);
    } catch (err) {
      content.innerHTML = `<div class="banner error">${escapeHtml(err.message)}</div>`;
      return;
    }

    content.innerHTML = `
      <div class="card">
        <h2>Daily cost</h2>
        <div id="chart-mount"></div>
        <details style="margin-top:10px;"><summary class="hint" style="cursor:pointer;color:var(--accent);">View as table</summary>
          <table class="data" style="margin-top:8px;">
            <thead><tr><th>Date</th><th>Cost</th></tr></thead>
            <tbody>${data.daily.map((r) => `<tr><td>${r.date}</td><td>${fmtCost(r.cost)}</td></tr>`).join("")}</tbody>
          </table>
        </details>
      </div>
      <div class="card" style="padding:0;">
        <h2 style="padding:18px 20px 0;">By job — since ${escapeHtml(data.since)}</h2>
        <table class="data">
          <thead><tr><th>Job</th><th>Runs</th><th>Errors</th><th>Turns</th><th>Wall</th><th>Cost</th><th>Cost/run</th></tr></thead>
          <tbody>
            ${data.rows
              .map(
                (r) => `
              <tr>
                <td><a href="#/jobs/${encodeURIComponent(r.job)}">${escapeHtml(r.job)}</a></td>
                <td>${r.runs}</td>
                <td>${r.errors ? `<span class="pill red">${r.errors}</span>` : '<span class="pill green">0</span>'}</td>
                <td>${r.turns}</td>
                <td>${fmtDuration(r.wallSeconds)}</td>
                <td>${fmtCost(r.cost)}</td>
                <td>${r.costPerRun !== null ? fmtCost(r.costPerRun) : "—"}</td>
              </tr>`
              )
              .join("")}
          </tbody>
          <tfoot>
            <tr style="font-weight:700;">
              <td>Total</td>
              <td>${data.totals.runs}</td>
              <td>${data.totals.errors}</td>
              <td>${data.totals.turns}</td>
              <td>${fmtDuration(data.totals.wallSeconds)}</td>
              <td>${fmtCost(data.totals.cost)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
      <div class="banner info">${escapeHtml(data.costNote)}</div>
      ${
        data.autoModeJobs.length
          ? `<div class="banner warn">Auto-mode jobs (higher cost/turn — classifier calls): ${data.autoModeJobs.map(escapeHtml).join(", ")}</div>`
          : ""
      }
    `;
    renderCostBarChart(content.querySelector("#chart-mount"), data.daily);
  }

  await update(jobFilter, days);
}
