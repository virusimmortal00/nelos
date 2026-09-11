import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutorRetryServiceV1, normalizeExecutorRetryPolicyV1 } from "../src/executor-retry-service.mjs";
import { executorRepositoryIdentityV1 } from "../src/executor-job-service.mjs";
import { executorDigest } from "../src/executor-contract.mjs";
import { serveExecutorJobV1, ExecutorServiceClientV1 } from "../src/executor-service-channel.mjs";
import { mockStdioAppServer } from "./support/mock-stdio-app-server.mjs";
import { formatResultEnvelope } from "../src/work-result.mjs";

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nr-")));
  const cwd = join(root, "repo"), directory = join(root, "svc"), codexHome = join(root, "home");
  await mkdir(cwd); await mkdir(codexHome); await promisify(execFile)("git", ["init", "--quiet", cwd]);
  const repositoryId = await executorRepositoryIdentityV1(cwd), expiresAt = Date.now() + 600_000;
  const config = { schemaVersion: 2, attempts: [1, 2].map((attempt) => {
    const prompt = `Read fixture, attempt ${attempt}`;
    return { schemaVersion: 1, command: "/test/codex", codexHome, hostId: "host", expiresAt, job: {
      wave: { schemaVersion: 1, backend: "nelos-app-server", planRunId: `run:${"a".repeat(40)}`, waveIndex: 1,
        waveDigest: executorDigest(prompt), members: [{ sliceId: "worker", workUnitId: "job", specRevision: 1, attempt,
          launchSequence: 1, target: { hostId: "host", codexHomeId: executorDigest(codexHome), repositoryId, cwd },
          workspaceMode: "shared-read-only", model: "gpt-6-astra", reasoningEffort: "medium", permissionProfile: ":read-only",
          approvalPolicy: "never", title: "Worker", promptDigest: executorDigest(prompt) }] },
      workUnits: [{ webId: "A1", queenThreadId: "parent", workUnitId: "job", specRevision: 1, attempt, memberKind: "spinoff",
        capabilities: ["observe", "read-result"], title: "Worker", objectiveSummary: "Read fixture", deliverable: "Envelope",
        acceptanceCriteria: ["Expected result"], dependencies: [], required: true,
        policy: { maxAttempts: 2, onBlocked: "queen-review", onFailure: "queen-review" } }],
      prompts: [{ sliceId: "worker", text: prompt }],
    } };
  }) };
  const threads = new Map(); let missingModel = false, onSecondTurn = null;
  const server = mockStdioAppServer(({ method, params }) => {
    if (method === "initialize") return { userAgent: "future-client/dev", codexHome, platformFamily: "unix", platformOs: "macos" };
    if (method === "account/read") return { requiresOpenaiAuth: true, account: { type: "chatgpt", email: "private@example.invalid" } };
    if (method === "model/list") return { data: missingModel ? [] : [{ model: "gpt-6-astra", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] };
    if (method === "permissionProfile/list") return { data: [{ id: ":read-only", allowed: true }] };
    if (method === "configRequirements/read") return { requirements: null };
    if (method === "config/read") return { config: { fixture: true } };
    if (method === "thread/start") {
      const thread = { id: `child-${threads.size + 1}`, cwd, turns: [] }; threads.set(thread.id, thread);
      return { thread, cwd, model: params.model, activePermissionProfile: { id: params.permissions }, approvalPolicy: params.approvalPolicy };
    }
    if (method === "thread/name/set") { threads.get(params.threadId).name = params.name; return {}; }
    if (method === "thread/read") return { thread: threads.get(params.threadId) };
    if (method === "turn/start") {
      const thread = threads.get(params.threadId); thread.turns = [{ id: `turn-${threads.size}`, status: "inProgress", items: [] }];
      if (threads.size === 2) onSecondTurn?.();
      return { turn: thread.turns[0] };
    }
    throw new Error("unexpected fixture method");
  });
  let retryNow = Date.now();
  const create = () => new ExecutorRetryServiceV1({ config, directory, now: () => retryNow, runtimeGeneration: "b".repeat(64), sessionOptions: { spawnProcess: server.spawnProcess } });
  let service = create(); await service.start(); let endpoint = await serveExecutorJobV1({ service, directory });
  const clients = [];
  const connect = async () => { const client = await ExecutorServiceClientV1.connect(endpoint.descriptorPath); clients.push(client); return client; };
  t.after(async () => {
    clients.forEach((client) => client.close());
    if (service.status().activities) server.children.at(-1).emit("exit", 1); else service.drain();
    await service.stopped; await endpoint.close(); await rm(root, { recursive: true, force: true });
  });
  return { root, directory, config, server, connect, expireRetry() { retryNow = expiresAt + 1; }, setMissingModel(value) { missingModel = value; },
    onSecondTurn(callback) { onSecondTurn = callback; }, status: () => service.status(), create,
    finish(attempt, status = "completed") {
      const thread = threads.get(`child-${attempt}`);
      thread.turns[0] = { id: `turn-${attempt}`, status, items: status === "completed" ? [{ type: "agentMessage", phase: "final_answer",
        text: formatResultEnvelope({ schemaVersion: 1, workUnitId: "job", specRevision: 1, attempt, outcome: "succeeded",
          summary: "Expected result", artifacts: [], verification: ["Fixture read"], blockers: [], recoveryHint: null }) }] : [] };
    },
    async restart() {
      clients.forEach((client) => client.close());
      server.children.at(-1).emit("exit", 1); await service.stopped; await endpoint.close();
      service = create(); await service.start(); endpoint = await serveExecutorJobV1({ service, directory });
    },
  };
}

