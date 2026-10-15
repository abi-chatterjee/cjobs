"use strict";

const express = require("express");
const { listJobs, getJob } = require("../lib/jobsRoot");
const { requireAuth } = require("../middleware/requireAuth");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(requireAuth);

function localMidnight(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function dateStr(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const days = req.query.days ? parseInt(req.query.days, 10) : 7;
    if (!Number.isInteger(days) || days < 1) {
      return res.status(400).json({ error: "days must be a positive integer" });
    }

    let jobs = listJobs();
    if (req.query.job) {
      const job = getJob(String(req.query.job));
      if (!job) return res.status(404).json({ error: "no such job" });
      jobs = [job];
    }

    const cutoff = localMidnight(new Date());
    cutoff.setDate(cutoff.getDate() - (days - 1));

    const rows = [];
    let totCost = 0, totTurns = 0, totRuns = 0, totErr = 0, totSecs = 0;
    const autoModeJobs = [];
    const dailyCost = new Map(); // date -> cost, across all included jobs

    for (const job of jobs) {
      let cost = 0, turns = 0, runs = 0, errs = 0, secs = 0;
      for (const date of job.logDates()) {
        const [y, m, d] = date.split("-").map(Number);
        const day = new Date(y, m - 1, d);
        if (day < cutoff) continue;
        for (const rec of job.runsOn(date)) {
          if (rec.skipped) continue;
          runs++;
          if (rec.is_error) errs++;
          if (rec.total_cost_usd) {
            cost += rec.total_cost_usd;
            dailyCost.set(date, (dailyCost.get(date) || 0) + rec.total_cost_usd);
          }
          if (rec.num_turns) turns += rec.num_turns;
          if (rec.duration_seconds) secs += rec.duration_seconds;
        }
      }
      const meta = job.meta();
      if (meta.permission_mode === "auto") autoModeJobs.push(job.name);
      rows.push({
        job: job.name, runs, errors: errs, turns, wallSeconds: secs,
        cost, costPerRun: runs ? cost / runs : null,
      });
      totCost += cost; totTurns += turns; totRuns += runs; totErr += errs; totSecs += secs;
    }

    // Dense daily series (0-filled) so the chart's bar spacing reflects the
    // full window, not just days that happened to have a run.
    const daily = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(cutoff);
      d.setDate(d.getDate() + i);
      const ds = dateStr(d);
      daily.push({ date: ds, cost: dailyCost.get(ds) || 0 });
    }

    res.json({
      days,
      since: dateStr(cutoff),
      rows,
      daily,
      totals: { runs: totRuns, errors: totErr, turns: totTurns, wallSeconds: totSecs, cost: totCost },
      autoModeJobs,
      costNote:
        "est. API-equivalent, not a bill — on a Max plan these runs consume plan quota " +
        "(a rolling 5-hour window plus a weekly cap) and compete with interactive usage for the same quota",
    });
  })
);

module.exports = router;
