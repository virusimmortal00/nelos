import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpJoinAdapterV1 } from "../src/mcp-observation.mjs";
import { NelosWebInspectorV1 } from "../src/web-inspection.mjs";
import { SpinoffLifecycleAdapterV1, SpinoffLifecycleStoreV1 } from "../src/spinoff-lifecycle.mjs";
import { createPlanRunV1 } from "../src/plan-run-store.mjs";
import { planWorkSlices } from "../src/slice-planner.mjs";
import { incident, unresolvedSpinoffsFixture } from "./support/unresolved-spinoffs.mjs";

// Locks also belong to the test, never the installed plugin's state directory.
const stateHome = await mkdtemp(join(tmpdir(), "nelos-unresolved-locks-"));
process.env.XDG_STATE_HOME = stateHome;
after(() => rm(stateHome, { recursive: true, force: true }));

function nativeBoundary() {
  const calls = [];
  return {
    calls,
    webRegistry: { async read(threadId) { return { threadId, outboundWebId: incident.webId }; } },
    appServerBridge: {
      async inspectMany(args) {
        calls.push(args);
        return {
          items: args.threadIds.map((threadId) => ({ threadId, state: "ready",
            thread: { threadId, title: "Fixture task", status: "notLoaded", parentThreadId: null, updatedAt: 1 } })),
          topology: { schemaVersion: 1, nodes: [], edges: [], externalParents: [] },
        };
      },
      async health() { return { schemaVersion: 1, state: "ready", compatible: true }; },
    },
  };
}

test("incident: required spinoffs outside the checkpoint remain visible as attention", async (t) => {
  const fixture = await unresolvedSpinoffsFixture(t);
  const native = nativeBoundary();
  const inspection = await new NelosWebInspectorV1(fixture).inspect(
    { schemaVersion: 1, ...fixture.identity, limit: 1 }, native,
  );
  assert.equal(inspection.summary.coordinationCounts.untracked, incident.expected.untracked);
  assert.equal(inspection.summary.persistedAttentionRequired, incident.expected.persistedAttentionRequired);
  assert.equal(native.calls.length, 1);
  assert.equal(native.calls[0].threadIds.length, 2, "native reads remain page-bounded");
});

test("incident: a finished plan cannot hide the three unfinished spinoffs on resume", async (t) => {
  const fixture = await unresolvedSpinoffsFixture(t);
  const adapter = new McpJoinAdapterV1(fixture);
  const advanced = await adapter.advance(fixture.identity);
  assert.equal(advanced.checkpoint.waveScope.planRunId, fixture.runs.unfinished.planRunId);
  assert.deepEqual(advanced.checkpoint.members.map(({ workUnitId }) => workUnitId), ["keys", "telemetry", "template"]);
  assert.notEqual(advanced.nextAction?.kind, "complete");
  assert.deepEqual(await new McpJoinAdapterV1(fixture).advance(fixture.identity), advanced,
    "restart reconstructs the same checkpoint and effects");
});

test("incident: blocked, unaccepted spinoffs never produce archive effects", async (t) => {
  const fixture = await unresolvedSpinoffsFixture(t);
  const lifecycle = new SpinoffLifecycleAdapterV1({
    ...fixture,
    store: new SpinoffLifecycleStoreV1({ directory: join(fixture.root, "lifecycle") }),
    configuration: { async get() { return { setting: { value: "auto" } }; } },
  });
  const run = fixture.runs.unfinished;
  const result = await lifecycle.cleanup({ ...fixture.identity,
    planRunId: run.planRunId, waveIndex: 1, waveDigest: run.waves[0].waveDigest,
  });
  assert.equal(result.state, "not-ready");
  assert.equal(result.pending.length, 3);
  assert.equal(result.effects?.length ?? 0, incident.expected.archiveEffectsForBlocked);
});

test("recovery refuses a malformed wave member missing from the old checkpoint", async (t) => {
  const fixture = await unresolvedSpinoffsFixture(t);
  await writeFile(join(fixture.root, "executions", "template.json"), "{broken\n");
  const before = await fixture.checkpointStore.read(fixture.identity.webId, fixture.identity.queenThreadId);
  await assert.rejects(new McpJoinAdapterV1(fixture).advance(fixture.identity),
    /execution state contains malformed records/);
  assert.deepEqual(await fixture.checkpointStore.read(fixture.identity.webId, fixture.identity.queenThreadId), before);
  assert.equal(await readFile(join(fixture.root, "executions", "template.json"), "utf8"), "{broken\n");
});

