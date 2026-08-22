#!/usr/bin/env node
import { chmod, link, lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJsonV1, sha256V1, validateGoldenImageReservationV1 } from "./build-golden-image.mjs";
import { validateGoldenBuilderGatewayPolicyBindingV1 } from "./golden-builder-gateway-policy.mjs";
import {
  createGoldenBuilderGatewayHostBindingV1,
  createGoldenBuilderGatewayHostInstallPlanV1,
  validateGoldenBuilderGatewayTransportAccessV1,
} from "./golden-builder-gateway-qga-transport.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url);
const HOST_HELPER = resolve(dirname(MODULE_PATH), "nelos-proxmox-golden-gateway-transport.py");
const GUEST_HELPER = resolve(dirname(MODULE_PATH), "nelos-golden-gateway-policy.py");

class PreparationError extends Error {
  constructor(code, message) { super(message); this.name = "GoldenBuilderGatewayTransportPreparationError"; this.code = code; }
}

function fail(code, message) { throw new PreparationError(code, message); }

async function sealedJson(path, label) {
  if (!isAbsolute(path) || resolve(path) !== path) fail("UNSAFE_PATH", `${label} path must be absolute and canonical`);
  const canonical = await realpath(path).catch(() => null); const info = canonical ? await lstat(canonical).catch(() => null) : null;
  if (!canonical || canonical !== path || !info?.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !new Set([0o400, 0o440, 0o600, 0o640]).has(info.mode & 0o777)) fail("UNSAFE_PATH", `${label} is not one sealed regular file`);
  const bytes = await readFile(canonical); let value;
  try { value = JSON.parse(bytes); } catch { fail("INVALID_CONTRACT", `${label} is not JSON`); }
  if (!bytes.equals(Buffer.from(`${canonicalJsonV1(value)}\n`))) fail("INVALID_CONTRACT", `${label} is not canonical JSON`);
  return value;
}

async function writeExclusive(path, bytes, mode) {
  if (!isAbsolute(path) || resolve(path) !== path || basename(path).startsWith(".")) fail("UNSAFE_PATH", "output path must be absolute and canonical");
  const parent = await realpath(dirname(path)).catch(() => null); const info = parent ? await lstat(parent).catch(() => null) : null;
  if (!parent || parent !== dirname(path) || !info?.isDirectory() || info.isSymbolicLink() || (info.mode & 0o077) !== 0) fail("UNSAFE_PATH", "output parent must be a private canonical directory");
  const temporary = `${path}.${sha256V1(bytes).slice(7, 23)}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try { await handle.writeFile(bytes); await handle.sync(); await handle.chmod(mode); } finally { await handle.close(); }
  try { await link(temporary, path); } finally { await unlink(temporary).catch(() => {}); }
}

export async function prepareGoldenBuilderGatewayTransportV1({ reservationPath, policyPath, accessPath, hostBindingOutput, planOutput, knownHostsOutput }, { now = Date.now() } = {}) {
  const [reservationInput, policy, access] = await Promise.all([sealedJson(reservationPath, "reservation"), sealedJson(policyPath, "gateway policy"), sealedJson(accessPath, "gateway transport access")]);
  const reservation = validateGoldenImageReservationV1(reservationInput, { now });
  validateGoldenBuilderGatewayPolicyBindingV1(policy, reservation, { now });
  validateGoldenBuilderGatewayTransportAccessV1(access);
  const [hostHelperBytes, guestHelperBytes] = await Promise.all([readFile(HOST_HELPER), readFile(GUEST_HELPER)]);
  if (sha256V1(hostHelperBytes) !== access.hostHelperDigest || sha256V1(guestHelperBytes) !== policy.helper.digest) fail("HELPER_IDENTITY_MISMATCH", "gateway host or guest helper bytes differ from the sealed binding");
  if (resolve(knownHostsOutput) !== resolve(access.host.knownHostsFile)) fail("INVALID_CONTRACT", "known-hosts output differs from gateway transport access");
  const hostBinding = createGoldenBuilderGatewayHostBindingV1({ policyBinding: policy, reservation, access }, { now });
  const plan = createGoldenBuilderGatewayHostInstallPlanV1({ hostBinding, access });
  await writeExclusive(resolve(hostBindingOutput), Buffer.from(`${canonicalJsonV1(hostBinding)}\n`), 0o400);
  await writeExclusive(resolve(planOutput), Buffer.from(`${canonicalJsonV1(plan)}\n`), 0o400);
  await writeExclusive(resolve(knownHostsOutput), Buffer.from(plan.knownHostsLine), 0o600);
  return { hostBindingDigest: hostBinding.hostBindingDigest, planDigest: plan.planDigest, policyBindingDigest: policy.bindingDigest };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!value || !new Set(["--access", "--host-binding-output", "--known-hosts-output", "--plan-output", "--policy", "--reservation"]).has(name) || values[name]) fail("INVALID_OPERATION", "gateway transport preparation arguments are invalid");
    values[name] = value;
  }
  if (Object.keys(values).length !== 6) fail("INVALID_OPERATION", "every gateway transport preparation argument is required");
  return values;
}

async function cli() {
  const options = parseArgs(process.argv.slice(2));
  const result = await prepareGoldenBuilderGatewayTransportV1({
    reservationPath: resolve(options["--reservation"]), policyPath: resolve(options["--policy"]), accessPath: resolve(options["--access"]),
    hostBindingOutput: resolve(options["--host-binding-output"]), planOutput: resolve(options["--plan-output"]), knownHostsOutput: resolve(options["--known-hosts-output"]),
  });
  process.stdout.write(`${canonicalJsonV1(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === MODULE_PATH) cli().catch((error) => {
  process.stderr.write(`${canonicalJsonV1({ error: error?.code ?? "GATEWAY_TRANSPORT_PREPARATION_FAILED", message: error?.message ?? "gateway transport preparation failed" })}\n`);
  process.exitCode = 1;
});
