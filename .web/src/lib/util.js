"use strict";

const fs = require("fs");

/** Matches Python's `datetime.datetime.now().isoformat(timespec="seconds")` —
 * naive local time, no timezone suffix, second precision. */
function nowIsoSeconds() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** Recursively sorts object keys so JSON.stringify output matches Python's
 * `json.dump(..., sort_keys=True)`. */
function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value && typeof value === "object") {
    const out = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = sortKeysDeep(value[k]);
    }
    return out;
  }
  return value;
}

/** Atomic write-via-tempfile-then-rename, matching cjob's own `os.replace`
 * pattern for job.json / cjob.json. */
function atomicWriteJson(filePath, data) {
  const tmp = filePath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(sortKeysDeep(data), null, 2) + "\n");
  fs.renameSync(tmp, filePath);
}

/** Matches Python's `datetime.datetime.now().strftime("%Y%m%d-%H%M%S")`,
 * used for disambiguating archived-log directory names in `rm`. */
function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

module.exports = { nowIsoSeconds, sortKeysDeep, atomicWriteJson, nowStamp };