test("inspection suppresses settled history, but not missing current acceptance", async (t) => {
  const fixture = await unresolvedSpinoffsFixture(t);
  await new McpJoinAdapterV1(fixture).advance(fixture.identity);
  const inspection = await new NelosWebInspectorV1(fixture).inspect(
    { schemaVersion: 1, ...fixture.identity }, nativeBoundary(),
  );
  assert.equal(inspection.summary.coordinationCounts.untracked, 1, "finished plan is now outside the active checkpoint");
  assert.equal(inspection.summary.persistedAttentionRequired, 0, "accepted and cleaned history needs no recovery");
  const missingAcceptance = new NelosWebInspectorV1({ ...fixture, acceptanceStore: { async list() { return []; } } });
  assert.equal((await missingAcceptance.inspect(
    { schemaVersion: 1, ...fixture.identity }, nativeBoundary(),
  )).summary.persistedAttentionRequired, 1, "cleanup must not substitute for acceptance");
});

test("receipt replay stays with its issuing plan; the following resume recovers outstanding work", async (t) => {
  const fixture = await unresolvedSpinoffsFixture(t);
  const checkpoint = await fixture.checkpointStore.read(fixture.identity.webId, fixture.identity.queenThreadId);
  const member = checkpoint.members[0];
  // Recreate the last result read before cleanup, then replay its exact receipt
  // after a new adapter starts. This exercises real receipt validation and CAS.
  member.coordination.state = "unjoined";
  member.result = { state: "absent", sourceTurnId: null, envelope: null, errorCode: null };
  checkpoint.checkpointRevision += 1;
  await fixture.checkpointStore.write(checkpoint, { expectedRevision: 1 });
  const { reduceObservationJoinV1 } = await import("../src/orchestration-observation.mjs");
  const effect = reduceObservationJoinV1(checkpoint).effects.find(({ type }) => type === "native-read-result");
  const decision = fixture.decisions.find(({ workUnitId }) => workUnitId === "preflight");
  const receipt = { schemaVersion: 1, type: "native-result-read", actionId: effect.actionId,
    workUnitId: member.workUnitId, specRevision: member.specRevision, attempt: member.attempt,
    bindingGeneration: member.bindingGeneration, memberThreadId: member.memberThreadId,
    requestedTurnId: decision.sourceTurnId, sourceTurnId: decision.sourceTurnId, resultEnvelope: decision.result };
  const adapter = new McpJoinAdapterV1(fixture);
  const first = await adapter.advance({ ...fixture.identity, receipt });
  assert.equal(first.checkpoint.waveScope.planRunId, fixture.runs.finished.planRunId);
  const replay = await new McpJoinAdapterV1(fixture).advance({ ...fixture.identity, receipt });
  assert.equal(replay.nextAction.kind, "advance-orchestration", "a completed receipt does not mean the web is complete");
  assert.deepEqual(await new McpJoinAdapterV1(fixture).advance({ ...fixture.identity, receipt }), replay);
  assert.equal((await adapter.advance(fixture.identity)).checkpoint.waveScope.planRunId, fixture.runs.unfinished.planRunId);
  assert.deepEqual(await fixture.acceptanceStore.list(fixture.identity), fixture.decisions, "recovery never invents acceptance");
});


