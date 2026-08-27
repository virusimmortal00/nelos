import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { computeDistributionIntegrity } from "./distribution-provenance.mjs";
import { runDisposableDesktopSmokeV1 } from "./disposable-desktop-smoke.mjs";
import { createMachineDesktopSmokeAdapterV1 } from "./machine-desktop-smoke-adapter.mjs";

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
