import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionStoreV1, createWorkUnitSpecV1 } from "../../src/execution-store.mjs";
import { PlanRunStoreV1, createPlanRunV1 } from "../../src/plan-run-store.mjs";
import { OrchestrationCheckpointStoreV1 } from "../../src/orchestration-checkpoint-store.mjs";
import { QueenAcceptanceStoreV1, queenAcceptanceIdV1 } from "../../src/queen-acceptance.mjs";
import { planWorkSlices } from "../../src/slice-planner.mjs";

export const incident = JSON.parse(await readFile(
  new URL("../fixtures/unresolved-spinoffs.json", import.meta.url), "utf8",
));

// Only synthetic IDs and bounded outcome facts are retained. No production
// prompts, transcripts, credentials, paths, or PR content are needed.
export async function unresolvedSpinoffsFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "nelos-unresolved-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const identity = { webId: incident.webId, queenThreadId: incident.queenThreadId };
  const executionStore = new ExecutionStoreV1({ directory: join(root, "executions") });
  const planRunStore = new PlanRunStoreV1({ directory: join(root, "plans") });
  const checkpointStore = new OrchestrationCheckpointStoreV1({ directory: join(root, "checkpoints") });
  const acceptanceStore = new QueenAcceptanceStoreV1({ directory: join(root, "acceptances") });
  for (const member of incident.members) {
    const unit = createWorkUnitSpecV1({
      ...identity, schemaVersion: 1, workUnitId: member.id,
      specRevision: 1, attempt: member.attempt, memberKind: "spinoff",
      capabilities: ["observe", "read-result", "follow-up", "archive"],
      title: `Fixture ${member.id}`, objectiveSummary: "Complete bounded fixture work.",
      deliverable: "Verified result", acceptanceCriteria: ["Verification passes"],
      dependencies: [], required: true,
      policy: { maxAttempts: 3, onBlocked: "queen-review", onFailure: "queen-review" },
    });
    await executionStore.create(unit);
    const launch = { workUnitId: member.id, specRevision: 1, launchActionId: `launch-${member.id}` };
    await executionStore.markLaunchPending(launch);
    await executionStore.bind({ ...launch, memberThreadId: `task-${member.id}` });
    const provenance = {
      ...identity, workUnitId: member.id, specRevision: 1,
      attempt: member.decisionAttempt, memberThreadId: `task-${member.id}`,
      sourceTurnId: `turn-${member.id}-${member.decisionAttempt}`,
    };
    await acceptanceStore.record({
      ...provenance, schemaVersion: 1, decisionId: queenAcceptanceIdV1(provenance),
      decision: member.decision, decisionSummary: "Sanitized fixture decision.",
      recordedAt: "2026-09-21T00:00:00.000Z",
      result: {
        schemaVersion: 1, workUnitId: member.id, specRevision: 1,
        attempt: member.decisionAttempt, outcome: member.outcome,
        summary: "Sanitized fixture result.", artifacts: [], verification: [],
        blockers: member.outcome === "blocked" ? ["External verification unavailable."] : [],
        recoveryHint: null,
      },
    });
  }
  const runs = {};
  for (const plan of incident.plans) {
    const planned = planWorkSlices({
      schemaVersion: 1, objective: `Fixture ${plan.id}`, maxParallel: 3,
      slices: plan.members.map((id) => ({
        id, title: `Fixture ${id}`, objective: "Complete bounded fixture work.",
        deliverable: "Verified result", acceptanceCriteria: ["Verification passes"],
        dependsOn: [], lifecycle: "spinoff", workspaceMode: "isolated-write", taskShape: "everyday",
      })),
    });
    let run = await planRunStore.create(createPlanRunV1(planned, {
      queenThreadId: identity.queenThreadId, sourceId: plan.sourceId,
      webIdentity: { ...identity, schemaVersion: 1, queenTitle: "👑 A1 · Fixture queen" },
    }));
    const wave = { planRunId: run.planRunId, queenThreadId: identity.queenThreadId,
      waveIndex: 1, waveDigest: run.waves[0].waveDigest };
    run = await planRunStore.markWaveVerified(wave);
    if (plan.cleaned) run = await planRunStore.markWaveCleaned(wave);
    runs[plan.id] = run;
  }
  const units = await executionStore.list();
  const decisions = await acceptanceStore.list(identity);
  const finished = units.find(({ workUnitId }) => workUnitId === "preflight");
  const decision = decisions.find(({ workUnitId }) => workUnitId === "preflight");
  await checkpointStore.write({
    schemaVersion: 1, ...identity, checkpointRevision: 1, waitGeneration: 1,
    waveScope: { planRunId: runs.finished.planRunId, waveIndex: 1, waveDigest: runs.finished.waves[0].waveDigest },
    consumedReceipts: [],
    members: [{
      workUnitId: finished.workUnitId, specRevision: 1, attempt: 1,
      bindingGeneration: finished.binding.generation, memberThreadId: finished.binding.memberThreadId,
      capabilities: finished.capabilities, required: true,
      title: { state: "verified", requestedTitle: finished.title, observedTitle: finished.title, retryOrdinal: 0 },
      execution: { state: "terminal", hostId: null, cursor: null, latestTurnId: decision.sourceTurnId, attentionRequired: false },
      result: { state: "current", sourceTurnId: decision.sourceTurnId, envelope: decision.result, errorCode: null },
      coordination: { state: "accepted" },
    }],
  }, { expectedRevision: 0 });
  return { root, identity, executionStore, planRunStore, checkpointStore, acceptanceStore, runs, units, decisions };
}