test("final spinoff cleanup explicitly resumes the remaining independent plan", async (t) => {
  const fixture = await unresolvedSpinoffsFixture(t, { finishedCleaned: false });
  const joinAdapter = new McpJoinAdapterV1(fixture);
  const cleanupAction = (await joinAdapter.advance(fixture.identity)).nextAction;
  assert.equal(cleanupAction.kind, "cleanup-spinoffs");
  assert.equal(cleanupAction.arguments.planRunId, fixture.runs.finished.planRunId);
  const lifecycle = new SpinoffLifecycleAdapterV1({
    ...fixture,
    store: new SpinoffLifecycleStoreV1({ directory: join(fixture.root, "lifecycle") }),
    configuration: { async get() { return { setting: { value: "auto" } }; } },
  });
  const requested = await lifecycle.cleanup(cleanupAction.arguments);
  assert.deepEqual(requested.effects.map(({ threadId }) => threadId), ["task-preflight"]);
  const archiveReceipts = requested.effects.map(({ actionId, threadId }) => ({
    schemaVersion: 1, type: "native-archive", actionId, threadId, archived: true,
  }));
  const cleaned = await lifecycle.cleanup({ ...cleanupAction.arguments, archiveReceipts });
  assert.equal(cleaned.state, "complete");
  assert.deepEqual(cleaned.nextAction, {
    schemaVersion: 1, kind: "advance-orchestration", tool: "nelos_orchestrate_advance",
    arguments: { ...fixture.identity, receipt: null },
  });
  const replay = await lifecycle.cleanup({ ...cleanupAction.arguments, archiveReceipts });
  assert.deepEqual(replay.effects, []);
  assert.deepEqual(replay.nextAction, cleaned.nextAction);
  const resumed = await joinAdapter.advance(cleaned.nextAction.arguments);
  assert.equal(resumed.checkpoint.waveScope.planRunId, fixture.runs.unfinished.planRunId);
  assert.deepEqual(resumed.checkpoint.members.map(({ workUnitId }) => workUnitId), ["keys", "telemetry", "template"]);
  assert.notEqual(resumed.nextAction?.kind, "complete");
});


test("an older unresolved wave is recovered even when the latest wave in the same plan is settled", async (t) => {
  const fixture = await unresolvedSpinoffsFixture(t);
  await rm(join(fixture.root, "plans"), { recursive: true });
  const planned = planWorkSlices({
    schemaVersion: 1, objective: "Recover an earlier wave", maxParallel: 3,
    slices: incident.members.map(({ id }) => ({
      id, title: id, objective: "Fixture work", deliverable: "Verified result",
      acceptanceCriteria: ["Verification passes"],
      dependsOn: id === "preflight" ? ["template", "telemetry", "keys"] : [],
      lifecycle: "spinoff", workspaceMode: "isolated-write", taskShape: "everyday",
    })),
  });
  let run = await fixture.planRunStore.create(createPlanRunV1(planned, {
    queenThreadId: fixture.identity.queenThreadId, sourceId: "earlier-wave-recovery",
    webIdentity: { schemaVersion: 1, ...fixture.identity, queenTitle: "👑 A1 · Fixture queen" },
  }));
  for (const wave of run.waves) {
    run = await fixture.planRunStore.markWaveVerified({ planRunId: run.planRunId,
      queenThreadId: fixture.identity.queenThreadId, waveIndex: wave.waveIndex, waveDigest: wave.waveDigest });
  }
  // Both waves were cleaned historically, but the first now lacks acceptance
  // for its current attempts. Historical cleanup cannot settle those attempts.
  for (const wave of run.waves) {
    run = await fixture.planRunStore.markWaveCleaned({ planRunId: run.planRunId,
      queenThreadId: fixture.identity.queenThreadId, waveIndex: wave.waveIndex, waveDigest: wave.waveDigest });
  }
  const checkpoint = await fixture.checkpointStore.read(fixture.identity.webId, fixture.identity.queenThreadId);
  const member = checkpoint.members[0];
  member.coordination.state = "unjoined";
  member.result = { state: "absent", sourceTurnId: null, envelope: null, errorCode: null };
  const pendingCheckpoint = await fixture.checkpointStore.write({ ...checkpoint, checkpointRevision: 2,
    waveScope: { planRunId: run.planRunId, waveIndex: 2, waveDigest: run.waves[1].waveDigest },
  }, { expectedRevision: 1 });
  const { reduceObservationJoinV1 } = await import("../src/orchestration-observation.mjs");
  const effect = reduceObservationJoinV1(pendingCheckpoint).effects.find(({ type }) => type === "native-read-result");
  const decision = fixture.decisions.find(({ workUnitId }) => workUnitId === "preflight");
  const receipt = { schemaVersion: 1, type: "native-result-read", actionId: effect.actionId,
    workUnitId: member.workUnitId, specRevision: member.specRevision, attempt: member.attempt,
    bindingGeneration: member.bindingGeneration, memberThreadId: member.memberThreadId,
    requestedTurnId: decision.sourceTurnId, sourceTurnId: decision.sourceTurnId, resultEnvelope: decision.result };
  await new McpJoinAdapterV1(fixture).advance({ ...fixture.identity, receipt });
  const pinned = await new McpJoinAdapterV1(fixture).advance({ ...fixture.identity, receipt });
  assert.equal(pinned.checkpoint.waveScope.waveIndex, 2);
  assert.equal(pinned.nextAction.kind, "advance-orchestration", "same plan ID cannot hide a different unresolved wave");
  const result = await new McpJoinAdapterV1(fixture).advance(pinned.nextAction.arguments);
  assert.deepEqual(result.checkpoint.waveScope, {
    planRunId: run.planRunId, waveIndex: 1, waveDigest: run.waves[0].waveDigest,
  });
  assert.deepEqual(result.checkpoint.members.map(({ workUnitId }) => workUnitId), ["keys", "telemetry", "template"]);
  assert.notEqual(result.nextAction?.kind, "complete");
  assert.deepEqual(await new McpJoinAdapterV1(fixture).advance(fixture.identity), result);
});

