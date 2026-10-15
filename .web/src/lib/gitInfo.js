"use strict";

const fs = require("fs");
const { run } = require("./procRun");

/** Port of git_info(): null if not a dir or not a git repo, else
 * {branch, sha, dirty}. */
async function gitInfo(repoDir) {
  if (!fs.existsSync(repoDir) || !fs.statSync(repoDir).isDirectory()) return null;
  const head = await run(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoDir });
  if (head.rc !== 0) return null;
  const branch = head.stdout.trim();
  const shaRes = await run(["git", "rev-parse", "--short", "HEAD"], { cwd: repoDir });
  const statusRes = await run(["git", "status", "--porcelain"], { cwd: repoDir });
  return {
    branch,
    sha: shaRes.stdout.trim(),
    dirty: Boolean(statusRes.stdout.trim()),
  };
}

module.exports = { gitInfo };
