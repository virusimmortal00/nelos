#!/usr/bin/env node
import { chmod, lstat, open, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJsonV1, validateGoldenImageReservationV1 } from "./build-golden-image.mjs";
import { GoldenBuilderGatewayPolicyAdapterV1, validateGoldenBuilderGatewayPolicyBindingV1 } from "./golden-builder-gateway-policy.mjs";
import { createGoldenBuilderGatewaySshTransportsV1, validateGoldenBuilderGatewayTransportAccessV1 } from "./golden-builder-gateway-qga-transport.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url);
const OPERATIONS = new Set(["apply", "confirm-restored", "observe", "preflight", "restore"]);
const MUTATIONS = new Set(["apply", "restore"]);

class ControlError extends Error {
  constructor(code, message) { super(message); this.name = "GoldenBuilderGatewayControlError"; this.code = code; }
}

function fail(code, message) { throw new ControlError(code, message); }

async function sealedJson(path, label) {
  const absolute = resolve(path); const info = await lstat(absolute).catch(() => null); const canonical = info ? await realpath(absolute).catch(() => null) : null;
  if (!info || canonical !== absolute || !info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !new Set([0o400, 0o440, 0o600, 0o640]).has(info.mode & 0o777)) fail("UNTRUSTED_INPUT", `${label} is not one sealed canonical file`);
  const bytes = await readFile(canonical); let value;
  try { value = JSON.parse(bytes); } catch { fail("INVALID_JSON", `${label} is not JSON`); }
  if (!bytes.equals(Buffer.from(`${canonicalJsonV1(value)}\n`))) fail("NONCANONICAL_INPUT", `${label} is not canonical JSON`);
  return value;
}

async function contentAddressedStore(root) {
  if (!isAbsolute(root) || basename(root).startsWith(".")) fail("UNSAFE_PATH", "gateway receipt root must be an explicit absolute path");
  const canonical = await realpath(root).catch(() => null); const info = canonical ? await lstat(canonical).catch(() => null) : null;
  if (!canonical || canonical !== root || !info?.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) fail("UNSAFE_PATH", "gateway receipt root must be caller-owned mode 0700");
  return {
    async commit(receipt) {
      const path = join(canonical, `${receipt.receiptDigest.slice(7)}.json`); const bytes = Buffer.from(`${canonicalJsonV1(receipt)}\n`);
      try {
        const handle = await open(path, "wx", 0o400);
        try { await handle.writeFile(bytes); await handle.sync(); await handle.chmod(0o400); } finally { await handle.close(); }
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        const existing = await lstat(path); const current = await readFile(path);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1 || existing.uid !== process.getuid() || (existing.mode & 0o777) !== 0o400 || !current.equals(bytes)) fail("RECEIPT_STORE_CONFLICT", "gateway receipt content address conflicts");
      }
      await chmod(path, 0o400);
      return path;
    },
  };
}

function cleanupValidationNow(reservation, now) {
  const expiry = Date.parse(reservation?.expiresAt);
  return Number.isFinite(expiry) && Number.isSafeInteger(reservation?.maxBuildMs) ? Math.min(now, expiry - reservation.maxBuildMs - 120_001) : now;
}

export async function runGoldenBuilderGatewayControlV1({ reservationPath, policyPath, accessPath, receiptDir, operation, authorizeBinding = null }, {
  createTransports = createGoldenBuilderGatewaySshTransportsV1, clock = Date,
} = {}) {
  if (!OPERATIONS.has(operation)) fail("INVALID_OPERATION", "gateway operation is not allowlisted");
  const cleanup = new Set(["restore", "confirm-restored"]).has(operation); const now = clock.now();
  const [reservationInput, policyInput, access] = await Promise.all([sealedJson(reservationPath, "reservation"), sealedJson(policyPath, "gateway policy"), sealedJson(accessPath, "gateway transport access")]);
  const reservation = validateGoldenImageReservationV1(reservationInput, { now: cleanup ? cleanupValidationNow(reservationInput, now) : now });
  const binding = validateGoldenBuilderGatewayPolicyBindingV1(policyInput, reservation, { now, allowExpired: cleanup });
  validateGoldenBuilderGatewayTransportAccessV1(access);
  if (MUTATIONS.has(operation) && authorizeBinding !== binding.bindingDigest) fail("MUTATION_AUTHORIZATION_REQUIRED", "gateway mutation requires the exact policy binding digest");
  if (!MUTATIONS.has(operation) && authorizeBinding !== null) fail("INVALID_OPERATION", "gateway read operation does not accept mutation authorization");
  const transports = await createTransports({ access, policyBinding: binding, reservation, clock, allowExpiredBinding: cleanup });
  const adapter = new GoldenBuilderGatewayPolicyAdapterV1({
    binding, reservation, ...transports, receiptStore: await contentAddressedStore(receiptDir), clock,
    operationTimeoutMs: access.limits.operationTimeoutMs, transportAttempts: access.limits.transportAttempts, allowExpiredBinding: cleanup,
  });
  const method = operation === "confirm-restored" ? "confirmRestored" : operation;
  const result = await adapter[method](binding);
  return Object.freeze({ schemaVersion: 1, bindingDigest: binding.bindingDigest, operation, result });
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--help") return { help: true };
    const value = argv[index + 1];
    if (!value || !new Set(["--access", "--authorize-binding", "--operation", "--policy", "--receipt-dir", "--reservation"]).has(argv[index]) || values[argv[index]]) fail("INVALID_OPERATION", "gateway control arguments are invalid");
    values[argv[index]] = value; index += 1;
  }
  for (const required of ["--access", "--operation", "--policy", "--receipt-dir", "--reservation"]) if (!values[required]) fail("INVALID_OPERATION", `${required} is required`);
  return values;
}

async function cli() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write("usage: golden-builder-gateway-control.mjs --reservation FILE --policy FILE --access FILE --receipt-dir DIR --operation OP [--authorize-binding sha256:...]\n");
    return;
  }
  const result = await runGoldenBuilderGatewayControlV1({ reservationPath: resolve(args["--reservation"]), policyPath: resolve(args["--policy"]), accessPath: resolve(args["--access"]), receiptDir: resolve(args["--receipt-dir"]), operation: args["--operation"], authorizeBinding: args["--authorize-binding"] ?? null });
  process.stdout.write(`${canonicalJsonV1(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === MODULE_PATH) cli().catch((error) => {
  process.stderr.write(`${canonicalJsonV1({ error: error?.code ?? "GATEWAY_CONTROL_FAILED", message: error?.message ?? "gateway control failed" })}\n`);
  process.exitCode = 1;
});
