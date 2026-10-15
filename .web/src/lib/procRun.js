"use strict";

const { execFile } = require("child_process");

/** Port of cjob's `run(argv, env, cwd, timeout)`: always argv arrays, never
 * shell:true. timeoutMs is in milliseconds (Python's is seconds). Resolves
 * (never rejects) with {rc, stdout, stderr}, matching the Python helper's
 * habit of swallowing FileNotFoundError/TimeoutExpired into an rc. */
function run(argv, { env, cwd, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const [cmd, ...args] = argv;
    execFile(
      cmd,
      args,
      {
        env,
        cwd,
        timeout: timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
        encoding: "utf8",
      },
      (error, stdout, stderr) => {
        if (error) {
          if (error.code === "ENOENT") {
            resolve({ rc: 127, stdout: "", stderr: `${cmd}: command not found` });
            return;
          }
          if (error.killed && error.signal) {
            resolve({
              rc: 124,
              stdout: stdout || "",
              stderr: `timed out after ${timeoutMs}ms`,
            });
            return;
          }
          resolve({
            rc: typeof error.code === "number" ? error.code : 1,
            stdout: stdout || "",
            stderr: stderr || String(error.message || error),
          });
          return;
        }
        resolve({ rc: 0, stdout: stdout || "", stderr: stderr || "" });
      }
    );
  });
}

module.exports = { run };
