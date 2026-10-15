"use strict";

const express = require("express");
const { getJob } = require("../lib/jobsRoot");
const { startRun, stopRun } = require("../lib/runner");
const { requireAuth } = require("../middleware/requireAuth");
const { csrfProtect } = require("../middleware/csrf");
const { asyncHandler } = require("../middleware/asyncHandler");

const router = express.Router();
router.use(requireAuth);

// Non-blocking: responds immediately, client streams progress over
// /ws/logs/:name (the same channel `tail` uses).
router.post(
  "/:name/run",
  csrfProtect,
  asyncHandler(async (req, res) => {
    const job = getJob(req.params.name);
    if (!job) return res.status(404).json({ error: "no such job" });
    const result = startRun(job);
    if (!result.started && !result.alreadyRunning) {
      return res.status(500).json({ error: result.error || "failed to start" });
    }
    res.status(202).json({
      ok: true,
      started: result.started,
      alreadyRunning: Boolean(result.alreadyRunning),
      pid: result.pid,
    });
  })
);

router.post(
  "/:name/stop",
  csrfProtect,
  asyncHandler(async (req, res) => {
    const job = getJob(req.params.name);
    if (!job) return res.status(404).json({ error: "no such job" });
    const result = stopRun(job.name);
    if (!result.stopped) return res.status(409).json({ error: result.reason });
    res.json({ ok: true });
  })
);

module.exports = router;
