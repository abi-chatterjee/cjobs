#!/usr/bin/env node
"use strict";

// One-time (or re-run-anytime) local setup for the cjob-web login password.
// Run this from a terminal on the machine itself — it never accepts input
// over HTTP. Writes /Users/abi/.secrets/cjobweb_auth.json (mode 600).

const fs = require("fs");
const crypto = require("crypto");
const readline = require("readline");
const { AUTH_FILE, SECRETS_DIR } = require("./src/config");

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 64 };

// Control character codes, by charCode rather than string literals — easier
// to keep correct than embedding literal control bytes in source.
const CODE = { LF: 10, CR: 13, EOT: 4, ETX: 3, DEL: 127, BS: 8 };

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
}

function promptHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error("not a TTY — run this from an interactive terminal"));
      return;
    }
    process.stdout.write(question);
    let input = "";
    const wasRaw = stdin.isRaw;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");

    const finish = () => {
      stdin.setRawMode(Boolean(wasRaw));
      stdin.pause();
      stdin.removeListener("data", onData);
    };

    const onData = (chunk) => {
      const s = chunk.toString();
      for (const ch of s) {
        const code = ch.charCodeAt(0);
        if (code === CODE.LF || code === CODE.CR || code === CODE.EOT) {
          finish();
          process.stdout.write("\n");
          resolve(input);
          return;
        }
        if (code === CODE.ETX) {
          finish();
          process.stdout.write("\n");
          process.exit(130);
          return;
        }
        if (code === CODE.DEL || code === CODE.BS) {
          if (input.length) {
            input = input.slice(0, -1);
            process.stdout.write(String.fromCharCode(CODE.BS) + " " + String.fromCharCode(CODE.BS));
          }
          continue;
        }
        input += ch;
        process.stdout.write("*");
      }
    };
    stdin.on("data", onData);
  });
}

async function main() {
  console.log("cjob-web password setup");
  console.log(`This writes ${AUTH_FILE} (mode 600). Never sent over HTTP.\n`);

  if (fs.existsSync(AUTH_FILE)) {
    const ans = await ask("A password is already configured. Replace it? [y/N]: ");
    if (!/^y(es)?$/i.test(ans.trim())) {
      console.log("cancelled — existing password left unchanged.");
      process.exit(0);
    }
    console.log();
  }

  const pw1 = await promptHidden("New password (min 8 characters): ");
  if (pw1.length < 8) {
    console.error("too short — must be at least 8 characters.");
    process.exit(1);
  }
  const pw2 = await promptHidden("Confirm password: ");
  if (pw1 !== pw2) {
    console.error("passwords did not match — nothing written.");
    process.exit(1);
  }

  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(pw1, salt, SCRYPT_PARAMS.keylen, {
    N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p,
  });
  const sessionSecret = crypto.randomBytes(32).toString("hex");

  const data = {
    scrypt: {
      salt: salt.toString("hex"),
      hash: hash.toString("hex"),
      N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p, keylen: SCRYPT_PARAMS.keylen,
    },
    sessionSecret,
    createdAt: new Date().toISOString(),
  };

  fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
  const tmp = AUTH_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.chmodSync(tmp, 0o600);
  fs.renameSync(tmp, AUTH_FILE);

  console.log(`\nDone. Wrote ${AUTH_FILE} (mode 600).`);
  console.log("If cjob-web is already running, it will pick up the new password within a few seconds.");
  console.log("Start the server with:  node server.js   (default port 3322)");
}

main().catch((err) => {
  console.error("\nsetup failed:", err.message);
  process.exit(1);
});