test("inspection requires every current plan occurrence to settle a reused slice", async (t) => {
  for (const replacement of [false, true]) {
    for (const finishedCleaned of [false, true]) {
      const fixture = await unresolvedSpinoffsFixture(t, { finishedCleaned });
      const previous = fixture.runs.finished;
      const checkpoint = await fixture.checkpointStore.read(fixture.identity.webId, fixture.identity.queenThreadId);
      await fixture.checkpointStore.write({ ...checkpoint, checkpointRevision: 2, waveScope: null, members: [] }, { expectedRevision: 1 });
      let next = await fixture.planRunStore.create(createPlanRunV1(previous.plan, {
        queenThreadId: fixture.identity.queenThreadId, sourceId: "reused-preflight",
        parentPlanRun: replacement ? previous : null, webIdentity: previous.webIdentity,
      }));
      const wave = { planRunId: next.planRunId, queenThreadId: fixture.identity.queenThreadId,
        waveIndex: 1, waveDigest: next.waves[0].waveDigest };
      next = await fixture.planRunStore.markWaveVerified(wave);
      const inspect = () => new NelosWebInspectorV1(fixture).inspect(
        { schemaVersion: 1, ...fixture.identity }, nativeBoundary());
      assert.equal((await inspect()).summary.persistedAttentionRequired, 4,
        "a settled old occurrence cannot hide an uncleaned current occurrence");
      await fixture.planRunStore.markWaveCleaned(wave);
      assert.equal((await inspect()).summary.persistedAttentionRequired,
        replacement || finishedCleaned ? 3 : 4,
        "only superseded ancestors may be ignored; independent occurrences must all settle");
    }
  }
});

test("inspection counts unresolved occurrences outside a matching current checkpoint", async (t) => {
  for (const replacement of [false, true]) {
    for (const finishedCleaned of [false, true]) {
      const fixture = await unresolvedSpinoffsFixture(t, { finishedCleaned });
      const inspect = () => new NelosWebInspectorV1(fixture).inspect(
        { schemaVersion: 1, ...fixture.identity }, nativeBoundary());
      assert.equal((await inspect()).summary.persistedAttentionRequired, 3,
        "the active occurrence awaiting normal cleanup is not additional attention");
      const previous = fixture.runs.finished;
      const next = await fixture.planRunStore.create(createPlanRunV1(previous.plan, {
        queenThreadId: fixture.identity.queenThreadId, sourceId: "reused-current-preflight",
        parentPlanRun: replacement ? previous : null, webIdentity: previous.webIdentity,
      }));
      const wave = { planRunId: next.planRunId, queenThreadId: fixture.identity.queenThreadId,
        waveIndex: 1, waveDigest: next.waves[0].waveDigest };
      await fixture.planRunStore.markWaveVerified(wave);
      assert.equal((await inspect()).summary.persistedAttentionRequired, 4,
        "matching binding cannot hide another unsettled plan occurrence");
      await fixture.planRunStore.markWaveCleaned(wave);
      assert.equal((await inspect()).summary.persistedAttentionRequired, 3);
    }
  }
});
