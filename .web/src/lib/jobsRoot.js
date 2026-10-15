"use strict";

const fs = require("fs");
const path = require("path");
const { AGENTS_DIR } = require("../config");
const { Job } = require("./job");

/** A dir under ~/claude-jobs/.agents is a job iff its name has no leading dot
 * AND it contains a job.json — everything else (e.g. .archived-logs/) is
 * ignored, matching cjob's own list_jobs(). */
function listJobs() {
  let names;
  try {
    names = fs.readdirSync(AGENTS_DIR).sort();
  } catch (e) {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const dirPath = path.join(AGENTS_DIR, name);
    try {
      if (
        fs.statSync(dirPath).isDirectory() &&
        fs.statSync(path.join(dirPath, "job.json")).isFile()
      ) {
        out.push(new Job(name));
      }
    } catch (e) {
      continue;
    }
  }
  return out;
}

function getJob(name) {
  if (!name) return null;
  const job = new Job(name);
  try {
    if (!fs.statSync(job.jobJson).isFile()) return null;
  } catch (e) {
    return null;
  }
  return job;
}

module.exports = { listJobs, getJob };
