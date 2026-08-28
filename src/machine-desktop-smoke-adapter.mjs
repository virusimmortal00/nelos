import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";

import { DesktopSmokeError } from "./disposable-desktop-smoke.mjs";

export const DEFAULT_DESKTOP_SMOKE_DRIVER = "/usr/local/libexec/nelos-desktop-test-driver";
const OPERATIONS = new Set(["clone-template", "install-candidate", "launch-desktop", "read-loaded-identity", "run-scenario", "collect-evidence", "destroy-clone", "verify-absent"]);
const FRESH_VM_OPERATIONS = new Set(["clone-template-vm", "cleanup-clone-attempt-vm", "install-candidate-vm", "read-loaded-identity-vm", "execute-scenario-vm", "package-evidence-vm", "destroy-clone-vm", "verify-absent-vm"]);
const REVIEW_OPERATION = "review-sanitized-bundle";
const ERROR_CODE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
export const PROXMOX_CLONE_PROCESS_LIMITS_V1 = Object.freeze({
  primaryMs: 70 * 60_000,
  cleanupMs: 28 * 60_000,
  cleanupSettlementMs: 20 * 60_000,
  controllerMs: 100 * 60_000,
});

async function verifyDriver(path) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0) {
    throw new DesktopSmokeError("DESKTOP_DRIVER_UNAVAILABLE", "the fixed machine-local Desktop smoke driver is absent or not trusted");
  }
}

export function parseMachineDesktopDriverResponseV1({ status, stdout, operation }) {
  if (!Number.isInteger(status) || typeof stdout !== "string" || typeof operation !== "string") throw new DesktopSmokeError("DESKTOP_DRIVER_FAILED", "machine-local Desktop smoke driver response framing is invalid");
  let value;
  try { value = JSON.parse(stdout); }
  catch { throw new DesktopSmokeError("DESKTOP_DRIVER_FAILED", status === 0 ? "machine-local Desktop smoke driver returned invalid JSON" : `machine-local Desktop smoke driver failed during ${operation}`); }
  if (status === 0) return value;
  const rootFields = value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
  const errorFields = value?.error && typeof value.error === "object" && !Array.isArray(value.error) ? Object.keys(value.error).sort() : [];
  const details = value?.error?.details;
  const detailFields = details && typeof details === "object" && !Array.isArray(details) ? Object.keys(details).sort() : [];
  const detailsValid = details === null || (detailFields.length >= 1 && detailFields.length <= 2 && detailFields.every((field) => ["cleanupDisposition", "retryDisposition"].includes(field)) && detailFields.includes("retryDisposition") && ["safe_before_dispatch", "ambiguous_after_dispatch"].includes(details.retryDisposition) && (!detailFields.includes("cleanupDisposition") || details.cleanupDisposition === "proven_absent"));
  if (rootFields.join(",") !== "error,schemaVersion" || value.schemaVersion !== 1 || errorFields.join(",") !== "code,details,message" || !ERROR_CODE.test(value.error.code) || typeof value.error.message !== "string" || value.error.message.length < 1 || value.error.message.length > 240 || !detailsValid) throw new DesktopSmokeError("DESKTOP_DRIVER_FAILED", `machine-local Desktop smoke driver returned a malformed error during ${operation}`);
  throw new DesktopSmokeError(value.error.code, value.error.message, details === null ? null : Object.freeze({ retryDisposition: details.retryDisposition, ...(details.cleanupDisposition ? { cleanupDisposition: details.cleanupDisposition } : {}) }));
}

async function invoke(path, operation, payload, { timeoutMs = 15 * 60 * 1_000, maxOutputBytes = 1024 * 1024, workingDirectory = undefined } = {}) {
  if (!OPERATIONS.has(operation) && !FRESH_VM_OPERATIONS.has(operation) && operation !== REVIEW_OPERATION) throw new DesktopSmokeError("INVALID_SMOKE_ADAPTER", "unsupported machine-driver operation");
  await verifyDriver(path);
  return new Promise((resolve, reject) => {
    const child = spawn(path, [operation], {
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      stdio: ["pipe", "pipe", "ignore"],
      cwd: workingDirectory,
      detached: process.platform !== "win32",
    });
    let settled = false;
    let timer;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    timer = setTimeout(() => {
      try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); }
      finish(new DesktopSmokeError("DESKTOP_DRIVER_FAILED", `machine-local Desktop smoke driver exceeded its deadline during ${operation}`));
    }, timeoutMs);
    timer.unref?.();
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > maxOutputBytes) {
        try { if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { child.kill("SIGKILL"); }
        finish(new DesktopSmokeError("DESKTOP_DRIVER_FAILED", "machine-local Desktop smoke driver returned an oversized receipt"));
      }
    });
    child.once("error", () => finish(new DesktopSmokeError("DESKTOP_DRIVER_FAILED", "machine-local Desktop smoke driver could not start")));
    child.once("close", (status) => {
      try { finish(null, parseMachineDesktopDriverResponseV1({ status, stdout, operation })); }
      catch (error) { finish(error); }
    });
    child.stdin.on("error", () => finish(new DesktopSmokeError("DESKTOP_DRIVER_FAILED", `machine-local Desktop smoke driver closed its input during ${operation}`)));
    child.stdin.end(`${JSON.stringify({ schemaVersion: 1, operation, payload })}\n`);
  });
}

