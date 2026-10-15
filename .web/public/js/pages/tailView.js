import { api } from "../lib/fetchJson.js";
import { escapeHtml, exitPill, fmtCost, fmtDuration, toast, nav } from "../lib/common.js";
import { openLogSocket } from "../lib/ws.js";

export async function render(main, { name }) {
  main.innerHTML = `
    <div class="page-header">
      <div>
        <h1>${escapeHtml(name)} — live tail <span class="pill accent" id="live-pill">connecting…</span></h1>
        <div class="subtitle"><a href="#/jobs/${encodeURIComponent(name)}">&larr; back to job</a></div>
      </div>
      <div class="actions">
        <button id="btn-stop" class="ghost" style="color:var(--red);">Stop run</button>
      </div>
    </div>
    <div class="card">
      <div id="log-path" class="hint mono" style="margin-bottom:10px;"></div>
      <pre class="log-view" id="log-pane" style="max-height:70vh;"></pre>
      <div id="done-summary"></div>
    </div>
  `;

  const pane = main.querySelector("#log-pane");
  const livePill = main.querySelector("#live-pill");
  const pathEl = main.querySelector("#log-path");
  const doneEl = main.querySelector("#done-summary");
  const stopBtn = main.querySelector("#btn-stop");

  stopBtn.addEventListener("click", async () => {
    stopBtn.disabled = true;
    try {
      await api(`/api/jobs/${encodeURIComponent(name)}/stop`, { method: "POST" });
      toast("Sent stop signal.");
    } catch (err) {
      toast(err.message, "error");
    } finally {
      stopBtn.disabled = false;
    }
  });

  const ws = openLogSocket(name);
  let atBottom = true;
  pane.addEventListener("scroll", () => {
    atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
  });

  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === "searching") {
      livePill.textContent = "waiting for log…";
    } else if (msg.type === "start") {
      livePill.textContent = "live";
      pathEl.textContent = msg.log;
    } else if (msg.type === "data") {
      pane.textContent += msg.text;
      if (atBottom) pane.scrollTop = pane.scrollHeight;
    } else if (msg.type === "done") {
      livePill.outerHTML = '<span class="pill gray">finished</span>';
      stopBtn.disabled = true;
      const s = msg.summary;
      doneEl.innerHTML = `
        <div class="kv" style="margin-top:14px;">
          <dt>Result</dt><dd>${exitPill(s)}</dd>
          <dt>Duration</dt><dd>${fmtDuration(s.duration_seconds)}</dd>
          <dt>Turns</dt><dd>${s.num_turns ?? "—"}</dd>
          <dt>Cost</dt><dd>${fmtCost(s.total_cost_usd)}</dd>
        </div>
        <div style="margin-top:12px;">
          <a class="btn" href="#/jobs/${encodeURIComponent(name)}/logs?date=${s.date}&time=${encodeURIComponent(s.time)}">View full log</a>
        </div>
      `;
    } else if (msg.type === "error") {
      livePill.outerHTML = '<span class="pill red">error</span>';
      pane.textContent += `\n[${msg.message}]\n`;
    }
  });

  ws.addEventListener("error", () => {
    livePill.outerHTML = '<span class="pill red">connection error</span>';
  });

  return () => {
    try {
      ws.close();
    } catch (e) {
      /* already closed */
    }
  };
}
