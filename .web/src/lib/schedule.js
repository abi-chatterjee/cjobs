"use strict";

const { DAY_KEYS, DAY_NAMES, SCHEDULE_HELP } = require("../config");

function pad2(n) {
  return String(n).padStart(2, "0");
}

function parseTimes(text) {
  const times = [];
  for (let chunk of text.split(",")) {
    chunk = chunk.trim();
    if (!chunk) continue;
    const m = /^(\d{1,2}):(\d{2})$/.exec(chunk);
    if (!m) throw new Error(`bad time "${chunk}" (want HH:MM)`);
    const hour = parseInt(m[1], 10);
    const minute = parseInt(m[2], 10);
    if (!(hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59)) {
      throw new Error(`time out of range: "${chunk}"`);
    }
    times.push([hour, minute]);
  }
  if (!times.length) throw new Error("no time given");
  return times;
}

/** Port of parse_schedule: spec string -> {canon, entries: StartCalendarInterval dicts}. */
function parseSchedule(spec) {
  const toks = (spec || "").trim().split(/\s+/).filter(Boolean);
  if (!toks.length) throw new Error("empty schedule. " + SCHEDULE_HELP);
  const when = toks[0].toLowerCase();
  // Python: "".join(toks[1:]) — concatenation with NO separator, intentional.
  const rest = toks.slice(1).join("");

  if (when === "hourly") {
    let minute = 0;
    if (rest) {
      const m = /^:?(\d{1,2})$/.exec(rest);
      if (!m) throw new Error("hourly takes an optional minute, e.g. `hourly :07`");
      minute = parseInt(m[1], 10);
      if (!(minute >= 0 && minute <= 59)) throw new Error(`minute out of range: ${minute}`);
    }
    const canon = minute === 0 ? "hourly" : `hourly :${pad2(minute)}`;
    return { canon, entries: [{ Minute: minute }] };
  }

  const times = parseTimes(rest);
  const timesS = times.map(([h, m]) => `${pad2(h)}:${pad2(m)}`).join(",");

  if (when === "daily") {
    return {
      canon: `daily ${timesS}`,
      entries: times.map(([h, m]) => ({ Hour: h, Minute: m })),
    };
  }

  let days, canonWhen;
  if (when === "weekdays") {
    days = [1, 2, 3, 4, 5];
    canonWhen = "weekdays";
  } else if (when === "weekends") {
    days = [0, 6];
    canonWhen = "weekends";
  } else {
    days = [];
    for (let part of when.split(",")) {
      part = part.trim();
      if (!(part in DAY_KEYS)) throw new Error(`unknown day "${part}". ${SCHEDULE_HELP}`);
      const wd = DAY_KEYS[part];
      if (!days.includes(wd)) days.push(wd);
    }
    if (!days.length) throw new Error("no days given. " + SCHEDULE_HELP);
    canonWhen = [...days].sort((a, b) => a - b).map((d) => DAY_NAMES[d].toLowerCase()).join(",");
  }

  const sortedDays = [...days].sort((a, b) => a - b);
  const entries = [];
  for (const d of sortedDays) {
    for (const [h, m] of times) {
      entries.push({ Weekday: d, Hour: h, Minute: m });
    }
  }
  return { canon: `${canonWhen} ${timesS}`, entries };
}

function describeSchedule(meta) {
  const sched = (meta && meta.schedule) || {};
  const spec = sched.spec;
  if (!spec) return "unscheduled";
  if (spec === "hourly") return "hourly at :00";
  return spec;
}

/** Port of render_calendar: byte-exact XML for the plist's StartCalendarInterval. */
function renderCalendar(entries) {
  const one = (entry, indent) => {
    const pad = " ".repeat(indent);
    const out = [pad + "<dict>"];
    for (const key of ["Weekday", "Hour", "Minute"]) {
      if (Object.prototype.hasOwnProperty.call(entry, key)) {
        out.push(`${pad}  <key>${key}</key><integer>${entry[key]}</integer>`);
      }
    }
    out.push(pad + "</dict>");
    return out;
  };

  if (entries.length === 1) {
    return one(entries[0], 2).join("\n");
  }
  const lines = ["  <array>"];
  for (const entry of entries) {
    lines.push(...one(entry, 4));
  }
  lines.push("  </array>");
  return lines.join("\n");
}

module.exports = { parseSchedule, describeSchedule, renderCalendar, parseTimes };