export function createMachineDesktopSmokeAdapterV1({ executable = DEFAULT_DESKTOP_SMOKE_DRIVER } = {}) {
  return Object.freeze({
    cloneTemplate: (payload) => invoke(executable, "clone-template", payload),
    installCandidate: (payload) => invoke(executable, "install-candidate", payload),
    launchDesktop: (payload) => invoke(executable, "launch-desktop", payload),
    readLoadedIdentity: (payload) => invoke(executable, "read-loaded-identity", payload),
    runScenario: (payload) => invoke(executable, "run-scenario", payload),
    collectEvidence: (payload) => invoke(executable, "collect-evidence", payload),
    destroyClone: (payload) => invoke(executable, "destroy-clone", payload),
    verifyAbsent: (payload) => invoke(executable, "verify-absent", payload),
  });
}

function fresh(path, operation, payload, options = {}) {
  return invoke(path, operation, payload, options).then((receipt) => {
    if (operation === "package-evidence-vm") {
      if (typeof receipt?.bundleBase64 !== "string" || Object.keys(receipt).some((key) => /raw|temporaryFiles|sourcePixels|sensitive/iu.test(key))) throw new DesktopSmokeError("UNSAFE_FRESH_VM_EVIDENCE", "machine driver returned unsafe or malformed package data");
      const { bundleBase64, ...rest } = receipt;
      return { ...rest, bundle: Buffer.from(bundleBase64, "base64") };
    }
    return receipt;
  });
}

function validateCloneCleanupReceipt(receipt, runId) {
  const fields = receipt && typeof receipt === "object" && !Array.isArray(receipt) ? Object.keys(receipt).sort() : [];
  if (fields.join(",") !== "absent,destructionDisposition,independent,runId" || receipt.runId !== runId || !["destroyed", "not_present_after_settlement"].includes(receipt.destructionDisposition) || receipt.absent !== true || receipt.independent !== true) throw new DesktopSmokeError("CLEANUP_NOT_PROVEN", "adapter-owned clone cleanup did not prove exact destruction or settled independent absence");
}

async function cloneWithFallback(path, payload, timing) {
  try {
    return await fresh(path, "clone-template-vm", payload, { timeoutMs: timing.primaryMs, workingDirectory: timing.workingDirectory });
  } catch (primary) {
    if (primary?.details?.retryDisposition === "safe_before_dispatch" || primary?.details?.cleanupDisposition === "proven_absent") throw primary;
    try {
      const cleanup = await fresh(path, "cleanup-clone-attempt-vm", { operationId: `${payload.operationId}:adapter-cleanup`, runId: payload.runId, settlementMs: timing.cleanupSettlementMs }, { timeoutMs: timing.cleanupMs, workingDirectory: timing.workingDirectory });
      validateCloneCleanupReceipt(cleanup, payload.runId);
    } catch (cleanupError) {
      throw new DesktopSmokeError("CLEANUP_NOT_PROVEN", "adapter-owned cleanup failed after an uncertain clone driver exit", { primaryCode: primary?.code ?? "DESKTOP_DRIVER_FAILED", cleanupCode: cleanupError?.code ?? "DESKTOP_DRIVER_FAILED" });
    }
    throw primary;
  }
}

function freshVmAdapter({ executable, timing }) {
  return Object.freeze({
    cloneControllerMinimumMs: timing.primaryMs + timing.cleanupMs + 60_000,
    cloneTemplate: (payload) => cloneWithFallback(executable, payload, timing),
    installCandidate: (payload) => fresh(executable, "install-candidate-vm", payload),
    readLoadedIdentity: (payload) => fresh(executable, "read-loaded-identity-vm", payload),
    executeScenario: (payload) => fresh(executable, "execute-scenario-vm", payload, { timeoutMs: payload.deadlines.scenarioMs + 5_000 }),
    packageEvidence: (payload) => fresh(executable, "package-evidence-vm", payload, { maxOutputBytes: 24 * 1024 * 1024 }),
    destroyClone: (payload) => fresh(executable, "destroy-clone-vm", payload),
    verifyAbsent: (payload) => fresh(executable, "verify-absent-vm", payload),
  });
}

export function createMachineFreshVmDesktopAdapterV1({ executable = DEFAULT_DESKTOP_SMOKE_DRIVER } = {}) {
  return freshVmAdapter({ executable, timing: { ...PROXMOX_CLONE_PROCESS_LIMITS_V1, workingDirectory: undefined } });
}

export function createMachineFreshVmDesktopAdapterTestV1({ executable, workingDirectory, primaryMs, cleanupMs, cleanupSettlementMs }) {
  for (const value of [primaryMs, cleanupMs, cleanupSettlementMs]) if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) throw new DesktopSmokeError("INVALID_SMOKE_ADAPTER", "test process timing is invalid");
  return freshVmAdapter({ executable, timing: { primaryMs, cleanupMs, cleanupSettlementMs, workingDirectory } });
}

// The trusted driver is the only model-capable boundary.  It receives the
// already-sanitized review context, never a guest filesystem or controller env.
export function createMachineDesktopBundleReviewerV1({ executable = DEFAULT_DESKTOP_SMOKE_DRIVER } = {}) {
  return Object.freeze({
    reviewerId: "machine-sanitized-desktop-reviewer-v1",
    review: (context) => invoke(executable, REVIEW_OPERATION, context, { timeoutMs: 5 * 60 * 1_000, maxOutputBytes: 256 * 1024 }),
  });
}
