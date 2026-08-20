#!/usr/bin/env node
import { chmod, lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJsonV1, validateGoldenImageReservationV1 } from "./build-golden-image.mjs";
import { validateGoldenBuilderLifecycleBindingV1 } from "./prepare-golden-builder.mjs";
import {
  createGoldenBuilderSshTransportsV1,
  ProxmoxGoldenBuilderAdapterV1,
  validateGoldenBuilderTransportAccessV1,
} from "./golden-builder-proxmox-transport.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url);
const OPERATIONS = new Set(["confirm-absent", "destroy", "observe", "preflight", "provision", "quarantine", "stop"]);
const MUTATIONS = new Set(["destroy", "provision", "quarantine", "stop"]);
const CLEANUP_OPERATIONS = new Set(["confirm-absent", "destroy", "observe", "quarantine", "stop"]);

class ControlError extends Error {
  constructor(code, message) { super(message); this.name = "GoldenBuilderControlError"; this.code = code; }
}

function fail(code, message) { throw new ControlError(code, message); }
function exact(value, fields, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) fail("INVALID_CONTRACT", `${label} fields differ`);
  return value;
}

async function sealedJson(path, label) {
  const absolute = resolve(path); let info;
  try { info = await lstat(absolute); } catch { fail("SEALED_INPUT_UNAVAILABLE", `${label} is unavailable`); }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !new Set([0o400, 0o440, 0o600, 0o640]).has(info.mode & 0o777)) fail("UNTRUSTED_INPUT", `${label} is not sealed`);
  const bytes = await readFile(absolute); let value;
  try { value = JSON.parse(bytes); } catch { fail("INVALID_JSON", `${label} is not valid JSON`); }
  if (!bytes.equals(Buffer.from(`${canonicalJsonV1(value)}\n`))) fail("NONCANONICAL_INPUT", `${label} is not canonical JSON`);
  return value;
}

async function receiptStore(root) {
  if (!isAbsolute(root) || basename(root).startsWith(".")) fail("UNSAFE_PATH", "receipt root must be one explicit absolute path");
  const canonicalRoot = await realpath(root).catch(() => null); const info = canonicalRoot ? await lstat(canonicalRoot).catch(() => null) : null;
  if (!canonicalRoot || !info?.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || info.uid !== process.getuid()) fail("UNSAFE_PATH", "receipt root must be a private caller-owned canonical directory");
  return {
    async commit(receipt) {
      const path = join(canonicalRoot, `${receipt.receiptDigest.slice(7)}.json`);
      const bytes = Buffer.from(`${canonicalJsonV1(receipt)}\n`);
      try {
        const handle = await open(path, "wx", 0o400);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await chmod(path, 0o400);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const existing = await lstat(path); const current = await readFile(path);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.uid !== process.getuid() || (existing.mode & 0o777) !== 0o400 || !current.equals(bytes)) fail("RECEIPT_STORE_CONFLICT", "content-addressed provider receipt differs");
      }
      return path;
    },
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--help") return { help: true };
    if (!new Set(["--access", "--authorize-binding", "--lifecycle", "--operation", "--receipt-dir"]).has(name) || values[name] !== undefined || !argv[index + 1]) fail("INVALID_OPERATION", "golden-builder control arguments are invalid");
    values[name] = argv[index + 1]; index += 1;
  }
  for (const name of ["--access", "--lifecycle", "--operation", "--receipt-dir"]) if (!values[name]) fail("INVALID_OPERATION", `${name} is required`);
  if (!OPERATIONS.has(values["--operation"])) fail("INVALID_OPERATION", "operation is not allowlisted");
  return values;
}

export async function runGoldenBuilderControlV1({ lifecyclePath, accessPath, receiptDir, operation, authorizeBinding = null }, { createTransports = createGoldenBuilderSshTransportsV1, clock = Date } = {}) {
  const [lifecycle, access] = await Promise.all([sealedJson(lifecyclePath, "builder lifecycle"), sealedJson(accessPath, "transport access")]);
  exact(lifecycle, ["builderLifecycleBinding", "reservation", "schemaVersion"], "builder lifecycle envelope");
  if (lifecycle.schemaVersion !== 1) fail("INVALID_CONTRACT", "builder lifecycle envelope is unsupported");
  const cleanup = CLEANUP_OPERATIONS.has(operation); const now = clock.now();
  const reservation = validateGoldenImageReservationV1(lifecycle.reservation, { now, allowExpiredForCleanup: cleanup });
  const binding = validateGoldenBuilderLifecycleBindingV1(lifecycle.builderLifecycleBinding, reservation, { now, allowExpiredForCleanup: cleanup });
  validateGoldenBuilderTransportAccessV1(access);
  if (MUTATIONS.has(operation) && authorizeBinding !== binding.bindingDigest) fail("MUTATION_AUTHORIZATION_REQUIRED", "mutation requires the exact lifecycle binding digest");
  if (!MUTATIONS.has(operation) && authorizeBinding !== null) fail("INVALID_OPERATION", "read-only operations do not accept mutation authorization");
  if (typeof createTransports !== "function" || typeof clock?.now !== "function") fail("INVALID_ADAPTER", "controller transport or clock boundary is invalid");
  const transports = await createTransports({ access, clock });
  const adapter = new ProxmoxGoldenBuilderAdapterV1({
    lifecycleBinding: binding, reservation, ...transports, receiptStore: await receiptStore(receiptDir),
    operationTimeoutMs: access.limits.operationTimeoutMs, transportAttempts: access.limits.transportAttempts, clock, allowExpiredForCleanup: cleanup,
  });
  const method = operation === "confirm-absent" ? "confirmAbsent" : operation;
  const result = await adapter[method](binding);
  return Object.freeze({ schemaVersion: 1, bindingDigest: binding.bindingDigest, operation, result });
}

async function cli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("usage: golden-builder-control.mjs --lifecycle FILE --access FILE --receipt-dir DIR --operation OP [--authorize-binding sha256:...]\n");
    return;
  }
  const result = await runGoldenBuilderControlV1({ lifecyclePath: args["--lifecycle"], accessPath: args["--access"], receiptDir: args["--receipt-dir"], operation: args["--operation"], authorizeBinding: args["--authorize-binding"] ?? null });
  process.stdout.write(`${canonicalJsonV1(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === MODULE_PATH) cli().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error?.code ?? "GOLDEN_BUILDER_CONTROL_FAILED", message: error?.message ?? "golden-builder control failed" })}\n`);
  process.exitCode = 1;
});
