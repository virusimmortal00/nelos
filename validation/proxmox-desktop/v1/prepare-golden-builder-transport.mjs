#!/usr/bin/env node
import { chmod, link, lstat, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJsonV1, sha256V1, validateGoldenImageReservationV1 } from "./build-golden-image.mjs";
import { validateGoldenBuilderLifecycleBindingV1 } from "./prepare-golden-builder.mjs";
import {
  createGoldenBuilderHostBindingV1,
  createGoldenBuilderHostInstallPlanV1,
  validateGoldenBuilderTransportAccessV1,
} from "./golden-builder-proxmox-transport.mjs";

const MODULE_PATH = fileURLToPath(import.meta.url);
const HELPER_PATH = resolve(dirname(MODULE_PATH), "nelos-proxmox-golden-builder-helper.py");

class PreparationError extends Error {
  constructor(code, message) { super(message); this.name = "GoldenBuilderTransportPreparationError"; this.code = code; }
}

function fail(code, message) { throw new PreparationError(code, message); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, fields, label) {
  if (!plain(value) || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) fail("INVALID_CONTRACT", `${label} fields differ from the closed contract`);
  return value;
}

async function sealedJson(path, label) {
  const absolute = resolve(path);
  let info;
  try { info = await lstat(absolute); } catch { fail("SEALED_INPUT_UNAVAILABLE", `${label} is unavailable`); }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || !new Set([0o400, 0o440, 0o600, 0o640]).has(info.mode & 0o777)) fail("UNTRUSTED_INPUT", `${label} is not one sealed regular file`);
  const bytes = await readFile(absolute);
  if (bytes.length < 3 || bytes.length > 1_048_576) fail("UNTRUSTED_INPUT", `${label} size is invalid`);
  let value;
  try { value = JSON.parse(bytes); } catch { fail("INVALID_JSON", `${label} is not valid JSON`); }
  if (!bytes.equals(Buffer.from(`${canonicalJsonV1(value)}\n`))) fail("NONCANONICAL_INPUT", `${label} must be canonical JSON with one final newline`);
  return value;
}

async function writeExclusive(path, bytes, mode) {
  if (!isAbsolute(path) || basename(path).startsWith(".")) fail("UNSAFE_PATH", "output path must be one explicit absolute path");
  const canonicalParent = await realpath(dirname(path)).catch(() => null);
  const parentInfo = canonicalParent ? await lstat(canonicalParent).catch(() => null) : null;
  if (!canonicalParent || !parentInfo?.isDirectory() || parentInfo.isSymbolicLink() || (parentInfo.mode & 0o077) !== 0) fail("UNSAFE_PATH", "output parent must be a canonical private directory");
  const temporary = `${path}.${sha256V1(bytes).slice(7, 23)}.tmp`;
  const handle = await open(temporary, "wx", mode);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
  await chmod(temporary, mode);
  try { await link(temporary, path); } finally { await unlink(temporary).catch(() => {}); }
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index]; const value = argv[index + 1];
    if (!value || !new Set(["--access", "--host-binding-output", "--known-hosts-output", "--lifecycle", "--plan-output"]).has(name) || values[name]) fail("INVALID_OPERATION", "transport preparation arguments are invalid");
    values[name] = value;
  }
  if (Object.keys(values).length !== 5) fail("INVALID_OPERATION", "every transport input and output is required");
  return values;
}

export async function prepareGoldenBuilderTransportV1({ lifecyclePath, accessPath, hostBindingOutput, planOutput, knownHostsOutput }, { now = Date.now() } = {}) {
  const [lifecycle, access] = await Promise.all([sealedJson(lifecyclePath, "builder lifecycle"), sealedJson(accessPath, "transport access")]);
  exact(lifecycle, ["builderLifecycleBinding", "reservation", "schemaVersion"], "builder lifecycle envelope");
  if (lifecycle.schemaVersion !== 1) fail("INVALID_CONTRACT", "builder lifecycle envelope version is unsupported");
  const reservation = validateGoldenImageReservationV1(lifecycle.reservation, { now });
  validateGoldenBuilderLifecycleBindingV1(lifecycle.builderLifecycleBinding, reservation, { now });
  validateGoldenBuilderTransportAccessV1(access);
  if (sha256V1(await readFile(HELPER_PATH)) !== access.helperDigest) fail("HELPER_IDENTITY_MISMATCH", "transport access does not bind this exact forced-helper implementation");
  if (resolve(knownHostsOutput) !== resolve(access.host.knownHostsFile)) fail("INVALID_CONTRACT", "known-hosts output path differs from the transport access binding");
  const hostBinding = createGoldenBuilderHostBindingV1({ lifecycleBinding: lifecycle.builderLifecycleBinding, reservation, access }, { now });
  const plan = createGoldenBuilderHostInstallPlanV1({ hostBinding, access });
  await writeExclusive(resolve(hostBindingOutput), Buffer.from(`${canonicalJsonV1(hostBinding)}\n`), 0o400);
  try {
    await writeExclusive(resolve(planOutput), Buffer.from(`${canonicalJsonV1(plan)}\n`), 0o400);
    await writeExclusive(resolve(knownHostsOutput), Buffer.from(plan.knownHostsLine), 0o600);
  } catch (error) {
    // Outputs are deliberately not rolled back: an operator must inspect a partial
    // preparation rather than allow an automatic replacement of trusted bytes.
    throw error;
  }
  return Object.freeze({ hostBindingDigest: hostBinding.hostBindingDigest, planDigest: plan.planDigest, knownHostsDigest: sha256V1(Buffer.from(plan.knownHostsLine)) });
}

async function cli() {
  const args = parseArgs(process.argv.slice(2));
  const receipt = await prepareGoldenBuilderTransportV1({
    lifecyclePath: resolve(args["--lifecycle"]), accessPath: resolve(args["--access"]),
    hostBindingOutput: resolve(args["--host-binding-output"]), planOutput: resolve(args["--plan-output"]), knownHostsOutput: resolve(args["--known-hosts-output"]),
  });
  process.stdout.write(`${canonicalJsonV1(receipt)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === MODULE_PATH) cli().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: error?.code ?? "GOLDEN_BUILDER_TRANSPORT_PREPARATION_FAILED", message: error?.message ?? "golden builder transport preparation failed" })}\n`);
  process.exitCode = 1;
});
