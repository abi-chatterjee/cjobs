import { escapeHtml } from "./common.js";

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
  return e;
}

/** A single-series daily cost bar chart, no charting library. Rounded top
 * corners anchored to a square baseline, recessive gridline/axis, a shared
 * hover tooltip, sparse date labels to avoid collisions, and a "view as
 * table" fallback for accessibility (series data is also always rendered as
 * a plain table alongside). `series` is [{date: "YYYY-MM-DD", cost: number}]
 * in chronological order. */
export function renderCostBarChart(container, series) {
  const width = 720;
  const height = 220;
  const padL = 46;
  const padR = 12;
  const padT = 16;
  const padB = 28;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const maxVal = Math.max(0.0001, ...series.map((d) => d.cost));
  const n = series.length;
  const gap = 2;
  const barW = Math.max(2, (plotW - gap * (n - 1)) / n);

  const wrap = document.createElement("div");
  wrap.style.position = "relative";

  const svg = svgEl("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width: "100%",
    height: `${height}px`,
    role: "img",
    "aria-label": "Daily cost bar chart",
  });

  // baseline + one gridline at the max value, both recessive
  const baselineY = padT + plotH;
  svg.appendChild(
    svgEl("line", { x1: padL, x2: width - padR, y1: baselineY, y2: baselineY, style: "stroke:var(--border);stroke-width:1" })
  );
  svg.appendChild(
    svgEl("line", { x1: padL, x2: width - padR, y1: padT, y2: padT, style: "stroke:var(--border);stroke-width:1;stroke-dasharray:2,3" })
  );
  const maxLabel = svgEl("text", { x: padL - 8, y: padT + 4, "text-anchor": "end", style: "font-size:10px;fill:var(--text-faint)" });
  maxLabel.textContent = `$${maxVal.toFixed(2)}`;
  svg.appendChild(maxLabel);
  const zeroLabel = svgEl("text", { x: padL - 8, y: baselineY + 4, "text-anchor": "end", style: "font-size:10px;fill:var(--text-faint)" });
  zeroLabel.textContent = "$0";
  svg.appendChild(zeroLabel);

  const labelEvery = Math.max(1, Math.ceil(n / 8));

  const tooltip = document.createElement("div");
  tooltip.className = "chart-tooltip";
  Object.assign(tooltip.style, {
    position: "absolute", pointerEvents: "none", background: "var(--bg-elevated)",
    border: "1px solid var(--border)", borderRadius: "6px", padding: "5px 8px",
    fontSize: "12px", color: "var(--text)", boxShadow: "var(--shadow)",
    opacity: "0", transition: "opacity 0.08s", whiteSpace: "nowrap", zIndex: "5",
  });
  wrap.appendChild(tooltip);

  series.forEach((d, i) => {
    const x = padL + i * (barW + gap);
    const h = maxVal > 0 ? (d.cost / maxVal) * plotH : 0;
    const y = baselineY - h;
    const r = Math.min(4, barW / 2, Math.max(0, h));

    let node;
    if (h <= 0.5) {
      node = svgEl("rect", { x, y: baselineY - 1, width: barW, height: 1, style: "fill:var(--border)" });
    } else {
      const path =
        `M ${x} ${y + r} ` +
        `Q ${x} ${y} ${x + r} ${y} ` +
        `L ${x + barW - r} ${y} ` +
        `Q ${x + barW} ${y} ${x + barW} ${y + r} ` +
        `L ${x + barW} ${baselineY} ` +
        `L ${x} ${baselineY} Z`;
      node = svgEl("path", { d: path, style: "fill:var(--accent)" });
    }
    svg.appendChild(node);

    const hit = svgEl("rect", { x, y: padT, width: barW, height: plotH, fill: "transparent", style: "cursor:default" });
    hit.addEventListener("mouseenter", () => {
      tooltip.innerHTML = `<strong>${escapeHtml(d.date)}</strong><br>$${d.cost.toFixed(4)}`;
      tooltip.style.opacity = "1";
    });
    hit.addEventListener("mousemove", (ev) => {
      const rect = wrap.getBoundingClientRect();
      tooltip.style.left = `${ev.clientX - rect.left + 10}px`;
      tooltip.style.top = `${ev.clientY - rect.top - 30}px`;
    });
    hit.addEventListener("mouseleave", () => {
      tooltip.style.opacity = "0";
    });
    svg.appendChild(hit);

    if (i % labelEvery === 0 || i === n - 1) {
      const t = svgEl("text", {
        x: x + barW / 2, y: baselineY + 16, "text-anchor": "middle",
        style: "font-size:10px;fill:var(--text-faint)",
      });
      t.textContent = d.date.slice(5);
      svg.appendChild(t);
    }
  });

  wrap.appendChild(svg);
  container.innerHTML = "";
  container.appendChild(wrap);
}
