#!/usr/bin/env node
// Probe MCP server for the Fraktik packaging spike (Phase 0).
// Speaks minimal MCP over stdio (newline-delimited JSON-RPC) and exposes one
// read-only tool, probe_report, that returns everything the spike needs to
// observe about how Codex launches plugin-bundled MCP servers.
//
// It performs no writes, opens no sockets, and reads only the marker file
// whose path it was handed via --marker.

import { existsSync, realpathSync } from "node:fs";
import process from "node:process";

const startedAt = new Date().toISOString();

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1];
}

const entry = argValue("--entry") ?? "unknown";
const markerRaw = argValue("--marker");

process.stderr.write(
  `[probe:${entry}] started pid=${process.pid} node=${process.version} at ${startedAt}\n`,
);

function envSubset() {
  const keys = [
    "PLUGIN_ROOT",
    "PLUGIN_DATA",
    "CLAUDE_PLUGIN_ROOT",
    "CLAUDE_PLUGIN_DATA",
    "PROBE_PLUGIN_ROOT_ENV",
    "PROBE_STATIC_ENV",
    "CODEX_HOME",
    "CODEX_THREAD_ID",
    "HOME",
    "PATH",
    "SHELL",
  ];
  const subset = {};
  for (const key of keys) {
    subset[key] = key in process.env ? process.env[key] : "<unset>";
  }
  return subset;
}

let framing = null; // "newline" | "headers", detected from the first byte

function buildReport() {
  let selfPath = process.argv[1] ?? "<none>";
  let selfRealPath = null;
  try {
    selfRealPath = realpathSync(selfPath);
  } catch {
    selfRealPath = "<unresolvable>";
  }
  return {
    probeVersion: 2,
    entry,
    framing,
    startedAt,
    node: {
      version: process.version,
      execPath: process.execPath,
    },
    process: {
      pid: process.pid,
      cwd: process.cwd(),
      argv: process.argv,
      selfPath,
      selfRealPath,
    },
    expansion: {
      markerArgRaw: markerRaw ?? "<not passed>",
      markerArgWasExpanded:
        typeof markerRaw === "string" && !markerRaw.includes("${"),
      markerFileExists:
        typeof markerRaw === "string" && !markerRaw.includes("${")
          ? existsSync(markerRaw)
          : false,
      envValueRaw: process.env.PROBE_PLUGIN_ROOT_ENV ?? "<unset>",
      envValueWasExpanded:
        typeof process.env.PROBE_PLUGIN_ROOT_ENV === "string" &&
        !process.env.PROBE_PLUGIN_ROOT_ENV.includes("${"),
    },
    env: envSubset(),
  };
}

function send(payload) {
  const json = JSON.stringify(payload);
  if (framing === "headers") {
    process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
  } else {
    process.stdout.write(json + "\n");
  }
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(message) {
  const { id, method } = message;
  if (method === "initialize") {
    respond(id, {
      protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: `fraktik-mcp-probe-${entry}`, version: "0.0.1" },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") {
    return; // notification, no response
  }
  if (method === "ping") {
    respond(id, {});
    return;
  }
  if (method === "tools/list") {
    respond(id, {
      tools: [
        {
          name: "probe_report",
          description:
            "Report the launch environment of this plugin-bundled MCP server: " +
            "argv, cwd, env subset, and whether ${PLUGIN_ROOT} was expanded in " +
            "command, args, and env. Read-only; changes nothing.",
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
    });
    return;
  }
  if (method === "tools/call") {
    if (message.params?.name !== "probe_report") {
      respondError(id, -32602, `unknown tool: ${message.params?.name}`);
      return;
    }
    respond(id, {
      content: [{ type: "text", text: JSON.stringify(buildReport(), null, 2) }],
      isError: false,
    });
    return;
  }
  if (id !== undefined && id !== null) {
    respondError(id, -32601, `method not found: ${method}`);
  }
}

function dispatch(raw) {
  const text = raw.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    process.stderr.write(`[probe:${entry}] unparseable message ignored\n`);
    return;
  }
  try {
    handle(message);
  } catch (error) {
    process.stderr.write(`[probe:${entry}] handler error: ${error.message}\n`);
  }
}

// Accept both MCP stdio framings and reply in kind: newline-delimited JSON
// (current spec) or LSP-style Content-Length headers. JSON bodies begin with
// "{", so the first byte received decides.
let buf = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  if (framing === null && buf.length > 0) {
    framing = buf.toString("utf8", 0, 1) === "{" ? "newline" : "headers";
    process.stderr.write(`[probe:${entry}] framing=${framing}\n`);
  }
  if (framing === "newline") {
    let newline;
    while ((newline = buf.indexOf("\n")) !== -1) {
      const line = buf.toString("utf8", 0, newline);
      buf = buf.subarray(newline + 1);
      dispatch(line);
    }
  } else if (framing === "headers") {
    for (;;) {
      const sep = buf.indexOf("\r\n\r\n");
      if (sep === -1) break;
      const header = buf.toString("utf8", 0, sep);
      const match = /content-length:\s*(\d+)/i.exec(header);
      const length = match ? Number(match[1]) : 0;
      const start = sep + 4;
      if (buf.length < start + length) break;
      const body = buf.toString("utf8", start, start + length);
      buf = buf.subarray(start + length);
      dispatch(body);
    }
  }
});
process.stdin.on("end", () => process.exit(0));
