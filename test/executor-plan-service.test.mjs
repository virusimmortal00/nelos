import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutorPlanServiceV1, normalizeExecutorPlanPolicyV1 } from "../src/executor-plan-service.mjs";
import { executorRepositoryIdentityV1 } from "../src/executor-job-service.mjs";
import { executorDigest } from "../src/executor-contract.mjs";
import { serveExecutorJobV1, ExecutorServiceClientV1 } from "../src/executor-service-channel.mjs";
import { mockStdioAppServer } from "./support/mock-stdio-app-server.mjs";
import { formatResultEnvelope } from "../src/work-result.mjs";

async function fixture(t, { missing = false, interactive = false, mismatchedCreate = false, beforeStart = async () => {}, duringStart = null, requiredToolState = null } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "np-")));
  const source = join(root, "source"), directory = join(root, "svc"), codexHome = join(root, "home");
  await mkdir(source); await mkdir(codexHome);
  const git = async (...args) => (await promisify(execFile)("git", ["-C", source, ...args])).stdout.trim();
  await git("init", "--quiet"); await git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "base");
  const baseCommit = await git("rev-parse", "HEAD"), repositoryId = await executorRepositoryIdentityV1(source);
  const config = { schemaVersion: 4, jobs: ["one", "two", "three"].map((id) => {
    const prompt = `Complete fixture ${id}`, cwd = join(root, "trees", id);
    return { dependsOn: id === "three" ? ["one", "two"] : [], config: {
      ...(requiredToolState ? { requiredMcpTools: [{ server: "filesystem", tool: "write" }] } : {}),
      schemaVersion: 3, command: "/test/codex", codexHome, hostId: "host", expiresAt: Date.now() + 600_000,
      workspace: { sourcePath: source, worktreePath: cwd, branch: `fixture/${id}`, baseCommit },
      job: {
        wave: { schemaVersion: 1, backend: "nelos-app-server", planRunId: `run:${"a".repeat(40)}`, waveIndex: id === "three" ? 2 : 1,
          waveDigest: executorDigest(prompt), members: [{ sliceId: id, workUnitId: id, specRevision: 1, attempt: 1, launchSequence: 1,
            target: { hostId: "host", codexHomeId: executorDigest(codexHome), repositoryId, cwd }, workspaceMode: "isolated-write",
            model: missing && id === "two" ? "missing-model" : "gpt-6-astra", reasoningEffort: "medium", permissionProfile: ":workspace",
            approvalPolicy: interactive ? "on-request" : "never", title: `Worker ${id}`, promptDigest: executorDigest(prompt) }] },
        workUnits: [{ webId: "A1", queenThreadId: "parent", workUnitId: id, specRevision: 1, attempt: 1, memberKind: "spinoff",
          capabilities: ["observe", "read-result"], title: `Worker ${id}`, objectiveSummary: prompt, deliverable: "Envelope",
          acceptanceCriteria: ["Expected result"], dependencies: [], required: true, policy: { maxAttempts: 1, onBlocked: "queen-review", onFailure: "queen-review" } }],
        prompts: [{ sliceId: id, text: prompt }],
      },
    } };
  }) };
  const states = new Map();
  const server = mockStdioAppServer(({ method, params }) => {
    if (method === "initialize") return { userAgent: "future-cli", codexHome, platformFamily: "unix", platformOs: "macos" };
    if (method === "account/read") return { requiresOpenaiAuth: true, account: { type: "chatgpt", email: "fixture@example.invalid" } };
    if (method === "model/list") return { data: [{ model: "gpt-6-astra", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] };
    if (method === "permissionProfile/list") return { data: [{ id: ":workspace", allowed: true }] };
    if (method === "configRequirements/read") return { requirements: null };
    if (method === "mcpServerStatus/list") return { data: [{ name: "filesystem", runtimeStatus: requiredToolState, tools: { write: { name: "write" } } }], nextCursor: null };
    if (method === "config/read") return { config: { fixture: true } };
    if (method === "thread/start") {
      const id = `thread-${states.size + 1}`; const thread = { id, cwd: params.cwd, turns: [] }; states.set(id, thread);
      return { thread, cwd: params.cwd, model: mismatchedCreate ? "wrong-model" : params.model, activePermissionProfile: { id: params.permissions }, approvalPolicy: params.approvalPolicy };
    }
    if (method === "thread/name/set") { states.get(params.threadId).name = params.name; return {}; }
    if (method === "thread/read") return { thread: states.get(params.threadId) };
    if (method === "turn/start") { const thread = states.get(params.threadId); thread.turns = [{ id: `turn-${params.threadId}`, status: "inProgress", items: [] }]; return { turn: thread.turns[0] }; }
    throw new Error(`unexpected method ${method}`);
  });
  const create = () => new ExecutorPlanServiceV1({ config, directory, runtimeGeneration: "b".repeat(64), sessionOptions: { spawnProcess: server.spawnProcess } });
  await beforeStart({ config, directory });
  let service = create(); const starting = service.start(); if (duringStart) await duringStart(service, starting); await starting;
  let endpoint = service.status().state === "ready" ? await serveExecutorJobV1({ service, directory }) : null;
  const clients = []; const connect = async () => { const c = await ExecutorServiceClientV1.connect(endpoint.descriptorPath); clients.push(c); return c; };
  t.after(async () => {
    clients.forEach((c) => c.close());
    if (service.status().activities) server.children.forEach((child) => child.emit("exit", 1));
    service.drain(); await service.stopped; await endpoint?.close(); await rm(root, { recursive: true, force: true });
  });
  return { config, source, root, directory, server, connect, create, status: () => service.status(),
    attachApprovalChannel: (channel) => service.attachApprovalChannel(channel),
    async finish(id) {
      const thread = [...states.values()].find(({ cwd }) => cwd === join(root, "trees", id));
      await writeFile(join(thread.cwd, `${id}.txt`), `Change from ${id}\n`);
      thread.turns[0] = { id: `turn-${thread.id}`, status: "completed", items: [{ type: "agentMessage", phase: "final_answer",
        text: formatResultEnvelope({ schemaVersion: 1, workUnitId: id, specRevision: 1, attempt: 1, outcome: "succeeded", summary: "Expected result",
          artifacts: [`${id}.txt`], verification: ["Fixture wrote isolated artifact"], blockers: [], recoveryHint: null }) }] };
    },
    async restart() { clients.forEach((c) => c.close()); service.drain(); await service.stopped; await endpoint.close(); service = create(); await service.start(); endpoint = await serveExecutorJobV1({ service, directory }); },
  };
}

