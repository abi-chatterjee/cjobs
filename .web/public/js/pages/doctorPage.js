import { escapeHtml, statusPill } from "../lib/common.js";
import { openDoctorSocket } from "../lib/ws.js";

export async function render(main, params) {
  main.innerHTML = `
    <div class="page-header">
      <div><h1>Doctor</h1><div class="subtitle">Health checks, same as <span class="mono">cjob doctor</span></div></div>
      <div class="actions">
        <button id="btn-quick">Re-run (quick)</button>
        <button id="btn-full" class="primary">Run full check (incl. live token test, ~3 min)</button>
      </div>
    </div>
    <div id="results" class="card"></div>
    <div id="summary"></div>
  `;

  let activeWs = null;
  const resultsEl = main.querySelector("#results");
  const summaryEl = main.querySelector("#summary");

  function run(quick) {
    if (activeWs) {
      try {
        activeWs.close();
      } catch (e) {
        /* already closed */
      }
    }
    resultsEl.innerHTML = `<div class="empty">Running checks…</div>`;
    summaryEl.innerHTML = "";
    const rows = [];
    let first = true;

    const ws = openDoctorSocket(quick);
    activeWs = ws;

    ws.addEventListener("message", (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === "result") {
        if (first) {
          resultsEl.innerHTML = `<table class="data"><thead><tr><th>#</th><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody id="rows-body"></tbody></table>`;
          first = false;
        }
        rows.push(msg);
        const tbody = resultsEl.querySelector("#rows-body");
        tbody.insertAdjacentHTML(
          "beforeend",
          `<tr>
            <td class="mono">${msg.n}</td>
            <td>${escapeHtml(msg.name)}</td>
            <td>${statusPill(msg.status)}</td>
            <td>
              <div>${escapeHtml(msg.detail)}</div>
              ${msg.remedy ? `<div class="hint" style="white-space:pre-wrap; margin-top:4px;">fix: ${escapeHtml(msg.remedy)}</div>` : ""}
            </td>
          </tr>`
        );
      } else if (msg.type === "complete") {
        const passed = rows.filter((r) => r.status === "PASS").length;
        const failed = rows.filter((r) => r.status === "FAIL").length;
        const warned = rows.filter((r) => r.status === "WARN").length;
        const kind = failed ? "error" : warned ? "warn" : "info";
        summaryEl.innerHTML = `<div class="banner ${kind}">${passed} passed, ${failed} failed, ${warned} warning(s)</div>`;
      } else if (msg.type === "error") {
        resultsEl.insertAdjacentHTML("beforeend", `<div class="banner error">${escapeHtml(msg.message)}</div>`);
      }
    });
    ws.addEventListener("error", () => {
      summaryEl.innerHTML = `<div class="banner error">connection error</div>`;
    });
  }

  main.querySelector("#btn-quick").addEventListener("click", () => run(true));
  main.querySelector("#btn-full").addEventListener("click", () => run(false));

  run(true);

  return () => {
    if (activeWs) {
      try {
        activeWs.close();
      } catch (e) {
        /* already closed */
      }
    }
  };
}
