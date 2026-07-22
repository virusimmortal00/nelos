#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { startGoldenLoopAppServer } from "../test/support/golden-loop-app-server.mjs";
import {
  ExecutionStoreV1,
  createWorkUnitSpecV1,
} from "../src/execution-store.mjs";
import {
  QueenAcceptanceStoreV1,
  createQueenAcceptanceV1,
  deriveWebReadinessV1,
  queenAcceptanceIdV1,
} from "../src/queen-acceptance.mjs";
import { reconcileExecutionRecord } from "../src/execution-reconciliation.mjs";
import { formatResultEnvelope } from "../src/work-result.mjs";

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const cliPath = fileURLToPath(new URL("../bin/fraktik", import.meta.url));
const queenThreadId = "queen-thread";

function resultEnvelope(member, { attempt = 1, blocked = false } = {}) {
  return formatResultEnvelope({
    schemaVersion: 1,
    workUnitId: `golden-${member.toLowerCase()}`,
    specRevision: 1,
    attempt,
    outcome: blocked ? "blocked" : "succeeded",
    summary: blocked ? `${member}_BLOCKED` : `${member}_RESULT`,
    artifacts: [],
    verification: [],
    blockers: blocked ? ["fixture-blocker"] : [],
    recoveryHint: blocked ? "Retry the same work unit once." : null,
  });
}

function initialPrompt(title) {
  const member = title[0];
  return (
    `Complete ${title}. Finish with exactly this fenced result and no trailing prose:\n` +
    resultEnvelope(member, { blocked: member === "B" })
  );
}

const correctionPrompt =
  "Retry the same work unit with fixtureMode=scripted-no-model. " +
  "Finish with exactly this fenced result and no trailing prose:\n" +
  resultEnvelope("B", { attempt: 2 });

async function runCli(argumentsList, { socketPath, stateHome }) {
  try {
    const { stdout } = await execFileAsync(
      process.execPath,
      [cliPath, ...argumentsList, "--socket", socketPath],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_THREAD_ID: queenThreadId,
          XDG_STATE_HOME: stateHome,
        },
        maxBuffer: 4 * 1024 * 1024,
        timeout: 10_000,
      },
    );
    return JSON.parse(stdout);
  } catch (error) {
    const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
    throw new Error(
      `fraktik ${argumentsList.join(" ")} failed: ${stderr || error.message}`,
    );
  }
}

function memberByBaseTitle(collection, baseTitle) {
  const matches = collection.members.filter((member) => member.baseTitle === baseTitle);
  assert.equal(matches.length, 1, `expected exactly one ${baseTitle} result`);
  return matches[0];
}

function countOccurrences(text, marker) {
  return text.split(marker).length - 1;
}

function workUnit({ webId, workUnitId, title, dependencies = [] }) {
  return createWorkUnitSpecV1({
    webId,
    queenThreadId,
    workUnitId,
    specRevision: 1,
    attempt: 1,
    memberKind: "spinoff",
    capabilities: ["observe", "read-result", "follow-up"],
    title,
    objectiveSummary: `Produce the bounded ${workUnitId} result.`,
    deliverable: "A validated ResultEnvelopeV1.",
    acceptanceCriteria: ["The queen can validate the current result."],
    dependencies,
    required: true,
    policy: {
      maxAttempts: 2,
      onBlocked: "queen-review",
      onFailure: "queen-review",
    },
  });
}

function acceptanceFor(workUnitRecord, member, { decision = "accepted" } = {}) {
  const identity = {
    webId: workUnitRecord.webId,
    workUnitId: workUnitRecord.workUnitId,
    specRevision: workUnitRecord.specRevision,
    attempt: workUnitRecord.attempt,
    memberThreadId: member.threadId,
    sourceTurnId: member.sourceTurnId,
  };
  return createQueenAcceptanceV1({
    schemaVersion: 1,
    decisionId: queenAcceptanceIdV1(identity),
    webId: workUnitRecord.webId,
    queenThreadId: workUnitRecord.queenThreadId,
    workUnitId: workUnitRecord.workUnitId,
    specRevision: workUnitRecord.specRevision,
    attempt: workUnitRecord.attempt,
    memberThreadId: member.threadId,
    sourceTurnId: member.sourceTurnId,
    decision,
    decisionSummary:
      decision === "accepted"
        ? `Queen accepted ${workUnitRecord.workUnitId}'s current result.`
        : `Queen rejected ${workUnitRecord.workUnitId}'s current result.`,
    result: member.result,
    recordedAt: "2026-07-21T12:00:00.000Z",
  });
}

