"use strict";

const fs = require("fs");
const { CLI_STATE } = require("../config");
const { atomicWriteJson } = require("./util");

/** Reads the CLI's own defaults cache (~/claude-jobs/.state/cjob.json) to
 * prefill the new-job wizard with whatever was last used — shared with the
 * terminal `cjob new` wizard, read-only from here. */
function readCliState() {
  try {
    const data = JSON.parse(fs.readFileSync(CLI_STATE, "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch (e) {
    return {};
  }
}

/** Optional: the web wizard can also update the shared defaults cache after
 * successfully creating a job, same as the CLI wizard does. */
function saveCliState(state) {
  atomicWriteJson(CLI_STATE, state);
}

module.exports = { readCliState, saveCliState };
