import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { computeDistributionIntegrity, validateProvenance } from "./distribution-provenance.mjs";
import { taskStateDirectory } from "./task-state.mjs";

const CONTRACT_FIELDS = ["state", "tools", "receipts", "locking", "instructions"];

export function validateRuntimeCompatibilityV1(value) {
  if (!value || value.schemaVersion !== 1 ||
      Object.keys(value).length !== CONTRACT_FIELDS.length + 1 ||
      !CONTRACT_FIELDS.every((key) => typeof value[key] === "string" && /^[a-z0-9-]{1,128}$/u.test(value[key]))) {
    throw new Error("runtime compatibility contract is invalid or unsupported");
  }
  return Object.freeze({ schemaVersion: 1, ...Object.fromEntries(CONTRACT_FIELDS.map((key) => [key, value[key]])) });
}

// Release authors may retain these tokens only after the cross-generation
// contract tests pass. They describe behavior, not package/schema versions.
export function runtimeContractsCompatibleV1(left, right) {
  if (!left || !right) return false;
  return isDeepStrictEqual(validateRuntimeCompatibilityV1(left), validateRuntimeCompatibilityV1(right));
}

export function runtimeImageDirectory() {
  return join(taskStateDirectory(), "runtime-images");
}

export function runtimeImagePathV1(identity, directory = runtimeImageDirectory()) {
  if (!/^\d+\.\d+\.\d+(?:\+codex\.[a-z0-9-]+)?$/u.test(identity.version) ||
      !/^nelos-build:[a-f0-9]{32}$/u.test(identity.buildIdentity)) {
    throw new Error("invalid retained runtime identity");
  }
  return resolve(directory, identity.version, identity.buildIdentity.replace(":", "-"));
}

export function isRetainedRuntimeV1(identity) {
  try { return resolve(identity.modulePath) === runtimeImagePathV1(identity); }
  catch { return false; }
}

export async function readRuntimeContractV1(root) {
  let source;
  try { source = await readFile(join(root, "src/runtime-compatibility.json"), "utf8"); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (Buffer.byteLength(source) > 4096) throw new Error("runtime compatibility contract is oversized");
  return validateRuntimeCompatibilityV1(JSON.parse(source));
}

// Lease metadata alone never authorizes coexistence. Check the retained bytes
// and bind their provenance to the lease before trusting the embedded contract.
export async function verifiedRuntimeContractV1(identity) {
  if (!isRetainedRuntimeV1(identity)) return null;
  const provenance = validateProvenance(JSON.parse(await readFile(join(identity.modulePath, "distribution-provenance.json"), "utf8")), "retained runtime");
  if (provenance.revision !== identity.version || provenance.integrity !== identity.integrity ||
      (provenance.sourceRevision ?? null) !== identity.sourceRevision ||
      await computeDistributionIntegrity(identity.modulePath) !== identity.integrity) {
    throw new Error("retained runtime integrity disagrees with its worker lease");
  }
  return readRuntimeContractV1(identity.modulePath);
}

export async function verifiedDistributionContractV1(moduleRoot) {
  const contract = await readRuntimeContractV1(moduleRoot);
  if (!contract) return null;
  const provenance = validateProvenance(JSON.parse(await readFile(join(moduleRoot, "distribution-provenance.json"), "utf8")), "upgrade candidate");
  if (await computeDistributionIntegrity(moduleRoot) !== provenance.integrity) {
    throw new Error("upgrade candidate integrity is invalid");
  }
  return contract;
}

export async function canInstallRuntimeV1(moduleRoot, workers) {
  const contract = await verifiedDistributionContractV1(moduleRoot);
  if (!contract) return false;
  if (workers.compatibilityContract && !runtimeContractsCompatibleV1(contract, workers.compatibilityContract)) return false;
  if (workers.liveWorkerCount === 0) return Boolean(workers.compatibilityContract) || workers.persistedStateEmpty === true;
  if (!workers.activeGenerations?.length || workers.mutationAllowed !== true) return false;
  const peers = await Promise.all(workers.activeGenerations.map(({ identity }) => verifiedRuntimeContractV1(identity)));
  return peers.every((peer) => runtimeContractsCompatibleV1(contract, peer));
}

// Only infrastructure may precede the first contracted writer. Unknown entries
// count as persisted state; a missing pin or an empty worker registry is no proof.
export async function isRuntimeStateEmptyV1(directory = taskStateDirectory()) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
  const infrastructure = new Set(["runtime-images", "runtime-workers", "runtime-workers.lock"]);
  return entries.every((entry) => infrastructure.has(entry.name) && entry.isDirectory());
}
