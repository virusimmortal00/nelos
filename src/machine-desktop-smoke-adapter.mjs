import { spawn } from "node:child_process";
import { lstat } from "node:fs/promises";

import { DesktopSmokeError } from "./disposable-desktop-smoke.mjs";

export const DEFAULT_DESKTOP_SMOKE_DRIVER = "/usr/local/libexec/nelos-desktop-test-driver";
const OPERATIONS = new Set(["clone-template", "install-candidate", "launch-desktop", "read-loaded-identity", "run-scenario", "collect-evidence", "destroy-clone", "verify-absent"]);

async function verifyDriver(path) {
  const info = await lstat(path).catch(() => null);
  if (!info?.isFile() || info.isSymbolicLink() || info.uid !== 0 || (info.mode & 0o022) !== 0 || (info.mode & 0o111) === 0) {
    throw new DesktopSmokeError("DESKTOP_DRIVER_UNAVAILABLE", "the fixed machine-local Desktop smoke driver is absent or not trusted");
  }
}

async function invoke(path, operation, payload, { timeoutMs = 15 * 60 * 1_000 } = {}) {
  if (!OPERATIONS.has(operation)) throw new DesktopSmokeError("INVALID_SMOKE_ADAPTER", "unsupported machine-driver operation");
  await verifyDriver(path);
  return new Promise((resolve, reject) => {
    const child = spawn(path, [operation], {
      env: { LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
      stdio: ["pipe", "pipe", "ignore"],
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
      child.kill("SIGKILL");
      finish(new DesktopSmokeError("DESKTOP_DRIVER_FAILED", `machine-local Desktop smoke driver exceeded its deadline during ${operation}`));
    }, timeoutMs);
    timer.unref?.();
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.length > 1024 * 1024) {
        child.kill("SIGKILL");
        finish(new DesktopSmokeError("DESKTOP_DRIVER_FAILED", "machine-local Desktop smoke driver returned an oversized receipt"));
      }
    });
    child.once("error", () => finish(new DesktopSmokeError("DESKTOP_DRIVER_FAILED", "machine-local Desktop smoke driver could not start")));
    child.once("close", (status) => {
      if (status !== 0) { finish(new DesktopSmokeError("DESKTOP_DRIVER_FAILED", `machine-local Desktop smoke driver failed during ${operation}`)); return; }
      try { finish(null, JSON.parse(stdout)); }
      catch { finish(new DesktopSmokeError("DESKTOP_DRIVER_FAILED", "machine-local Desktop smoke driver returned invalid JSON")); }
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
