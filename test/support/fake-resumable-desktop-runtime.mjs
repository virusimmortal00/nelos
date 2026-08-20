import { readFile, writeFile } from "node:fs/promises";

import { contentDigest } from "nelos/remote-desktop-runner";

async function readState(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { archive: 0, collect: 0, create: 0, destroy: 0, gui: 0, quarantine: 0 };
  }
}

async function increment(path, field) {
  const state = await readState(path);
  state[field] += 1;
  await writeFile(path, `${JSON.stringify(state)}\n`);
  return state;
}

function binding(run) {
  return { ...run.provider, leaseId: run.lease.leaseId, fencingToken: run.lease.fencingToken };
}

function cleanupReceipt(run, operation) {
  const owned = binding(run);
  const credentialDisposition = (method) => ({
    schemaVersion: 1, type: "nelos.credential-terminal-disposition.v1", method,
    codexHome: "/home/nelosauto/.codex", filesystemType: "tmpfs", swapPolicy: "disabled-and-attested-before-auth",
    powerState: "stopped", reusableCredentialsAbsent: true, secretBytesIncluded: false,
    attestationDigest: `sha256:${"c".repeat(64)}`,
  });
  if (operation === "destroy") return {
    receiptId: "fake-destroy", ...owned, mutationStatus: "committed", destroyed: true,
    credentialDisposition: credentialDisposition("powered-off-before-destroy"), macAbsent: true, networkInventoryComplete: true,
    attestationDigest: `sha256:${"d".repeat(64)}`,
  };
  return {
    receiptId: "fake-quarantine", ...owned, mutationStatus: "committed", quarantined: true,
    credentialDisposition: credentialDisposition("powered-off-quarantine"),
    attestationDigest: `sha256:${"e".repeat(64)}`,
    reconciliation: { operationId: `${run.runId}:quarantine`, ...owned },
  };
}

function absenceObservation(run, now) {
  const unsigned = {
    schemaVersion: 1, type: "independent-pre-mutation-vm-observation", binding: binding(run),
    state: "absent", observedAt: new Date(now).toISOString(),
  };
  return { ...unsigned, observationDigest: contentDigest(unsigned) };
}

export async function createRemoteDesktopRuntime(config) {
  const statePath = config.testRuntime.statePath;
  const run = config.run;
  return {
    clock: { now: () => config.now },
    crashInjector: async (checkpoint) => {
      if (checkpoint === config.testRuntime.crashAt) throw Object.assign(new Error("fresh-process crash"), { code: "INJECTED_CRASH" });
    },
    providerController: {
      async execute({ operation }) {
        await increment(statePath, operation);
        if (operation === "create") return {
          receiptId: "fake-create", ...binding(run), mutationStatus: "committed", created: true,
          qgaReady: true, state: "running",
        };
        return cleanupReceipt(run, operation);
      },
      async reconcileEffect() { throw new Error("no pending provider effect is expected"); },
    },
    guiDriver: {
      async runScenario(scenario) {
        await increment(statePath, "gui");
        return {
          scenarioId: scenario.scenarioId, taskId: scenario.task.taskId,
          startedAt: new Date(config.now).toISOString(), finishedAt: new Date(config.now + 1).toISOString(),
          outcome: "passed", failure: null,
          actions: scenario.actions.map((action) => ({ actionId: action.actionId, actionType: action.type, startedAt: new Date(config.now).toISOString(), finishedAt: new Date(config.now + 1).toISOString(), outcome: "succeeded" })),
          checkpoints: [], assertions: scenario.assertions.map((assertion) => ({ assertionId: assertion.assertionId, passed: true, observedRef: assertion.expectedRef })),
        };
      },
      async cleanupSealedValues(valueRefs) {
        const declaredValueRefs = [...valueRefs].sort();
        return { schemaVersion: 1, kind: "sealed-value-absence", declaredValueRefs, removedValueRefs: [], alreadyAbsentValueRefs: declaredValueRefs, remainingValueRefs: [] };
      },
    },
    taskPreparer: {
      intentDigest: `sha256:${"8".repeat(64)}`,
      async execute() { return { schemaVersion: 1, taskId: run.scenarios[0].task.taskId, initialTurnStarted: false }; },
      async reconcileEffect() { return { schemaVersion: 1, taskId: run.scenarios[0].task.taskId, initialTurnStarted: false }; },
      materialize(value) { return structuredClone(value); },
    },
    archiveProjectionController: {
      async execute() { await increment(statePath, "archive"); return { schemaVersion: 1, outcome: "passed" }; },
      async reconcileEffect() { throw new Error("no pending archive effect is expected"); },
    },
    evidenceCollector: {
      async collect() { await increment(statePath, "collect"); return { screenshots: [], recordings: [], diagnostics: [] }; },
    },
    productionGuard: {
      admission: config.testRuntime.admission,
      initialReservationObservation: absenceObservation(run, config.now),
      async prepareBeforeDestroy() { throw new Error("deadline cleanup cannot start a new evidence draft"); },
      async verifyBeforeDestroy() { throw new Error("deadline cleanup cannot verify an absent draft"); },
      async attestAfterDestroy() { throw new Error("deadline cleanup uses quarantine"); },
      async attestFinalEvidence() { throw new Error("deadline cleanup cannot finalize new evidence"); },
    },
  };
}