test("owned plan provisions distinct worktrees and waits for every dependency acceptance across restart", async (t) => {
  const f = await fixture(t), client = await f.connect();
  assert.equal((await client.request("launch")).members.length, 2);
  assert.equal(f.server.requests.filter(({ method }) => method === "turn/start").length, 2);
  for (const id of ["one", "two"]) { await f.finish(id); await client.request("collect", { workUnitId: id }); }
  await client.request("join", { workUnitId: "one", expectedAttempt: 1, decision: "accepted", decisionSummary: "Verified one" });
  assert.equal((await client.request("launch")).kind, "no-ready-work");
  await f.restart(); const fresh = await f.connect();
  assert.equal((await fresh.request("launch")).kind, "no-ready-work");
  await fresh.request("join", { workUnitId: "two", expectedAttempt: 1, decision: "accepted", decisionSummary: "Verified two" });
  assert.equal((await fresh.request("launch")).members[0].workUnitId, "three");
  await f.finish("three"); await fresh.request("collect", { workUnitId: "three" });
  const result = await fresh.request("join", { workUnitId: "three", expectedAttempt: 1, decision: "accepted", decisionSummary: "Verified three" });
  assert.ok(result.readiness.entries.every(({ accepted }) => accepted));
  assert.equal((await fresh.request("notifications")).notifications.length, 3);
  assert.equal(f.server.requests.filter(({ method }) => method === "turn/start").length, 3);
  await assert.rejects(readFile(join(f.source, "one.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(f.root, "trees", "one", "one.txt"), "utf8"), "Change from one\n");
});

test("plan preflight checks every ready member before creating any native thread", async (t) => {
  const f = await fixture(t, { missing: true }), client = await f.connect();
  assert.equal((await client.request("launch")).kind, "execution-unavailable");
  assert.equal(f.server.requests.filter(({ method }) => method === "thread/start").length, 0);
});

test("interactive jobs require an attached trusted approval channel", async (t) => {
  const f = await fixture(t, { interactive: true }), client = await f.connect();
  assert.equal((await client.request("launch")).kind, "execution-unavailable");
  assert.equal(f.server.requests.filter(({ method }) => method === "thread/start").length, 0);
  const controller = new AbortController();
  const detach = f.attachApprovalChannel({ signal: controller.signal, request: async ({ requestToken }) => ({ requestToken, response: { decision: "decline" } }) });
  assert.equal((await client.request("launch")).members.length, 2);
  for (const id of ["one", "two"]) { await f.finish(id); await client.request("collect", { workUnitId: id }); }
  detach(); controller.abort();
});

test("plan policy rejects cycles, workspace overlap, reused branches and foreign parent identities", async (t) => {
  const f = await fixture(t);
  for (const mutate of [
    (p) => { p.jobs[0].dependsOn = ["three"]; },
    (p) => { p.jobs[1].config.workspace.worktreePath = p.jobs[0].config.workspace.worktreePath; p.jobs[1].config.job.wave.members[0].target.cwd = p.jobs[0].config.workspace.worktreePath; },
    (p) => { p.jobs[1].config.workspace.branch = p.jobs[0].config.workspace.branch; },
    (p) => { p.jobs[1].config.job.workUnits[0].queenThreadId = "other"; },
  ]) { const config = structuredClone(f.config); mutate(config); assert.throws(() => normalizeExecutorPlanPolicyV1(config)); }
});


test("a partial wave keeps unlaunched siblings blocked while the created operation needs reconciliation", async (t) => {
  const f = await fixture(t, { mismatchedCreate: true }), client = await f.connect();
  const result = await client.request("launch");
  assert.equal(result.members.length, 1);
  assert.equal(result.members[0].result.kind, "reconciliation-required");
  assert.equal((await client.request("launch")).kind, "reconciliation-required");
  assert.equal(f.server.requests.filter(({ method }) => method === "thread/start").length, 1);
  assert.equal(f.server.requests.filter(({ method }) => method === "turn/start").length, 0);
});


test("drain rejects before start and includes every child created during asynchronous startup", async (t) => {
  const f = await fixture(t, { duringStart: async (service, starting) => {
    assert.equal(service.status().state, "starting");
    service.drain(); await starting; await service.stopped;
    assert.equal(service.status().state, "stopped");
    assert.equal(service.status().jobs.length, 3);
    assert.ok(service.status().jobs.every(({ state }) => state === "stopped"));
  } });
  assert.throws(() => f.create().drain(), /supervisor-not-started/);
});

test("a corrupt failed job remains inspectable and blocks launches without hiding healthy jobs", async (t) => {
  const f = await fixture(t, { beforeStart: async ({ directory }) => {
    const journal = join(directory, executorDigest("one").slice(0, 16), "journal");
    await mkdir(journal, { recursive: true, mode: 0o700 });
    await writeFile(join(journal, `${executorDigest("one")}.json`), "{broken", { mode: 0o600 });
  } }), client = await f.connect();
  const status = await client.request("status");
  assert.ok(status.jobs.find(({ workUnitId }) => workUnitId === "one").error);
  assert.equal(status.jobs.find(({ workUnitId }) => workUnitId === "two").error, null);
  assert.equal(status.readiness.entries.find(({ workUnitId }) => workUnitId === "one").reason, "executor-state-unavailable");
  assert.equal((await client.request("launch")).kind, "reconciliation-required");
});

test("required worker tools must connect on the owned thread before any model turn starts", async (t) => {
  for (const requiredToolState of ["connected", "failed"]) {
    const f = await fixture(t, { requiredToolState }), client = await f.connect();
    const result = await client.request("launch");
    if (requiredToolState === "connected") {
      assert.equal(result.members.length, 2);
      for (const id of ["one", "two"]) { await f.finish(id); await client.request("collect", { workUnitId: id }); }
    } else {
      assert.equal(result.members[0].result.members[0].reason, "required-worker-tool-unavailable");
      assert.equal(f.server.requests.filter(({ method }) => method === "turn/start").length, 0);
    }
    assert.ok(f.server.requests.filter(({ method }) => method === "mcpServerStatus/list").every(({ params }) => params.threadId.startsWith("thread-")));
  }
});
