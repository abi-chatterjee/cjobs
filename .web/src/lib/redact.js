"use strict";

const { SECRET_RE } = require("../config");

/** Never echo a credential to the client, even one the API handed back. */
function redact(text) {
  return String(text).replace(SECRET_RE, "$1...REDACTED");
}

module.exports = { redact };
