import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, rm, readFile, chmod, writeFile, unlink, readdir, stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { ExecutorJobServiceV1, executorRepositoryIdentityV1 } from "../src/executor-job-service.mjs";
import { serveExecutorJobV1, ExecutorServiceClientV1 } from "../src/executor-service-channel.mjs";
import { executorDigest } from "../src/executor-contract.mjs";
import { mockStdioAppServer } from "./support/mock-stdio-app-server.mjs";
import { formatResultEnvelope } from "../src/work-result.mjs";
import { ExecutorCompletionOutboxV1 } from "../src/executor-completion-outbox.mjs";

async function fixture(t, { missingModel = false, expired = false, reorderConfig = false, projectBookkeeping = false, effectiveConfigChange = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nj-")));
  const cwd = join(root, "repo"), directory = join(root, "svc"), codexHome = join(root, "home");
  await mkdir(cwd); await mkdir(codexHome);
  await promisify(execFile)("git", ["init", "--quiet", cwd]);
  const prompt = "Return the requested result envelope.";
  const config = { schemaVersion: 1, command: "/test/codex", codexHome, hostId: "test-host",
    expiresAt: Date.now() + (expired ? -1 : 600_000), job: {
      wave: { schemaVersion: 1, backend: "nelos-app-server", planRunId: `run:${"a".repeat(40)}`,
        waveIndex: 1, waveDigest: executorDigest(prompt), members: [{ sliceId: "worker", workUnitId: "job-1",
          specRevision: 1, attempt: 1, launchSequence: 1, target: { hostId: "test-host", codexHomeId: executorDigest(codexHome),
            repositoryId: await executorRepositoryIdentityV1(cwd), cwd }, workspaceMode: "shared-read-only",
          model: "gpt-6-astra", reasoningEffort: "medium", permissionProfile: ":read-only", approvalPolicy: "never",
          title: "Read-only worker", promptDigest: executorDigest(prompt) }] },
      workUnits: [{ webId: "A1", queenThreadId: "parent", workUnitId: "job-1", specRevision: 1, attempt: 1,
        memberKind: "spinoff", capabilities: ["observe", "read-result"], title: "Read-only worker",
        objectiveSummary: "Read the fixture", deliverable: "Envelope", acceptanceCriteria: ["Expected summary"],
        dependencies: [], required: true, policy: { maxAttempts: 1, onBlocked: "queen-review", onFailure: "queen-review" } }],
      prompts: [{ sliceId: "worker", text: prompt }],
    } };
  let created = false;
  let title = null, turns = [], configReads = 0, accountChanged = false, readCwd = cwd, changeAccountDuringRead = false;
  const server = mockStdioAppServer(({ method, params }) => {
    if (method === "initialize") return { userAgent: "future-client/dev", codexHome, platformFamily: "unix", platformOs: "macos" };
    if (method === "account/read") return { requiresOpenaiAuth: true, account: { type: "chatgpt", email: accountChanged ? "different@example.invalid" : "secret@example.invalid" } };
    if (method === "model/list") return { data: missingModel ? [] : [{ model: "gpt-6-astra", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] };
    if (method === "permissionProfile/list") return { data: [{ id: ":read-only", allowed: true }] };
    if (method === "configRequirements/read") return { requirements: null };
    if (method === "config/read") {
      assert.equal(params.cwd, cwd);
      return { config: projectBookkeeping ? { projects: created ? { [cwd]: { trust_level: "trusted" } } : {}, fixture: effectiveConfigChange && created ? "changed" : true } : reorderConfig && ++configReads % 2 ? { one: 1, nested: { b: 2, a: 1 } } : reorderConfig ? { nested: { a: 1, b: 2 }, one: 1 } : { fixture: true } };
    }
    if (method === "thread/start") created = true;
    if (method === "thread/start") return { thread: { id: "child", cwd }, cwd, model: params.model,
      activePermissionProfile: { id: params.permissions }, approvalPolicy: params.approvalPolicy };
    if (method === "thread/name/set") { title = params.name; return {}; }
    if (method === "thread/read") { if (changeAccountDuringRead) accountChanged = true; return { thread: { id: "child", name: title, cwd: readCwd, turns } }; }
    if (method === "turn/start") { turns = [{ id: "turn", status: "inProgress", items: [] }]; return { turn: turns[0] }; }
    throw new Error("unexpected fixture method");
  });
  const create = () => new ExecutorJobServiceV1({ config, directory, runtimeGeneration: "b".repeat(64),
    sessionOptions: { spawnProcess: server.spawnProcess } });
  let service = create(); await service.start(); let endpoint = await serveExecutorJobV1({ service, directory });
  const clients = [];
  const connect = async () => { const c = await ExecutorServiceClientV1.connect(endpoint.descriptorPath); clients.push(c); return c; };
  t.after(async () => {
    for (const client of clients) client.close();
    if (service.status().activities) server.children.at(-1).emit("exit", 0);
    else service.drain();
    await service.stopped; await endpoint.close(); await rm(root, { recursive: true, force: true });
  });
  return { config, root, directory, server, connect, status: () => service.status(),
    descriptor: () => endpoint.descriptorPath,
    changeAccount() { accountChanged = true; },
    changeAccountDuringRead() { changeAccountDuringRead = true; },
    changeReadTarget() { readCwd = "/another-repository"; },
    setTurns(value) { turns = value; },
    finish() { turns = [{ id: "turn", status: "completed", items: [{ type: "agentMessage", phase: "final_answer",
      text: formatResultEnvelope({ schemaVersion: 1, workUnitId: "job-1", specRevision: 1, attempt: 1,
        outcome: "succeeded", summary: "Expected summary", artifacts: [], verification: ["Fixture verified"], blockers: [], recoveryHint: null }) }] }]; },
    async restart({ staleDescriptor = null, crash = false } = {}) {
      for (const client of clients) client.close();
      if (crash) server.children.at(-1).emit("exit", 1); else service.drain();
      await service.stopped; await endpoint.close();
      if (staleDescriptor) await writeFile(endpoint.descriptorPath, staleDescriptor, { mode: 0o600 });
      service = create(); await service.start(); endpoint = await serveExecutorJobV1({ service, directory });
    },
  };
}

test("private client reconnect collects one worker and persists a separate parent join across restart", async (t) => {
  const f = await fixture(t), first = await f.connect();
  assert.equal((await first.request("launch")).kind, "wave-started");
  first.close();
  assert.equal(f.status().activities, 1);
  const second = await f.connect();
  assert.equal((await second.request("launch")).kind, "existing-operation");
  await assert.rejects(second.request("join", { decision: "accepted", decisionSummary: "Premature" }), { code: "validated-terminal-result-required" });
  f.finish();
  const result = await second.request("collect");
  assert.equal(result.result.workOutcome, "succeeded");
  const accepted = await second.request("join", { decision: "accepted", decisionSummary: "Checked fixture evidence" });
  assert.equal(accepted.readiness.entries[0].accepted, true);
  assert.equal(accepted.decision.queenThreadId, "parent");
  assert.deepEqual(await second.request("join", { decision: "accepted", decisionSummary: "Checked fixture evidence" }), accepted);
  await f.restart();
  const third = await f.connect();
  assert.equal((await third.request("collect")).result.workOutcome, "succeeded");
  assert.deepEqual(await third.request("join", { decision: "accepted", decisionSummary: "Checked fixture evidence" }), accepted);
  assert.equal(f.server.requests.filter(({ method }) => method === "thread/start").length, 1);
  assert.equal(f.server.requests.filter(({ method }) => method === "turn/start").length, 1);
  assert.doesNotMatch(JSON.stringify([result, accepted, await third.request("status")]), /secret@example/);
});

test("terminal notifications persist a bounded parent notice without a frontend and rebuild it after restart", async (t) => {
  const f = await fixture(t), client = await f.connect();
  assert.deepEqual((await client.request("notifications")).notifications, []);
  await client.request("launch"); client.close(); f.finish();
  f.server.children.at(-1).stdout.write(JSON.stringify({ method: "turn/completed", params: { threadId: "child", turn: { id: "turn", status: "completed" } } }) + "\n");
  for (let i = 0; i < 100 && f.status().activities; i++) await delay(20);
  assert.equal(f.status().activities, 0);
  const path = join(f.directory, "notifications", "completion.json");
  const stored = JSON.parse(await readFile(path, "utf8"));
  assert.equal(stored.notification.parentThreadId, "parent");
  assert.equal(stored.notification.threadId, "child"); assert.equal(stored.notification.turnId, "turn");
  assert.equal(stored.acknowledged, false); assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(stored), /Expected summary|secret@example|Return the requested/);
  await unlink(path); // Crash window between terminal journal and notice projection.
  await f.restart();
  const fresh = await f.connect();
  assert.deepEqual((await fresh.request("notifications")).notifications, [{ ...stored.notification, acknowledged: false }]);
  assert.equal(f.server.requests.filter(({ method }) => method === "turn/start").length, 1);
});

test("a lost acknowledgment response is replay-safe and never accepts the worker result", async (t) => {
  const f = await fixture(t), client = await f.connect(); await client.request("launch"); f.finish(); await client.request("collect");
  const [notice] = (await client.request("notifications")).notifications;
  const args = { notificationId: notice.notificationId, expectedAttempt: 1 };
  const original = ExecutorCompletionOutboxV1.prototype.acknowledge; let lose = true;
  t.mock.method(ExecutorCompletionOutboxV1.prototype, "acknowledge", async function (params) {
    const result = await original.call(this, params);
    if (lose) { lose = false; client.close(); }
    return result;
  });
  await assert.rejects(client.request("acknowledge", args), { code: "service-disconnected-outcome-unknown" });
  await f.restart(); const fresh = await f.connect();
  const receipt = await fresh.request("acknowledge", args);
  assert.equal(receipt.acknowledged, true);
  assert.deepEqual(await fresh.request("acknowledge", args), receipt);
  assert.deepEqual((await fresh.request("notifications")).notifications, [receipt]);
  assert.deepEqual(await readdir(join(f.directory, "acceptances")).catch((e) => { if (e.code === "ENOENT") return []; throw e; }), []);
  assert.equal(f.status().completionDelivery.detachedWakeAvailable, false);
});

test("acknowledgment rejects nonexistent, forged and wrong-attempt receipts and detects outbox corruption", async (t) => {
  const f = await fixture(t), client = await f.connect();
  await assert.rejects(client.request("acknowledge", { notificationId: `completion:${"0".repeat(64)}`, expectedAttempt: 1 }), { code: "notification-acknowledgment-mismatch" });
  await client.request("launch"); f.finish(); await client.request("collect");
  const [notice] = (await client.request("notifications")).notifications;
  await assert.rejects(client.request("acknowledge", { notificationId: notice.notificationId, expectedAttempt: 2 }), { code: "notification-acknowledgment-mismatch" });
  await assert.rejects(client.request("acknowledge", { notificationId: notice.notificationId, expectedAttempt: 1, receipt: { threadId: "parent" } }), { code: "invalid-contract" });
  const path = join(f.directory, "notifications", "completion.json"), original = await readFile(path, "utf8");
  await chmod(path, 0o644);
  await assert.rejects(client.request("notifications"), { code: "insecure-service-file" }); await chmod(path, 0o600);
  const changed = JSON.parse(original); changed.notification.parentThreadId = "another-parent";
  await writeFile(path, JSON.stringify(changed));
  await assert.rejects(client.request("notifications"), { code: "notification-evidence-mismatch" });
  assert.equal((await client.request("status")).state, "ready");
  await writeFile(path, original);
});

test("projection failure retains recoverable completion until the next owner repairs the notice", async (t) => {
  const f = await fixture(t), client = await f.connect(); await client.request("launch");
  const original = ExecutorCompletionOutboxV1.prototype.project; let unavailable = true;
  t.mock.method(ExecutorCompletionOutboxV1.prototype, "project", async function () {
    if (unavailable) throw new Error("fixture outbox unavailable"); return original.call(this);
  });
  f.finish(); assert.equal((await client.request("collect")).phase, "terminal");
  assert.equal(f.status().activities, 1); assert.equal(f.status().attention[0].reason, "durable-state-unavailable");
  unavailable = false; await f.restart({ crash: true });
  assert.equal(f.status().activities, 0);
  assert.equal((await (await f.connect()).request("notifications")).notifications.length, 1);
  assert.equal(f.server.requests.filter(({ method }) => method === "turn/start").length, 1);
});

test("frontend JSON cannot replace the approved job, fabricate results, or grant permissions", async (t) => {
  const f = await fixture(t), client = await f.connect();
  await assert.rejects(client.request("launch", { wave: f.config.job.wave }), { code: "invalid-contract" });
  await assert.rejects(client.request("join", { decision: "accepted", decisionSummary: "forged", result: {} }), { code: "invalid-contract" });
  await assert.rejects(client.request("authorize", { decision: "allow" }), { code: "unsupported-service-method" });
  assert.equal(f.server.requests.filter(({ method }) => method === "thread/start").length, 0);
});

for (const options of [{ missingModel: true }, { expired: true }]) {
  test(`job admission denies unavailable or expired authorization: ${JSON.stringify(options)}`, async (t) => {
    const f = await fixture(t, options), client = await f.connect();
    assert.equal((await client.request("launch")).kind, "execution-unavailable");
    assert.equal(f.server.requests.filter(({ method }) => method === "thread/start").length, 0);
  });
}

test("bad bearer credentials and publicly readable descriptors cannot attach", async (t) => {
  const f = await fixture(t), descriptor = JSON.parse(await readFile(f.descriptor(), "utf8"));
  const socket = net.connect(descriptor.socketPath);
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(JSON.stringify({ id: 1, method: "status", params: {}, token: "0".repeat(64) }) + "\n");
  await new Promise((resolve) => socket.once("close", resolve));
  assert.equal(f.status().clients, 0);
  await chmod(f.descriptor(), 0o644);
  await assert.rejects(ExecutorServiceClientV1.connect(f.descriptor()), { code: "insecure-service-file" });
  await chmod(f.descriptor(), 0o600);
});

test("another job cannot reuse the service directory", async (t) => {
  const f = await fixture(t);
  const config = structuredClone(f.config); config.expiresAt += 1;
  const other = new ExecutorJobServiceV1({ config, directory: f.directory, runtimeGeneration: "c".repeat(64),
    sessionOptions: { spawnProcess: f.server.spawnProcess } });
  await assert.rejects(other.start(), { code: "service-job-policy-mismatch" });
  assert.equal(f.server.children.length, 1);
});

test("a live endpoint is never displaced", async (t) => {
  const f = await fixture(t);
  await assert.rejects(serveExecutorJobV1({ directory: f.directory,
    service: { status: () => ({ state: "ready" }) } }), { code: "service-endpoint-already-live" });
  const client = await f.connect(); assert.equal((await client.request("status")).state, "ready");
});

test("a stopped listener's stale descriptor is replaced", async (t) => {
  const f = await fixture(t);
  // Retain the old descriptor after graceful shutdown to model an interrupted
  // cleanup. The new listener must rotate the bearer, preserving the job.
  const old = await readFile(f.descriptor(), "utf8");
  await f.restart({ staleDescriptor: old });
  const current = await readFile(f.descriptor(), "utf8");
  assert.notEqual(JSON.parse(old).token, JSON.parse(current).token);
});

test("equivalent config map ordering does not invalidate authorization", async (t) => {
  const f = await fixture(t, { reorderConfig: true }), client = await f.connect();
  assert.equal((await client.request("launch")).kind, "wave-started");
  f.finish(); assert.equal((await client.request("collect")).phase, "terminal");
});

test("a legacy directory cannot expose a different parent's saved result", async (t) => {
  const f = await fixture(t), client = await f.connect();
  assert.equal((await client.request("launch")).kind, "wave-started");
  f.finish(); await client.request("collect");
  await unlink(join(f.directory, "job-binding.json"));
  const config = structuredClone(f.config); config.job.workUnits[0].queenThreadId = "another-parent";
  const other = new ExecutorJobServiceV1({ config, directory: f.directory, runtimeGeneration: "c".repeat(64),
    sessionOptions: { spawnProcess: f.server.spawnProcess } });
  await assert.rejects(other.start(), { code: "service-job-unit-mismatch" });
  assert.equal(f.server.children.length, 1);
});

test("malformed endpoint JSON cannot echo credential content in an error", async (t) => {
  const f = await fixture(t);
  await writeFile(f.descriptor(), '{"token":"private-bearer-sentinel",broken}', { mode: 0o600 });
  await assert.rejects(ExecutorServiceClientV1.connect(f.descriptor()), (error) => {
    assert.equal(error.code, "invalid-service-file");
    assert.doesNotMatch(error.message, /sentinel/); return true;
  });
});

test("restart observes a recorded running turn until completion without adopting or replaying it", async (t) => {
  const f = await fixture(t), first = await f.connect();
  await first.request("launch"); await f.restart({ crash: true });
  const client = await f.connect();
  assert.equal(f.status().recovery.state, "attention");
  assert.equal(f.status().activities, 1);
  assert.equal((await client.request("collect")).status, "inProgress");
  assert.equal((await client.request("launch")).kind, "existing-operation");
  f.finish();
  assert.equal((await client.request("collect")).status, "completed");
  assert.equal(f.status().recovery.state, "complete");
  assert.equal(f.status().activities, 0);
  assert.equal((await client.request("join", { decision: "accepted", decisionSummary: "Verified recovered fixture" })).readiness.entries[0].accepted, true);
  assert.equal(f.server.requests.filter(({ method }) => method === "thread/start").length, 1);
  assert.equal(f.server.requests.filter(({ method }) => method === "turn/start").length, 1);
  assert.equal(f.server.requests.filter(({ method }) => ["thread/resume", "turn/steer", "turn/interrupt"].includes(method)).length, 0);
});

test("startup collects a completed turn whose result was never cached by the old service", async (t) => {
  const f = await fixture(t), first = await f.connect();
  await first.request("launch"); f.finish(); await f.restart({ crash: true });
  assert.equal(f.status().recovery.state, "complete");
  const client = await f.connect();
  assert.equal((await client.request("collect")).result.workOutcome, "succeeded");
  assert.equal(f.status().activities, 0);
});

for (const mode of ["account", "mid-read-account", "target", "missing-turn", "still-running", "interrupted"]) {
  test(`recorded recovery handles ${mode} without fabricating completion or acceptance`, async (t) => {
    const f = await fixture(t), first = await f.connect(); await first.request("launch");
    if (mode === "account") f.changeAccount();
    if (mode === "mid-read-account") { f.finish(); f.changeAccountDuringRead(); }
    if (mode === "target") f.changeReadTarget();
    if (mode === "missing-turn") f.setTurns([{ id: "other-turn", status: "completed", items: [] }]);
    if (mode === "interrupted") f.setTurns([{ id: "turn", status: "interrupted", items: [] }]);
    await f.restart({ crash: true }); const client = await f.connect();
    if (mode === "interrupted") {
      const result = await client.request("collect");
      assert.equal(result.status, "interrupted"); assert.notEqual(result.result.workOutcome, "succeeded");
      assert.equal(f.status().activities, 0);
      await assert.rejects(client.request("join", { decision: "accepted", decisionSummary: "Do not auto-accept" }), { code: "validated-terminal-result-required" });
    } else {
      assert.equal(f.status().activities, 1); assert.equal(f.status().acceptingLaunches, false);
      if (mode === "still-running") assert.equal((await client.request("collect")).status, "inProgress");
      else await assert.rejects(client.request("collect"));
    }
    assert.equal(f.server.requests.filter(({ method }) => method === "turn/start").length, 1);
  });
}

test("single-job clients can bind a join to its attempt and see retries are unconfigured", async (t) => {
  const f = await fixture(t), client = await f.connect(); await client.request("launch"); f.finish();
  await assert.rejects(client.request("retry", { expectedAttempt: 1 }), { code: "retry-not-configured" });
  await assert.rejects(client.request("join", { expectedAttempt: 2, decision: "accepted", decisionSummary: "Wrong attempt" }), { code: "stale-attempt-decision" });
  assert.equal((await client.request("join", { expectedAttempt: 1, decision: "accepted", decisionSummary: "Correct attempt" })).readiness.entries[0].accepted, true);
});


test("target-effective config tolerates project trust bookkeeping but blocks a real effective config change", async (t) => {
  for (const effectiveConfigChange of [false, true]) {
    const f = await fixture(t, { projectBookkeeping: true, effectiveConfigChange }), client = await f.connect();
    const result = await client.request("launch");
    assert.equal(result.kind, effectiveConfigChange ? "reconciliation-required" : "wave-started");
    if (effectiveConfigChange) assert.equal(result.members[0].reason, "stale-execution-grant");
  }
});