function readinessFor(executionStore, acceptanceStore) {
  return Promise.all([executionStore.list(), acceptanceStore.list()]).then(
    ([workUnits, decisions]) => deriveWebReadinessV1({ workUnits, decisions }),
  );
}

function assertNoModelOverrides(requests) {
  const launches = requests.filter(({ method }) => method === "thread/start");
  const turns = requests.filter(({ method }) => method === "turn/start");
  assert.equal(launches.length, 3);
  assert.equal(turns.length, 4);
  for (const request of [...launches, ...turns]) {
    assert.equal(Object.hasOwn(request.params, "model"), false);
    assert.equal(Object.hasOwn(request.params, "effort"), false);
  }
}

function assertExactPromptContracts(requests) {
  const prompts = requests
    .filter(({ method }) => method === "turn/start")
    .map(({ params }) => params.input[0].text);
  assert.deepEqual(prompts.slice(0, 3).sort(), [
    initialPrompt("A member"),
    initialPrompt("B member"),
    initialPrompt("C member"),
  ].sort());
  assert.equal(prompts[3], correctionPrompt);
  assert.ok(prompts.every((prompt) => !prompt.includes("\\n")));
}

async function readWebRecord(stateHome, threadId) {
  const path = join(
    stateHome,
    "fraktik",
    "webs",
    `${encodeURIComponent(threadId)}.json`,
  );
  return JSON.parse(await readFile(path, "utf8"));
}

