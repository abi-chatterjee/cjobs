"use strict";

const express = require("express");
const fs = require("fs");
const path = require("path");

const { getJob } = require("../lib/jobsRoot");
const { splitLogSections } = require("../lib/logs");
const { requireAuth } = require("../middleware/requireAuth");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(requireAuth);

function todayLocalStr() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

router.get(
  "/:name/logs/dates",
  asyncHandler(async (req, res) => {
    const job = getJob(req.params.name);
    if (!job) return res.status(404).json({ error: "no such job" });
    res.json({ dates: job.logDates() });
  })
);

router.get(
  "/:name/logs",
  asyncHandler(async (req, res) => {
    const job = getJob(req.params.name);
    if (!job) return res.status(404).json({ error: "no such job" });
    const dates = job.logDates();
    if (!dates.length) return res.json({ date: null, runs: [] });

    let date = req.query.date ? String(req.query.date) : null;
    if (!date) {
      const today = todayLocalStr();
      date = dates.includes(today) ? today : dates[dates.length - 1];
    } else if (!dates.includes(date)) {
      return res.status(404).json({
        error: `no logs for ${job.name} on ${date}`,
        availableDates: dates.slice(-8),
      });
    }
    res.json({ date, runs: job.runsOn(date) });
  })
);

router.get(
  "/:name/log",
  asyncHandler(async (req, res) => {
    const job = getJob(req.params.name);
    if (!job) return res.status(404).json({ error: "no such job" });

    let logPath;
    if (req.query.date && req.query.time) {
      const timeFile = String(req.query.time).replace(/:/g, "-") + ".log";
      logPath = path.join(job.logsDir, String(req.query.date), timeFile);
    } else {
      const runs = job.recentRuns(1);
      if (!runs.length) return res.status(404).json({ error: `no runs yet for ${job.name}` });
      logPath = runs[0].log;
    }
    if (!fs.existsSync(logPath)) return res.status(404).json({ error: `no such log: ${logPath}` });

    const raw = fs.readFileSync(logPath, "utf8");
    const sections = splitLogSections(raw);
    res.json({ path: logPath, raw, sections });
  })
);

module.exports = router;
