import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpJoinAdapterV1 } from "../src/mcp-observation.mjs";
import { NelosWebInspectorV1 } from "../src/web-inspection.mjs";
import { SpinoffLifecycleAdapterV1, SpinoffLifecycleStoreV1 } from "../src/spinoff-lifecycle.mjs";
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
