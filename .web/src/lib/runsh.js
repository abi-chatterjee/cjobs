"use strict";

const fs = require("fs");
const path = require("path");
const { splitValue } = require("./shlex");
const { TEMPLATES } = require("../config");

const CONFIG_START = /^#\s*CONFIG\b/;
const CONFIG_END = /^#\s*END CONFIG\b/;
const ASSIGN = /^([A-Z][A-Z0-9_]*)=(.*)$/;

/** Port of cjob's parse_run_sh: pulls the CONFIG block out of run.sh by
 * scanning for the marker comments, NOT by executing the script. Bash-array
 * values (`KEY=(...)`) are buffered across lines until a `)` is seen. */
function parseRunSh(filePath) {
  const cfg = {};
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    return cfg;
  }
  const lines = text.split(/\r\n|\r|\n/);
  let inside = false;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.trim();
    if (!inside) {
      if (CONFIG_START.test(stripped)) inside = true;
      i++;
      continue;
    }
    if (CONFIG_END.test(stripped)) break;
    const m = ASSIGN.exec(stripped);
    if (m) {
      const key = m[1];
      const rhs = m[2];
      const rhsLeftTrimmed = rhs.replace(/^\s+/, "");
      if (rhsLeftTrimmed.startsWith("(")) {
        let buf = rhsLeftTrimmed.slice(1);
        while (!buf.includes(")") && i + 1 < lines.length) {
          i++;
          buf += " " + lines[i];
        }
        buf = buf.split(")")[0];
        cfg[key] = splitValue(buf);
      } else {
        const vals = splitValue(rhs);
        cfg[key] = vals.length ? vals[0] : "";
      }
    }
    i++;
  }
  return cfg;
}

function strictInt(s) {
  if (!/^[+-]?\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

/** Port of cfg_int: `int(str(cfg.get(key, default)).strip())` with fallback. */
function cfgInt(cfg, key, def = 0) {
  const raw = Object.prototype.hasOwnProperty.call(cfg, key) ? cfg[key] : def;
  const s = String(raw).trim();
  const v = strictInt(s);
  return v === null ? def : v;
}

const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

/** Port of cfg_num: float, collapsed to a whole number when it's exact. */
function cfgNum(cfg, key, def = 0) {
  const raw = Object.prototype.hasOwnProperty.call(cfg, key) ? cfg[key] : def;
  const s = String(raw).trim();
  if (!FLOAT_RE.test(s)) return def;
  const v = parseFloat(s);
  if (!isFinite(v)) return def;
  return v;
}

/** Port of write_run_sh: template substitution + leftover-placeholder guard.
 * templateName lets Jiva-runner jobs use run-jiva.sh.tmpl instead. */
function writeRunSh(runShPath, values, templateName = "run.sh.tmpl") {
  const tmplPath = path.join(TEMPLATES, templateName);
  let tmpl = fs.readFileSync(tmplPath, "utf8");
  const extra = values.EXTRA_DIRS || [];
  const subs = Object.assign({}, values);
  subs.EXTRA_DIRS = extra.map((d) => `"${d}"`).join(" ");
  for (const [key, val] of Object.entries(subs)) {
    tmpl = tmpl.split(`@@${key}@@`).join(String(val));
  }
  const left = [...tmpl.matchAll(/@@([A-Z_]+)@@/g)].map((m) => m[1]);
  if (left.length) {
    throw new Error(
      "run.sh template has unsubstituted placeholders: " +
        [...new Set(left)].sort().join(", ")
    );
  }
  fs.writeFileSync(runShPath, tmpl);
  fs.chmodSync(runShPath, 0o755);
}

module.exports = {
  parseRunSh, cfgInt, cfgNum, writeRunSh, CONFIG_START, CONFIG_END, ASSIGN, FLOAT_RE,
};
