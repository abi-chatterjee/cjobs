export function escapeHtml(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

export function nav(hash) {
  location.hash = hash;
}

export function fmtCost(v) {
  if (v === null || v === undefined) return '<span class="mono" style="color:var(--text-faint)">—</span>';
  return `$${Number(v).toFixed(4)}`;
}

export function fmtDuration(secs) {
  if (secs === null || secs === undefined) return '<span style="color:var(--text-faint)">—</span>';
  secs = Math.round(secs);
  if (secs < 90) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m${String(s).padStart(2, "0")}s`;
}

export function fmtWhen(rec) {
  if (!rec) return '<span style="color:var(--text-faint)">never</span>';
  return `${rec.date.slice(5)} ${rec.time}`;
}

/** PASS/FAIL/WARN/SKIP or a run's exit-status, rendered as a colored pill. */
export function exitPill(rec) {
  if (!rec) return '<span class="pill gray">—</span>';
  if (rec.skipped) return '<span class="pill gray">skip</span>';
  if (rec.incomplete) return '<span class="pill red">no footer</span>';
  if (rec.exit_code === null || rec.exit_code === undefined) {
    return '<span class="pill yellow">running…</span>';
  }
  if (rec.killed) return `<span class="pill red">${rec.exit_code} killed</span>`;
  if (rec.exit_code === 0 && !rec.is_error) return '<span class="pill green">0</span>';
  return `<span class="pill red">${rec.exit_code || "err"}</span>`;
}

export function statusPill(status) {
  const map = { PASS: "green", FAIL: "red", WARN: "yellow", SKIP: "gray" };
  return `<span class="pill ${map[status] || "gray"}"><span class="dot"></span>${status}</span>`;
}

export function enabledPill(enabled, loaded, stale) {
  if (stale) return '<span class="pill yellow">stale</span>';
  return enabled ? '<span class="pill green">on</span>' : '<span class="pill gray">off</span>';
}

export function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

/** Minimal promise-based modal: resolves true/false (confirm) or a value
 * (custom). `bodyHtml` is trusted HTML (caller must escape user content). */
export function modal({ title, bodyHtml, confirmLabel = "Confirm", danger = false, onMount }) {
  return new Promise((resolve) => {
    const backdrop = el(`
      <div class="modal-backdrop">
        <div class="modal">
          <h3>${escapeHtml(title)}</h3>
          <div class="modal-body">${bodyHtml}</div>
          <div class="actions">
            <button type="button" class="ghost" data-act="cancel">Cancel</button>
            <button type="button" class="${danger ? "danger" : "primary"}" data-act="confirm">${escapeHtml(confirmLabel)}</button>
          </div>
        </div>
      </div>
    `);
    document.body.appendChild(backdrop);
    const cleanup = (value) => {
      backdrop.remove();
      resolve(value);
    };
    backdrop.querySelector('[data-act="cancel"]').addEventListener("click", () => cleanup(false));
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) cleanup(false);
    });
    backdrop.querySelector('[data-act="confirm"]').addEventListener("click", () => {
      if (onMount && onMount.getValue) {
        cleanup(onMount.getValue(backdrop));
      } else {
        cleanup(true);
      }
    });
    if (onMount && onMount.init) onMount.init(backdrop);
  });
}

export function toast(msg, kind = "info") {
  const box = el(`<div class="banner ${kind}" style="position:fixed;top:16px;right:16px;z-index:200;box-shadow:var(--shadow);max-width:360px;">${escapeHtml(msg)}</div>`);
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 4000);
}