export async function runGoldenLoopScenario({ iteration = 1 } = {}) {
  const startedAt = Date.now();
  const temporaryRoot = await mkdtemp(join(tmpdir(), "fraktik-golden-loop-"));
  const socketPath = join(temporaryRoot, "app.sock");
  const stateHome = join(temporaryRoot, "state");
  let server = null;
  let report = null;

  try {
    server = await startGoldenLoopAppServer(socketPath, { cwd: repositoryRoot });
    const context = { socketPath, stateHome };
    const executionDirectory = join(stateHome, "fraktik", "executions");
    const acceptanceDirectory = join(stateHome, "fraktik", "queen-acceptances");
    const executionStore = new ExecutionStoreV1({ directory: executionDirectory });
    const acceptanceStore = new QueenAcceptanceStoreV1({ directory: acceptanceDirectory });
    const launch = async (title) =>
      runCli(
        [
          "spinoff",
          "--title",
          title,
          "--prompt",
          initialPrompt(title),
          "--cwd",
          repositoryRoot,
          "--sandbox",
          "read-only",
          "--approval",
          "never",
        ],
        context,
      );

    const begun = await runCli(
      ["web", "begin", "--title", "Golden loop queen"],
      context,
    );
    const aWorkUnit = workUnit({
      webId: begun.webId,
      workUnitId: "golden-a",
      title: "A member",
    });
    const bWorkUnit = workUnit({
      webId: begun.webId,
      workUnitId: "golden-b",
      title: "B member",
      dependencies: ["golden-a"],
    });
    const cWorkUnit = workUnit({
      webId: begun.webId,
      workUnitId: "golden-c",
      title: "C member",
    });
    await Promise.all([
      executionStore.create(aWorkUnit),
      executionStore.create(bWorkUnit),
      executionStore.create(cWorkUnit),
    ]);
    const aLaunchAction = reconcileExecutionRecord(await executionStore.read("golden-a"))
      .proposedActions[0];
    const bLaunchActionBeforeAcceptance = reconcileExecutionRecord(
      await executionStore.read("golden-b"),
    ).proposedActions[0];
    const cLaunchAction = reconcileExecutionRecord(await executionStore.read("golden-c"))
      .proposedActions[0];
    assert.equal(aLaunchAction.type, "launch");
    assert.equal(bLaunchActionBeforeAcceptance.type, "launch");
    assert.equal(cLaunchAction.type, "launch");

    const [aLaunch, cLaunch] = await Promise.all([
      launch("A member"),
      launch("C member"),
    ]);
    assert.equal(aLaunch.spinoff.webId, begun.webId);
    assert.equal(cLaunch.spinoff.webId, begun.webId);
    await executionStore.markLaunchPending({
      workUnitId: "golden-a",
      specRevision: 1,
      launchActionId: aLaunchAction.actionId,
    });
    await executionStore.bind({
      workUnitId: "golden-a",
      specRevision: 1,
      launchActionId: aLaunchAction.actionId,
      memberThreadId: aLaunch.threadId,
    });
    await executionStore.markLaunchPending({
      workUnitId: "golden-c",
      specRevision: 1,
      launchActionId: cLaunchAction.actionId,
    });
    await executionStore.bind({
      workUnitId: "golden-c",
      specRevision: 1,
      launchActionId: cLaunchAction.actionId,
      memberThreadId: cLaunch.threadId,
    });

    const firstCollectRequest = server.requests.length;
    const upstreamOnly = await runCli(
      [
        "web",
        "collect",
        "--queen-thread-id",
        queenThreadId,
        "--wait",
        "--poll-ms",
        "1",
        "--max-wait-ms",
        "2000",
      ],
      context,
    );
    const initialCollectRequests = server.requests.slice(firstCollectRequest);
    assert.ok(initialCollectRequests.length > 1);
    assert.ok(
      initialCollectRequests.every(({ method }) =>
        ["initialize", "initialized", "thread/read", "thread/turns/list"].includes(method),
      ),
      `web collect must remain read-only: ${initialCollectRequests
        .map(({ method }) => method)
        .join(", ")}`,
    );
    assert.ok(
      initialCollectRequests
        .filter(({ method }) => method === "thread/read")
        .every(({ params }) => params.includeTurns === false),
    );
    assert.ok(
      initialCollectRequests
        .filter(({ method }) => method === "thread/turns/list")
        .every(
          ({ params }) =>
            params.limit === 2 &&
            params.itemsView === "full" &&
            params.sortDirection === "desc",
        ),
    );
    assert.equal(upstreamOnly.count, 2);
    assert.equal(upstreamOnly.allSucceeded, true);
    assert.deepEqual(upstreamOnly.members.map(({ baseTitle }) => baseTitle), [
      "A member",
      "C member",
    ]);
    const initialA = memberByBaseTitle(upstreamOnly, "A member");
    const initialC = memberByBaseTitle(upstreamOnly, "C member");
    assert.equal(initialA.workOutcome, "succeeded");
    assert.equal(initialC.workOutcome, "succeeded");
    assert.equal(initialA.result.workUnitId, "golden-a");
    assert.equal(initialA.result.specRevision, 1);
    assert.equal(initialC.result.workUnitId, "golden-c");
    assert.equal(initialC.result.specRevision, 1);

    const beforeAcceptance = await readinessFor(executionStore, acceptanceStore);
    const blockedB = beforeAcceptance.entries.find((entry) => entry.workUnitId === "golden-b");
    assert.equal(blockedB.reason, "blocked_by_unaccepted_dependencies");
    assert.equal(blockedB.ready, false);
    assert.equal(server.requests.filter(({ method }) => method === "thread/start").length, 2);

    await acceptanceStore.record(
      acceptanceFor(await executionStore.read("golden-a"), initialA),
    );
    await acceptanceStore.record(
      acceptanceFor(await executionStore.read("golden-c"), initialC),
    );
    const afterAcceptance = await readinessFor(executionStore, acceptanceStore);
    assert.deepEqual(afterAcceptance.readyWorkUnitIds, ["golden-b"]);

    // A fresh process can reconstruct the same gate and action identity before
    // any dependent side effect is attempted.
    const restartedExecutionStore = new ExecutionStoreV1({ directory: executionDirectory });
    const restartedAcceptanceStore = new QueenAcceptanceStoreV1({ directory: acceptanceDirectory });
    const afterRestart = await readinessFor(restartedExecutionStore, restartedAcceptanceStore);
    assert.deepEqual(afterRestart, afterAcceptance);
    const bLaunchActionAfterRestart = reconcileExecutionRecord(
      await restartedExecutionStore.read("golden-b"),
    ).proposedActions[0];
    assert.equal(bLaunchActionAfterRestart.actionId, bLaunchActionBeforeAcceptance.actionId);

    await executionStore.markLaunchPending({
      workUnitId: "golden-b",
      specRevision: 1,
      launchActionId: bLaunchActionAfterRestart.actionId,
    });
    const bLaunch = await launch("B member");
    await executionStore.bind({
      workUnitId: "golden-b",
      specRevision: 1,
      launchActionId: bLaunchActionAfterRestart.actionId,
      memberThreadId: bLaunch.threadId,
    });

    const initial = await runCli(
      [
        "web",
        "collect",
        "--id",
        begun.webId,
        "--wait",
        "--poll-ms",
        "1",
        "--max-wait-ms",
        "2000",
      ],
      context,
    );
    assert.equal(initial.count, 3);
    assert.equal(initial.allSucceeded, false);
    const initialB = memberByBaseTitle(initial, "B member");
    assert.equal(initialB.transportStatus, "completed");
    assert.equal(initialB.workOutcome, "blocked");
    assert.equal(initialB.result.workUnitId, "golden-b");
    assert.equal(initialB.result.attempt, 1);
    assert.equal(initialB.result.summary, "B_BLOCKED");

    await executionStore.advanceAttempt({
      workUnitId: "golden-b",
      specRevision: 1,
      attempt: 1,
    });

    const correction = await runCli(
      [
        "send",
        bLaunch.threadId,
        "--prompt",
        correctionPrompt,
      ],
      context,
    );
    assert.equal(correction.threadId, bLaunch.threadId);
    assert.notEqual(correction.turnId, bLaunch.turnId);

    const activeCollectRequest = server.requests.length;
    const recovering = await runCli(
      ["web", "collect", "--id", aLaunch.spinoff.webId],
      context,
    );
    const activeCollectRequests = server.requests.slice(activeCollectRequest);
    assert.ok(
      activeCollectRequests.every(({ method }) =>
        ["initialize", "initialized", "thread/read", "thread/turns/list"].includes(method),
      ),
      `active recovery collection must remain read-only: ${activeCollectRequests
        .map(({ method }) => method)
        .join(", ")}`,
    );
    const recoveringB = memberByBaseTitle(recovering, "B member");
    assert.equal(recoveringB.latestTurnId, correction.turnId);
    assert.equal(recoveringB.sourceTurnId, initialB.sourceTurnId);
    assert.equal(recoveringB.transportStatus, "running");
    assert.equal(recoveringB.workOutcome, "blocked");
    assert.equal(recoveringB.resultState, "valid");
    assert.equal(recoveringB.result.summary, "B_BLOCKED");
    assert.equal(recoveringB.attentionRequired, false);
    assert.equal(recoveringB.attentionReason, null);
    assert.equal(recovering.allSucceeded, false);
    assert.deepEqual(recovering.summary, {
      total: 3,
      unknown: 0,
      succeeded: 2,
      blocked: 1,
      failed: 0,
      attention: 0,
    });
    const recoveringSerialized = JSON.stringify(recovering);
    for (const forbidden of [
      "PRIVATE_USER_B_2",
      "PRIVATE_COMMENTARY_B_2",
      correctionPrompt,
      "B_RESULT",
      '\"items\"',
    ]) {
      assert.equal(
        recoveringSerialized.includes(forbidden),
        false,
        `${forbidden} leaked during active recovery`,
      );
    }

    const finalCollectRequest = server.requests.length;
    const final = await runCli(
      [
        "web",
        "collect",
        "--id",
        aLaunch.spinoff.webId,
        "--wait",
        "--poll-ms",
        "1",
        "--max-wait-ms",
        "2000",
      ],
      context,
    );
    const finalCollectRequests = server.requests.slice(finalCollectRequest);
    assert.ok(
      finalCollectRequests.every(({ method }) =>
        ["initialize", "initialized", "thread/read", "thread/turns/list"].includes(method),
      ),
      `recollection must remain read-only: ${finalCollectRequests
        .map(({ method }) => method)
        .join(", ")}`,
    );
    assert.ok(
      finalCollectRequests
        .filter(({ method }) => method === "thread/read")
        .every(({ params }) => params.includeTurns === false),
    );
    assert.equal(final.count, 3);
    assert.equal(final.allSucceeded, true);
    assert.deepEqual(final.summary, {
      total: 3,
      unknown: 0,
      succeeded: 3,
      blocked: 0,
      failed: 0,
      attention: 0,
    });

    const finalA = memberByBaseTitle(final, "A member");
    const finalB = memberByBaseTitle(final, "B member");
    const finalC = memberByBaseTitle(final, "C member");
    assert.equal(finalA.sourceTurnId, initialA.sourceTurnId);
    assert.equal(finalC.sourceTurnId, initialC.sourceTurnId);
    assert.equal(finalB.threadId, initialB.threadId);
    assert.notEqual(finalB.sourceTurnId, initialB.sourceTurnId);
    assert.equal(finalB.result.workUnitId, "golden-b");
    assert.equal(finalB.result.specRevision, 1);
    assert.equal(finalB.result.attempt, 2);
    assert.equal(finalB.result.summary, "B_RESULT");

    const serialized = JSON.stringify(final);
    for (const forbidden of [
      "B_BLOCKED",
      "PRIVATE_USER_",
      "PRIVATE_COMMENTARY_",
      "fixtureMode=scripted-no-model",
      '\"items\"',
    ]) {
      assert.equal(serialized.includes(forbidden), false, `${forbidden} leaked`);
    }
    const synthesis = final.members.map((member) => member.result.summary).join(" | ");
    for (const expected of ["A_RESULT", "B_RESULT", "C_RESULT"]) {
      assert.equal(countOccurrences(synthesis, expected), 1);
    }

    await acceptanceStore.record(
      acceptanceFor(await executionStore.read("golden-b"), finalB),
    );
    const acceptedDecisions = await acceptanceStore.list();
    assert.equal(
      acceptedDecisions.some(
        (decision) =>
          decision.workUnitId === "golden-b" && decision.attempt === 1,
      ),
      false,
      "the blocked first attempt must never unlock or enter synthesis",
    );
    const acceptedSynthesis = acceptedDecisions
      .filter((decision) => decision.decision === "accepted")
      .sort((left, right) => left.workUnitId.localeCompare(right.workUnitId))
      .map((decision) => decision.result.summary)
      .join(" | ");
    assert.equal(acceptedSynthesis, "A_RESULT | B_RESULT | C_RESULT");
    const finalReadiness = await readinessFor(
      new ExecutionStoreV1({ directory: executionDirectory }),
      new QueenAcceptanceStoreV1({ directory: acceptanceDirectory }),
    );
    assert.equal(finalReadiness.entries.every((entry) => entry.accepted), true);

    const bRecord = await readWebRecord(stateHome, bLaunch.threadId);
    assert.equal(bRecord.threadId, bLaunch.threadId);
    assert.equal(bRecord.queenThreadId, queenThreadId);
    assert.equal(bRecord.inboundWebId, aLaunch.spinoff.webId);
    assert.equal(bRecord.archivedAt, null);
    assertNoModelOverrides(server.requests);
    assertExactPromptContracts(server.requests);

    report = {
      iteration,
      webId: final.webId,
      members: final.count,
      acceptanceGate: true,
      dependencyReleasedOnlyAfterAcceptance: true,
      restartSafeContinuation: true,
      sameTaskRecovery: true,
      exactCollection: true,
      synthesis,
      acceptedSynthesis,
      modelOverrides: 0,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (server) await server.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  assert.equal(await stat(temporaryRoot).catch(() => null), null);
  assert.ok(report.durationMs <= 90_000, `golden loop took ${report.durationMs} ms`);
  return { ...report, cleanedUp: true };
}

export async function verifyGoldenLoop({ iterations = 2 } = {}) {
  assert.ok(Number.isInteger(iterations) && iterations > 0);
  const runs = [];
  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    runs.push(await runGoldenLoopScenario({ iteration }));
  }
  return {
    command: "verify:golden-loop",
    passes: runs.length,
    acceptanceGate: runs.every((run) => run.acceptanceGate),
    dependencyReleasedOnlyAfterAcceptance: runs.every(
      (run) => run.dependencyReleasedOnlyAfterAcceptance,
    ),
    restartSafeContinuation: runs.every((run) => run.restartSafeContinuation),
    sameTaskRecovery: runs.every((run) => run.sameTaskRecovery),
    exactCollection: runs.every((run) => run.exactCollection),
    acceptedSynthesis: runs.every(
      (run) => run.acceptedSynthesis === "A_RESULT | B_RESULT | C_RESULT",
    )
      ? "A_RESULT | B_RESULT | C_RESULT"
      : null,
    modelOverrides: runs.reduce((total, run) => total + run.modelOverrides, 0),
    cleanedUp: runs.every((run) => run.cleanedUp),
    runs,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const iterationFlag = process.argv.indexOf("--iterations");
  const iterations =
    iterationFlag === -1
      ? 2
      : Number.parseInt(process.argv[iterationFlag + 1], 10);
  if (
    (iterationFlag !== -1 && process.argv.length !== iterationFlag + 2) ||
    !Number.isInteger(iterations) ||
    iterations <= 0
  ) {
    process.stderr.write("verify-golden-loop: use --iterations POSITIVE_INTEGER\n");
    process.exitCode = 1;
  } else {
    verifyGoldenLoop({ iterations })
    .then((result) => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`verify-golden-loop: ${error.message}\n`);
      process.exitCode = 1;
    });
  }
}
