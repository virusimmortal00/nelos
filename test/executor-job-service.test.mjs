import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, realpath, rm, readFile, chmod, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { ExecutorJobServiceV1, executorRepositoryIdentityV1 } from "../src/executor-job-service.mjs";
import { serveExecutorJobV1, ExecutorServiceClientV1 } from "../src/executor-service-channel.mjs";
import { executorDigest } from "../src/executor-contract.mjs";
import { mockStdioAppServer } from "./support/mock-stdio-app-server.mjs";
import { formatResultEnvelope } from "../src/work-result.mjs";

async function fixture(t, { missingModel = false, expired = false, reorderConfig = false } = {}) {
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
  let title = null, turns = [], configReads = 0;
  const server = mockStdioAppServer(({ method, params }) => {
    if (method === "initialize") return { userAgent: "future-client/dev", codexHome, platformFamily: "unix", platformOs: "macos" };
    if (method === "account/read") return { requiresOpenaiAuth: true, account: { type: "chatgpt", email: "secret@example.invalid" } };
    if (method === "model/list") return { data: missingModel ? [] : [{ model: "gpt-6-astra", supportedReasoningEfforts: [{ reasoningEffort: "medium" }] }] };
    if (method === "permissionProfile/list") return { data: [{ id: ":read-only", allowed: true }] };
    if (method === "configRequirements/read") return { requirements: null };
    if (method === "config/read") return { config: reorderConfig && ++configReads % 2 ? { one: 1, nested: { b: 2, a: 1 } } : reorderConfig ? { nested: { a: 1, b: 2 }, one: 1 } : { fixture: true } };
    if (method === "thread/start") return { thread: { id: "child", cwd }, cwd, model: params.model,
      activePermissionProfile: { id: params.permissions }, approvalPolicy: params.approvalPolicy };
    if (method === "thread/name/set") { title = params.name; return {}; }
    if (method === "thread/read") return { thread: { id: "child", name: title, turns } };
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
    finish() { turns = [{ id: "turn", status: "completed", items: [{ type: "agentMessage", phase: "final_answer",
      text: formatResultEnvelope({ schemaVersion: 1, workUnitId: "job-1", specRevision: 1, attempt: 1,
        outcome: "succeeded", summary: "Expected summary", artifacts: [], verification: ["Fixture verified"], blockers: [], recoveryHint: null }) }] }]; },
    async restart({ staleDescriptor = null } = {}) {
      for (const client of clients) client.close();
      service.drain(); await service.stopped; await endpoint.close();
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
