"use strict";

const fs = require("fs");
const { FLOAT_RE } = require("./runsh");

function intOrNone(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!/^[+-]?\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

function floatOrNone(v) {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  if (!FLOAT_RE.test(s)) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/** Read only the last `maxBytes` of a file (matches cjob's 16KB-tail trick
 * for cheap footer extraction on large logs), tolerating invalid UTF-8 the
 * way Python's `errors="replace"` does. */
function readTail(filePath, maxBytes = 16384) {
  const size = fs.statSync(filePath).size;
  const start = size > maxBytes ? size - maxBytes : 0;
  const length = size - start;
  const fd = fs.openSync(filePath, "r");
  try {
    const buf = Buffer.alloc(length);
    if (length > 0) fs.readSync(fd, buf, 0, length, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

const FOOTER_RE = /^cjob\.([a-z_]+)=(.*)$/gm;

/** Port of read_result: whole-file JSON parse, else scan lines from the end
 * for the last valid JSON object (handles stream-json leftovers). */
function readResult(resultPath) {
  let text;
  try {
    text = fs.readFileSync(resultPath, "utf8");
  } catch (e) {
    return null;
  }
  if (!text.trim()) return null;
  try {
    const data = JSON.parse(text);
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch (e) {
    const lines = text.trim().split(/\r?\n/);
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const data = JSON.parse(lines[i]);
        if (data && typeof data === "object" && !Array.isArray(data)) return data;
      } catch (e2) {
        continue;
      }
    }
  }
  return null;
}

/** Port of read_run: pulls one run's summary from its log footer (+
 * result.json fallback), with the "SKIPPED"/"FATAL:"/still-running/
 * crashed-with-no-footer special cases. */
function readRun(logPath, date, hhmmss) {
  const rec = {
    date,
    time: hhmmss.replace(/-/g, ":"),
    log: logPath,
    exit_code: null,
    duration_seconds: null,
    total_cost_usd: null,
    num_turns: null,
    is_error: null,
    killed: false,
    session_id: null,
    skipped: false,
    incomplete: false,
  };

  let tail;
  try {
    tail = readTail(logPath, 16384);
  } catch (e) {
    return rec;
  }

  const found = {};
  FOOTER_RE.lastIndex = 0;
  let m;
  while ((m = FOOTER_RE.exec(tail)) !== null) {
    found[m[1]] = m[2].trim();
  }

  if (Object.keys(found).length) {
    rec.exit_code = intOrNone(found.exit_code);
    rec.duration_seconds = intOrNone(found.duration_seconds);
    rec.num_turns = intOrNone(found.num_turns);
    rec.total_cost_usd = floatOrNone(found.total_cost_usd);
    rec.is_error = found.is_error === "true";
    rec.killed = found.killed_by_watchdog === "yes";
    rec.session_id = found.session_id || null;
  } else if (tail.includes("SKIPPED: already running")) {
    rec.skipped = true;
    rec.exit_code = 0;
  } else if (tail.includes("FATAL:")) {
    rec.exit_code = 78;
    rec.is_error = true;
  } else {
    let fresh = false;
    try {
      const mtimeMs = fs.statSync(logPath).mtimeMs;
      fresh = Date.now() - mtimeMs < 300 * 1000;
    } catch (e) {
      fresh = false;
    }
    if (!fresh) {
      rec.incomplete = true;
      rec.is_error = true;
    }
  }

  if (rec.total_cost_usd === null) {
    const resultPath = logPath.slice(0, -4) + ".result.json";
    const data = readResult(resultPath);
    if (data) {
      rec.total_cost_usd = data.total_cost_usd !== undefined ? data.total_cost_usd : null;
      rec.num_turns = data.num_turns !== undefined ? data.num_turns : null;
      if (rec.is_error === null) rec.is_error = Boolean(data.is_error);
    }
  }

  return rec;
}

// ── structured section splitter for the log viewer (presentational only —
//    the raw text is always included so a parsing miss never hides data) ──

function findLineIndex(lines, predicate, from = 0) {
  for (let i = from; i < lines.length; i++) {
    if (predicate(lines[i])) return i;
  }
  return -1;
}

function splitLogSections(text) {
  const lines = text.split(/\r?\n/);
  const n = lines.length;
  const isRule = (l) => /^═+$/.test(l.trim());

  const out = {
    header: null,
    invocation: null,
    resultJsonRaw: null,
    resultJsonParsed: null,
    resultUnparseable: null,
    finalMessage: null,
    footerRaw: null,
    footer: null,
    summaryLine: null,
  };

  let idx = 0;
  const firstRule = findLineIndex(lines, isRule, 0);
  let secondRule = -1;
  if (firstRule !== -1) secondRule = findLineIndex(lines, isRule, firstRule + 1);
  if (firstRule !== -1 && secondRule !== -1) {
    out.header = lines.slice(firstRule + 1, secondRule).join("\n");
    idx = secondRule + 1;
  }

  // Matched by substring rather than the full literal marker so this works
  // for any runner's log — Claude's run.sh writes "invoking claude"/"claude's
  // final message", Jiva's writes "invoking jiva"/"final message".
  const invokeIdx = findLineIndex(lines, (l) => l.includes("──── invoking ") && l.includes("────"), idx);
  const resultIdx = findLineIndex(lines, (l) => l.includes("──── result json ────"), idx);
  const unparseIdx = findLineIndex(
    lines,
    (l) => l.includes("──── result json UNPARSEABLE ────"),
    idx
  );
  const finalIdx = findLineIndex(
    lines,
    (l) => l.includes("final message ────"),
    idx
  );
  const footerStartIdx = findLineIndex(lines, (l) => l.includes("RUN FOOTER"), idx);
  const footerEndIdx =
    footerStartIdx === -1 ? -1 : findLineIndex(lines, (l) => l.includes("END FOOTER"), footerStartIdx + 1);

  const markers = [
    { name: "invocation", at: invokeIdx },
    { name: "resultJson", at: resultIdx },
    { name: "resultUnparseable", at: unparseIdx },
    { name: "finalMessage", at: finalIdx },
    { name: "footer", at: footerStartIdx },
  ]
    .filter((m2) => m2.at !== -1)
    .sort((a, b) => a.at - b.at);

  for (let i = 0; i < markers.length; i++) {
    const cur = markers[i];
    const nextAt = i + 1 < markers.length ? markers[i + 1].at : n;
    const sliceStart = cur.at + 1;
    const sliceEnd = cur.name === "footer" && footerEndIdx !== -1 ? footerEndIdx : nextAt;
    const body = lines.slice(sliceStart, sliceEnd).join("\n").trim();
    if (cur.name === "invocation") out.invocation = body;
    else if (cur.name === "resultJson") {
      out.resultJsonRaw = body;
      try {
        out.resultJsonParsed = JSON.parse(body);
      } catch (e) {
        /* leave unparsed, raw text still shown */
      }
    } else if (cur.name === "resultUnparseable") out.resultUnparseable = body;
    else if (cur.name === "finalMessage") out.finalMessage = body;
    else if (cur.name === "footer") out.footerRaw = body;
  }

  if (out.footerRaw) {
    const footer = {};
    for (const l of out.footerRaw.split("\n")) {
      const fm = /^cjob\.([a-z_]+)=(.*)$/.exec(l.trim());
      if (fm) footer[fm[1]] = fm[2];
    }
    out.footer = footer;
  }
  if (footerEndIdx !== -1) {
    out.summaryLine = lines.slice(footerEndIdx + 1).join("\n").trim() || null;
  }

  return out;
}

module.exports = { readRun, readResult, readTail, splitLogSections, intOrNone, floatOrNone };
