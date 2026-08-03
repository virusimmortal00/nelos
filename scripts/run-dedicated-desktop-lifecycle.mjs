#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { runDedicatedDesktopAction } from "../src/dedicated-desktop-runtime.mjs";

const TRUSTED_DRIVER = "/Library/NelosDesktopWorker/automation-driver.mjs";
const REQUEST_ROOT = "/Library/NelosDesktopWorker/requests";

function argumentsFrom(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("arguments must be --name value pairs");
    result[key.slice(2)] = value;
  }
  return result;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const args = argumentsFrom(argv);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(args["request-id"] ?? "")) throw new Error("invalid request id");
  if (!/^sha256:[0-9a-f]{64}$/u.test(args["request-digest"] ?? "")) throw new Error("invalid request digest");
  const requestPath = resolve(REQUEST_ROOT, `${args["request-id"]}.json`);
  if (!requestPath.startsWith(`${REQUEST_ROOT}/`)) throw new Error("request escapes the trusted request root");
  const bytes = await (dependencies.readFile ?? readFile)(requestPath);
  const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  if (digest !== args["request-digest"]) throw new Error("request digest mismatch");
  const request = JSON.parse(bytes);
  if (request.action !== args.action || request.lease?.leaseId !== args["lease-id"] || request.worker?.hostId !== args["host-id"]) {
    throw new Error("workflow inputs do not match the sealed Desktop request");
  }
  if (request.expectedGoldenImageDigest !== args["golden-image-digest"]) throw new Error("workflow golden image does not match the sealed request");
  const driverModule = dependencies.driverModule ?? await import(pathToFileURL(TRUSTED_DRIVER));
  if (typeof driverModule.createDedicatedDesktopAdapter !== "function") throw new Error("trusted Desktop automation driver is invalid");
  const adapter = await driverModule.createDedicatedDesktopAdapter({ request });
  const receipt = await runDedicatedDesktopAction(request, adapter);
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  return receipt;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.code ? `${error.code}: ` : ""}${error.message}\n`);
    process.exitCode = 1;
  });
}