test("preauthorized retry is bounded, replay-safe and preserves attempt-specific acceptance across restart", async (t) => {
  const f = await fixture(t), client = await f.connect(); await client.request("launch");
  f.finish(1, "interrupted");
  const results = await Promise.all([client.request("retry", { expectedAttempt: 1 }), client.request("retry", { expectedAttempt: 1 })]);
  assert.equal(results[0].kind, "wave-started"); assert.equal(results[1].kind, "existing-operation");
  assert.equal(f.status().attempt, 2); assert.equal(f.status().previousAttempts[0].threadId, "child-1");
  f.finish(2); const collected = await client.request("collect"); assert.equal(collected.result.result.attempt, 2);
  await assert.rejects(client.request("join", { expectedAttempt: 1, decision: "accepted", decisionSummary: "stale" }), { code: "stale-attempt-decision" });
  const decision = { expectedAttempt: 2, decision: "accepted", decisionSummary: "Verified second attempt" };
  const joined = await client.request("join", decision); assert.equal(joined.readiness.entries[0].accepted, true);
  await f.restart(); const second = await f.connect();
  assert.deepEqual(await second.request("collect"), collected);
  assert.deepEqual(await second.request("join", decision), joined);
  assert.equal((await second.request("retry", { expectedAttempt: 1 })).kind, "existing-operation");
  await assert.rejects(second.request("retry", { expectedAttempt: 2 }), { code: "retry-attempt-limit" });
  assert.equal(f.server.requests.filter(({ method }) => method === "thread/start").length, 2);
  assert.equal(f.server.requests.filter(({ method }) => method === "turn/start").length, 2);
});

for (const status of ["inProgress", "completed", "failed"]) {
  test(`retry refuses ${status} work without another turn`, async (t) => {
    const f = await fixture(t), client = await f.connect(); await client.request("launch");
    if (status !== "inProgress") f.finish(1, status);
    await assert.rejects(client.request("retry", { expectedAttempt: 1 }), { code: "confirmed-interruption-required" });
    assert.equal(f.server.requests.filter(({ method }) => method === "turn/start").length, 1);
  });
}

test("retry policy cannot broaden route, permissions, scope or attempt budget", async (t) => {
  const f = await fixture(t);
  for (const mutate of [
    (p) => { p.attempts[1].job.wave.members[0].model = "other"; },
    (p) => { p.attempts[1].job.workUnits[0].queenThreadId = "another"; },
    (p) => { p.attempts[1].job.workUnits[0].policy.maxAttempts = 3; },
    (p) => { p.attempts[1].job.wave.members[0].permissionProfile = ":workspace"; },
  ]) { const altered = structuredClone(f.config); mutate(altered); assert.throws(() => normalizeExecutorRetryPolicyV1(altered)); }
  const client = await f.connect();
  await assert.rejects(client.request("retry", { expectedAttempt: 1, prompt: "replace" }), { code: "invalid-contract" });
});

test("a retry marker cannot manufacture a confirmed interruption", async (t) => {
  const f = await fixture(t), client = await f.connect(); await client.request("launch");
  const path = join(f.directory, "retry-2.json");
  await writeFile(path, JSON.stringify({ fromAttempt: 1 }), { mode: 0o600 });
  // The second owner must reject the marker after the current owner is stopped.
  f.finish(1, "interrupted"); await client.request("collect");
  await assert.rejects(f.restart(), { code: "retry-evidence-mismatch" });
  await rm(path);
});

test("a selected but unstarted retry survives restart and needs a fresh capability grant", async (t) => {
  const f = await fixture(t), client = await f.connect(); await client.request("launch");
  f.finish(1, "interrupted"); await client.request("collect"); f.setMissingModel(true);
  assert.equal((await client.request("retry", { expectedAttempt: 1 })).kind, "execution-unavailable");
  assert.equal(f.status().attempt, 2);
  await f.restart(); const fresh = await f.connect(); f.setMissingModel(false);
  assert.equal((await fresh.request("retry", { expectedAttempt: 1 })).kind, "wave-started");
  f.finish(2); await fresh.request("collect");
  assert.equal(f.server.requests.filter(({ method }) => method === "turn/start").length, 2);
});

test("a lost retry response cannot duplicate the selected attempt", async (t) => {
  const f = await fixture(t), client = await f.connect(); await client.request("launch"); f.finish(1, "interrupted");
  f.onSecondTurn(() => client.close());
  await assert.rejects(client.request("retry", { expectedAttempt: 1 }), { code: "service-disconnected-outcome-unknown" });
  const fresh = await f.connect();
  assert.equal((await fresh.request("retry", { expectedAttempt: 1 })).kind, "existing-operation");
  f.finish(2); await fresh.request("collect");
  assert.equal(f.server.requests.filter(({ method }) => method === "turn/start").length, 2);
});

test("expired retry authorization preserves the interrupted attempt", async (t) => {
  const f = await fixture(t), client = await f.connect();
  assert.equal((await client.request("launch")).kind, "wave-started"); f.finish(1, "interrupted"); await client.request("collect");
  f.expireRetry();
  await assert.rejects(client.request("retry", { expectedAttempt: 1 }), { code: "retry-authorization-expired" });
  assert.equal(f.status().attempt, 1);
});
