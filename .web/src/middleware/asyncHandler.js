"use strict";

/** Express 4 doesn't catch rejected promises from async handlers on its
 * own — without this, an error thrown deep in an awaited call (e.g. a
 * launchctl call failing unexpectedly) would hang the request forever
 * instead of returning a 500. */
function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((err) => {
      console.error(err);
      if (!res.headersSent) {
        res.status(500).json({ error: err && err.message ? err.message : "internal error" });
      }
    });
  };
}

module.exports = { asyncHandler };
