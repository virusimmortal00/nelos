import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { ExecutorAppServerSessionV1 } from "../src/executor-app-server-session.mjs";
import { ExecutorServiceSupervisorV1 } from "../src/executor-service-supervisor.mjs";
import { mockStdioAppServer } from "./support/mock-stdio-app-server.mjs";

const scope = { hostId: "host", codexHomeId: "a".repeat(64), authDomainId: "b".repeat(64) };
async function fixture(t, directory = null) {
  if (!directory) {
    directory = await mkdtemp(join(tmpdir(), "nelos-supervisor-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
  }
  const server = mockStdioAppServer(() => ({ userAgent: "codex-cli/0.152.0", codexHome: "/codex",
    platformFamily: "unix", platformOs: "linux" }));
  const session = new ExecutorAppServerSessionV1({ command: "/bin/codex", cwd: "/workspace", codexHome: "/codex",
    spawnProcess: server.spawnProcess, stopGraceMs: 10 });
  const supervisor = new ExecutorServiceSupervisorV1({ session, directory, scope, runtimeGeneration: "c".repeat(64) });
  t.after(async () => { session.close(); await session.stopped; });
  return { session, supervisor, server, directory };
}

test("frontend detach preserves active work; draining rejects new work but serves existing approvals", async (t) => {
  const f = await fixture(t);
  await f.supervisor.start();
  const first = f.supervisor.attach(); const second = f.supervisor.attach();
  const work = f.supervisor.hold({ kind: "work", operationId: "launch:1" });
  assert.equal(f.supervisor.isAttached({}), false);
  f.supervisor.detach(first); f.supervisor.detach(second);
  assert.equal(f.session.status().state, "ready");
  assert.equal(f.supervisor.drain().state, "draining");
  assert.throws(() => f.supervisor.hold({ kind: "work", operationId: "launch:2" }));
  const returning = f.supervisor.attach();
  assert.equal(f.supervisor.isAttached(returning), true);
  const approval = f.supervisor.hold({ kind: "approval", operationId: "launch:1" });
  assert.throws(() => f.supervisor.hold({ kind: "approval", operationId: "launch:foreign" }));
  f.supervisor.release(work);
  assert.equal(f.session.status().state, "ready");
  f.supervisor.release(approval);
  assert.equal((await f.supervisor.stopped).state, "stopped");
  assert.equal(f.supervisor.isAttached(returning), false);
  assert.throws(() => f.supervisor.release(approval));
});

test("one process-start-aware owner lock excludes another session until the child exits", async (t) => {
  const first = await fixture(t);
  const second = await fixture(t, first.directory);
  await first.supervisor.start();
  const starting = second.supervisor.start();
  await delay(50);
  assert.equal(second.server.children.length, 0);
  const signals = [];
  first.server.children[0].kill = (signal) => { signals.push(signal); return true; };
  first.supervisor.drain();
  await delay(50);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  assert.equal(second.server.children.length, 0);
  first.server.children[0].emit("exit", 0);
  await first.supervisor.stopped;
  await starting;
  assert.equal(second.server.children.length, 1);
  assert.notEqual(first.supervisor.status().ownerEpoch, second.supervisor.status().ownerEpoch);
  second.supervisor.drain(); await second.supervisor.stopped;
});

test("connection failure invalidates clients and preserves activity counts for reconciliation", async (t) => {
  const f = await fixture(t);
  await f.supervisor.start();
  const client = f.supervisor.attach();
  f.supervisor.hold({ kind: "work", operationId: "uncertain-launch" });
  f.server.children[0].emit("exit", 1);
  assert.equal(f.supervisor.isAttached(client), false);
  assert.equal(f.supervisor.status().state, "failed");
  assert.equal((await f.supervisor.stopped).state, "failed");
  assert.equal(f.supervisor.status().activities, 1);
  assert.throws(() => f.supervisor.attach());
  await assert.rejects(f.supervisor.start());
});

test("an insecure service directory is rejected before spawning", async (t) => {
  const f = await fixture(t);
  await chmod(f.directory, 0o755);
  await assert.rejects(f.supervisor.start(), { code: "insecure-service-directory" });
  assert.equal(f.server.children.length, 0);
  assert.equal((await f.supervisor.stopped).state, "failed");
});
