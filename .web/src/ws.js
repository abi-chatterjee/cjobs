"use strict";

const { WebSocketServer } = require("ws");
const url = require("url");
const { verifyRequestAuth } = require("./middleware/requireAuth");
const { getJob } = require("./lib/jobsRoot");
const { findNewestLog, followLog } = require("./lib/tailer");
const { getRunEntry } = require("./lib/runner");
const { runDoctor } = require("./lib/doctor");

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) {
    try {
      ws.send(JSON.stringify(obj));
    } catch (e) {
      /* client likely gone; the close/error handlers will clean up */
    }
  }
}

/** Serves both "run now" streaming and `tail`: finds the newest (or
 * actively-being-written) log for the job and follows it live. */
async function handleLogsSocket(ws, jobName) {
  const job = getJob(jobName);
  if (!job) {
    safeSend(ws, { type: "error", message: `no such job: ${jobName}` });
    ws.close();
    return;
  }
  safeSend(ws, { type: "searching" });
  const logPath = await findNewestLog(job);
  if (!logPath) {
    safeSend(ws, { type: "error", message: `no logs yet for ${jobName}` });
    ws.close();
    return;
  }
  safeSend(ws, { type: "start", log: logPath });

  const stop = followLog(logPath, {
    onData: (text) => safeSend(ws, { type: "data", text }),
    onDone: (summary) => {
      safeSend(ws, { type: "done", summary });
      ws.close();
    },
    getTrackedEntry: () => getRunEntry(job.name),
  });

  ws.on("close", () => stop());
  ws.on("error", () => stop());
}

/** Streams each of the 11 doctor checks as it completes, so the UI never
 * looks hung during the ~180s live-token-test check. */
async function handleDoctorSocket(ws, { quick }) {
  try {
    for await (const result of runDoctor({ quick })) {
      safeSend(ws, { type: "result", ...result });
      if (ws.readyState !== ws.OPEN) break;
    }
    safeSend(ws, { type: "complete" });
  } catch (e) {
    safeSend(ws, { type: "error", message: e.message });
  } finally {
    ws.close();
  }
}

function attachWebSocketServer(server) {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let parsed;
    try {
      parsed = url.parse(req.url, true);
    } catch (e) {
      socket.destroy();
      return;
    }
    const { pathname, query } = parsed;

    const session = verifyRequestAuth(req);
    if (!session) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    if (pathname.startsWith("/ws/logs/")) {
      const jobName = decodeURIComponent(pathname.slice("/ws/logs/".length));
      wss.handleUpgrade(req, socket, head, (ws) => handleLogsSocket(ws, jobName));
      return;
    }
    if (pathname === "/ws/doctor") {
      const quick = query.quick === "1" || query.quick === "true";
      wss.handleUpgrade(req, socket, head, (ws) => handleDoctorSocket(ws, { quick }));
      return;
    }

    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
  });

  return wss;
}

module.exports = { attachWebSocketServer };
