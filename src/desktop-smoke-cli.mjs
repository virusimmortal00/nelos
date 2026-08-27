import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeDistributionIntegrity } from "./distribution-provenance.mjs";
import { runDisposableDesktopSmokeV1 } from "./disposable-desktop-smoke.mjs";
import { createMachineDesktopSmokeAdapterV1, createMachineFreshVmDesktopAdapterV1 } from "./machine-desktop-smoke-adapter.mjs";
import { createFreshVmPublicBundleV1, runFreshVmDesktopWorkflowsV1 } from "./fresh-vm-desktop-runner.mjs";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));

async function json(path, label) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch { throw new Error(`${label} is missing or invalid`); }
}

export async function runDesktopSmokeCommandV1({ candidatePath, scenarioSetName, adapter = createMachineDesktopSmokeAdapterV1(), controllerCodexHome } = {}) {
  if (!candidatePath) throw new Error("desktop-test requires --candidate");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(scenarioSetName ?? "")) throw new Error("desktop-test requires a safe --scenario-set name");
  const packagePath = resolve(candidatePath);
  const [metadata, provenance] = await Promise.all([
    json(join(packagePath, "package.json"), "candidate package metadata"),
    json(join(packagePath, "distribution-provenance.json"), "candidate provenance"),
  ]);
  const digest = await computeDistributionIntegrity(packagePath);
  if (digest !== provenance.integrity) throw new Error("candidate digest does not match its provenance");
  const scenarioPath = join(repositoryRoot, "validation", "desktop-smoke", "scenario-sets", `${scenarioSetName}.json`);
  if (!isAbsolute(scenarioPath)) throw new Error("scenario set resolution failed");
  const scenarioSet = await json(scenarioPath, "scenario set");
  return runDisposableDesktopSmokeV1({
    candidate: { packagePath, digest, version: metadata.version, sourceRevision: provenance.sourceRevision },
    scenarioSet,
    adapter,
    controllerCodexHome,
  });
}

export async function runDesktopSmokeBundleCommandV1({ candidatePath, scenarioSetName, runId, bundleOutput, adapter = createMachineFreshVmDesktopAdapterV1(), controllerCodexHome } = {}) {
  if (!candidatePath) throw new Error("desktop-test bundle mode requires --candidate");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(runId ?? "")) throw new Error("desktop-test bundle mode requires a safe --run-id");
  if (!bundleOutput) throw new Error("desktop-test bundle mode requires --bundle-output");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(scenarioSetName ?? "")) throw new Error("desktop-test requires a safe --scenario-set name");
  const packagePath = resolve(candidatePath);
  const [metadata, provenance] = await Promise.all([
    json(join(packagePath, "package.json"), "candidate package metadata"),
    json(join(packagePath, "distribution-provenance.json"), "candidate provenance"),
  ]);
  const digest = await computeDistributionIntegrity(packagePath);
  if (digest !== provenance.integrity) throw new Error("candidate digest does not match its provenance");
  const scenarioSet = await json(join(repositoryRoot, "validation", "desktop-smoke", "scenario-sets", `${scenarioSetName}.json`), "scenario set");
  const result = await runFreshVmDesktopWorkflowsV1({ runId, candidate: { packagePath, digest, version: metadata.version, sourceRevision: provenance.sourceRevision }, scenarioSet, adapter, controllerCodexHome });
  if (result.bundle === null) return result;
  const outputPath = resolve(bundleOutput);
  const bytes = createFreshVmPublicBundleV1(result);
  await writeFile(outputPath, bytes, { flag: "wx", mode: 0o600 });
  return Object.freeze({ schemaVersion: 1, mode: "bundle", runId, outcome: result.outcome, bundleDigest: result.bundleDigest, bundlePath: outputPath, cleanup: result.cleanup });
}
