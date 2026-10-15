import { api } from "../lib/fetchJson.js";
import { escapeHtml, fmtCost, fmtDuration, exitPill, nav } from "../lib/common.js";

export async function render(main, { name, date, time }) {
  main.innerHTML = `<div class="empty">Loading…</div>`;

  if (date && time) {
    return renderSingleLog(main, name, date, time);
  }
  return renderList(main, name, date);
}

async function renderList(main, name, date) {
  let data;
  try {
    const qs = date ? `?date=${encodeURIComponent(date)}` : "";
    data = await api(`/api/jobs/${encodeURIComponent(name)}/logs${qs}`);
  } catch (err) {
    main.innerHTML = `<div class="banner error">${escapeHtml(err.message)}</div>`;
    return;
  }
  const { dates } = await api(`/api/jobs/${encodeURIComponent(name)}/logs/dates`).catch(() => ({ dates: [] }));

  main.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${escapeHtml(name)} — logs</h1>
        <div class="subtitle"><a href="#/jobs/${encodeURIComponent(name)}">&larr; back to job</a></div>
      </div>
      <div class="actions">
        <select id="date-select">
          ${dates
            .slice()
            .reverse()
            .map((d) => `<option value="${d}" ${d === data.date ? "selected" : ""}>${d}</option>`)
            .join("")}
        </select>
        <a class="btn" href="#/jobs/${encodeURIComponent(name)}/tail">Tail latest</a>
      </div>
    </div>
    <div class="card" style="padding:0;">
      <table class="data">
        <thead><tr><th>Time</th><th>Exit</th><th>Duration</th><th>Turns</th><th>Cost</th></tr></thead>
        <tbody>
          ${
            data.runs.length
              ? data.runs
                  .map(
                    (r) => `
              <tr class="clickable" data-time="${r.time}">
                <td class="mono">${r.time}</td>
                <td>${exitPill(r)}</td>
                <td>${fmtDuration(r.duration_seconds)}</td>
                <td>${r.num_turns ?? "—"}</td>
                <td>${fmtCost(r.total_cost_usd)}</td>
              </tr>`
                  )
                  .join("")
              : `<tr><td colspan="5" class="empty">No runs on this date.</td></tr>`
          }
        </tbody>
      </table>
    </div>
  `;

  main.querySelector("#date-select").addEventListener("change", (e) => {
    nav(`#/jobs/${encodeURIComponent(name)}/logs?date=${e.target.value}`);
  });
  main.querySelectorAll("tr[data-time]").forEach((tr) => {
    tr.addEventListener("click", () => {
      nav(`#/jobs/${encodeURIComponent(name)}/logs?date=${data.date}&time=${tr.dataset.time}`);
    });
  });
}

async function renderSingleLog(main, name, date, time) {
  let data;
  try {
    data = await api(`/api/jobs/${encodeURIComponent(name)}/log?date=${encodeURIComponent(date)}&time=${encodeURIComponent(time)}`);
  } catch (err) {
    main.innerHTML = `<div class="banner error">${escapeHtml(err.message)}</div>`;
    return;
  }
  const s = data.sections;

  const footerBadges = s.footer
    ? Object.entries(s.footer)
        .map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd class="mono">${escapeHtml(v)}</dd>`)
        .join("")
    : "";

  main.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${escapeHtml(name)} — ${escapeHtml(date)} ${escapeHtml(time)}</h1>
        <div class="subtitle"><a href="#/jobs/${encodeURIComponent(name)}/logs?date=${encodeURIComponent(date)}">&larr; back to log list</a></div>
      </div>
    </div>
    ${
      s.header
        ? `<div class="card"><h2>Header</h2><pre class="log-view">${escapeHtml(s.header)}</pre></div>`
        : ""
    }
    ${
      s.footer
        ? `<div class="card"><h2>Summary</h2><div class="kv">${footerBadges}</div>
           ${s.summaryLine ? `<div style="margin-top:10px;" class="mono">${escapeHtml(s.summaryLine)}</div>` : ""}</div>`
        : ""
    }
    ${
      s.finalMessage
        ? `<div class="card"><h2>Claude's final message</h2><pre class="log-view">${escapeHtml(s.finalMessage)}</pre></div>`
        : ""
    }
    ${
      s.resultJsonRaw
        ? `<div class="card"><details class="json-block"><summary>Result JSON</summary><pre class="log-view">${escapeHtml(
            s.resultJsonParsed ? JSON.stringify(s.resultJsonParsed, null, 2) : s.resultJsonRaw
          )}</pre></details></div>`
        : ""
    }
    ${
      s.resultUnparseable
        ? `<div class="card"><div class="banner error">Result JSON could not be parsed.</div><pre class="log-view">${escapeHtml(s.resultUnparseable)}</pre></div>`
        : ""
    }
    ${
      s.invocation
        ? `<div class="card"><details class="json-block"><summary>Raw agent output</summary><pre class="log-view">${escapeHtml(s.invocation)}</pre></details></div>`
        : ""
    }
    <div class="card"><details class="json-block"><summary>Full raw log</summary><pre class="log-view">${escapeHtml(data.raw)}</pre></details></div>
  `;
}
