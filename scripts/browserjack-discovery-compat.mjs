#!/usr/bin/env node

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Transform } from "node:stream";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstream = process.env.BROWSERJACK_DISCOVERY_UPSTREAM
  ?? resolve(repoRoot, "scripts/browserjack-current.sh");

process.stdout.on("error", (error) => {
  if (error?.code === "EPIPE") {
    process.exitCode = 0;
    return;
  }
  throw error;
});

process.on("uncaughtException", (error) => {
  if (error?.code === "EPIPE") {
    process.exit(0);
  }
  throw error;
});

function safeScalar(value) {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    const rendered = JSON.stringify(value);
    return rendered.length <= 128 ? rendered : `${rendered.slice(0, 125)}...`;
  }
  return "<invalid>";
}

function traceRequest(sequence, method, id, action) {
  process.stderr.write(
    `browserjack_discovery_compat sequence=${sequence} method=${safeScalar(method)} id=${safeScalar(id)} action=${action}\n`,
  );
}

class DiscoveryCompatTransform extends Transform {
  constructor(onDiscoveryResponse) {
    super();
    this.buffer = Buffer.alloc(0);
    this.sequence = 0;
    this.onDiscoveryResponse = onDiscoveryResponse;
  }

  processRecord(record, delimiter) {
    const parseTarget = record.length > 0 && record[record.length - 1] === 0x0d
      ? record.subarray(0, -1)
      : record;
    let message;
    try {
      message = JSON.parse(parseTarget.toString("utf8"));
    } catch {
      this.push(Buffer.concat([record, delimiter]));
      return;
    }

    if (message === null || Array.isArray(message) || typeof message !== "object") {
      this.push(Buffer.concat([record, delimiter]));
      return;
    }

    if (typeof message.method === "string") {
      this.sequence += 1;
      const hasId = Object.prototype.hasOwnProperty.call(message, "id");
      const action = message.method === "server/discover" ? "reject" : "forward";
      traceRequest(this.sequence, message.method, hasId ? message.id : undefined, action);

      if (message.method === "server/discover") {
        if (hasId) {
          this.onDiscoveryResponse({
            jsonrpc: "2.0",
            id: message.id,
            error: { code: -32601, message: "Method not found" },
          });
        }
        return;
      }
    }

    this.push(Buffer.concat([record, delimiter]));
  }

  _transform(chunk, _encoding, callback) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let newline;
    while ((newline = this.buffer.indexOf(0x0a)) !== -1) {
      const record = this.buffer.subarray(0, newline);
      this.buffer = this.buffer.subarray(newline + 1);
      this.processRecord(record, Buffer.from("\n"));
    }
    callback();
  }

  _flush(callback) {
    if (this.buffer.length > 0) {
      this.processRecord(this.buffer, Buffer.alloc(0));
    }
    callback();
  }
}

function exitCode(code, signal) {
  if (typeof code === "number") return code;
  if (signal && osConstants.signals[signal]) return 128 + osConstants.signals[signal];
  return 1;
}

function forwardSignals(child) {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.once(signal, () => {
      child.kill(signal);
    });
  }
}

function runPassthrough(args) {
  const child = spawn(upstream, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });
  forwardSignals(child);
  child.once("error", (error) => {
    process.stderr.write(`browserjack_discovery_compat spawn_error=${JSON.stringify(error.message)}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = exitCode(code, signal);
  });
}

function runProxy(args) {
  const child = spawn(upstream, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  forwardSignals(child);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.stdin.on("error", (error) => {
    if (error.code !== "EPIPE") throw error;
  });

  const transform = new DiscoveryCompatTransform((response) => {
    process.stdout.write(`${JSON.stringify(response)}\n`);
  });
  process.stdin.pipe(transform).pipe(child.stdin);

  child.once("error", (error) => {
    process.stderr.write(`browserjack_discovery_compat spawn_error=${JSON.stringify(error.message)}\n`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = exitCode(code, signal);
  });
}

const args = process.argv.slice(2);
if (args[0] === "run") {
  runProxy(args);
} else {
  runPassthrough(args);
}
