#!/usr/bin/env node
"use strict";

const express = require("express");
const cookieParser = require("cookie-parser");
const path = require("path");
const http = require("http");

const { isConfigured } = require("./src/lib/auth");
const authRoutes = require("./src/routes/auth");
const jobsRoutes = require("./src/routes/jobs");
const logsRoutes = require("./src/routes/logs");
const runRoutes = require("./src/routes/run");
const usageRoutes = require("./src/routes/usage");
const { attachWebSocketServer } = require("./src/ws");

const PORT = parseInt(process.env.CJOBWEB_PORT || "3322", 10);

const app = express();
// ngrok sits in front of this process — trust its X-Forwarded-* headers so
// req.secure/req.ip reflect the real client, not the local tunnel hop.
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));

app.use("/api/auth", authRoutes);
// These three all live under /api/jobs/:name/* — Express tries each mounted
// router in order and falls through on no match, so this is safe as long as
// no two routers define the same sub-path (they don't).
app.use("/api/jobs", jobsRoutes);
app.use("/api/jobs", logsRoutes);
app.use("/api/jobs", runRoutes);
app.use("/api/usage", usageRoutes);

app.use(express.static(path.join(__dirname, "public")));

// SPA fallback: any non-API, non-WS path serves the app shell; client-side
// JS checks /api/auth/status and redirects to /login.html if unauthenticated.
app.get(/^\/(?!api\/|ws\/).*/, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const server = http.createServer(app);
attachWebSocketServer(server);

server.listen(PORT, () => {
  console.log(`cjob-web listening on http://localhost:${PORT}`);
  if (!isConfigured()) {
    console.log("No login password is configured yet — run:  node setup-password.js");
  }
});
