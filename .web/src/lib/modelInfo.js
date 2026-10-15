"use strict";

const { AUTO_SUPPORTED, MODEL_ALIASES } = require("../config");

/** Port of auto_mode_supported(): true / false / null (unknown/unverifiable). */
function autoModeSupported(model) {
  const m = (model || "").trim();
  if (AUTO_SUPPORTED.has(m)) return true;
  if (MODEL_ALIASES.has(m)) return null;
  if (m.startsWith("claude-fable-")) return true;
  if (m.startsWith("claude-haiku")) return false;
  const mm = /^claude-(opus|sonnet)-(\d+)(?:-(\d+))?/.exec(m);
  if (mm) {
    const major = parseInt(mm[2], 10);
    const minor = mm[3] !== undefined ? parseInt(mm[3], 10) : 0;
    if (major >= 5) return true;
    return major > 4 || (major === 4 && minor >= 6);
  }
  return null;
}

module.exports = { autoModeSupported };
