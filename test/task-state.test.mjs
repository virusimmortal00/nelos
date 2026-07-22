import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { readProcessIdentity } from "../src/process-liveness.mjs";
import {
  readTaskRegistryRecord,
  readWebRecord,
  taskStateDirectory,
  withQueenSpinoffLock,
  withRepositoryProvisioningLock,
  writeTaskRegistryRecord,
  writeWebRecord,
} from "../src/task-state.mjs";

const PRE_QUEEN_THREAD_ID_FIELD = "coordinatorThreadId";

test("pre-queen records retain lineage and rewrite to the current schema", async () => {
  const root = await mkdtemp(join(tmpdir(), "fraktik-state-migration-"));
  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  const taskDirectory = join(root, "fraktik", "tasks");
  const webDirectory = join(root, "fraktik", "webs");
  const relationship = { [PRE_QUEEN_THREAD_ID_FIELD]: "queen-thread" };

  try {
    await mkdir(taskDirectory, { recursive: true });
    await mkdir(webDirectory, { recursive: true });
    await writeFile(
      join(taskDirectory, "spinoff-thread.json"),
      `${JSON.stringify({
        threadId: "spinoff-thread",
        web: {
          ...relationship,
          inboundWebId: "A1",
          outboundWebId: "A1.1",
        },
      })}\n`,
    );
    await writeFile(
      join(webDirectory, "spinoff-thread.json"),
      `${JSON.stringify({
        threadId: "spinoff-thread",
        ...relationship,
        inboundWebId: "A1",
        outboundWebId: "A1.1",
      })}\n`,
    );

    const taskRecord = await readTaskRegistryRecord("spinoff-thread");
    const webRecord = await readWebRecord("spinoff-thread");
    assert.equal(taskRecord.web.queenThreadId, "queen-thread");
    assert.equal(webRecord.queenThreadId, "queen-thread");

    await writeTaskRegistryRecord(taskRecord);
    await writeWebRecord(webRecord);
    const persistedTask = JSON.parse(
      await readFile(join(taskDirectory, "spinoff-thread.json"), "utf8"),
    );
    const persistedWeb = JSON.parse(
      await readFile(join(webDirectory, "spinoff-thread.json"), "utf8"),
    );
    assert.deepEqual(persistedTask.web, {
      queenThreadId: "queen-thread",
      inboundWebId: "A1",
      outboundWebId: "A1.1",
    });
    assert.equal(persistedWeb.queenThreadId, "queen-thread");
    assert.equal(Object.hasOwn(persistedWeb, PRE_QUEEN_THREAD_ID_FIELD), false);
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("repository provisioning locks accept only opaque repository identities", async (t) => {
  const stateHome = await mkdtemp(join(tmpdir(), "fraktik-repository-lock-"));
  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  try {
    assert.throws(
      () => withRepositoryProvisioningLock("not-a-repository-id", async () => {}),
      /requires a SHA-256 repository ID/,
    );
    let entered = false;
    await withRepositoryProvisioningLock("a".repeat(64), async () => {
      entered = true;
    });
    assert.equal(entered, true);
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    await rm(stateHome, { recursive: true, force: true });
  }
});

test("state locks recover when a live PID belongs to a replacement process", async (t) => {
  const activeIdentity = await readProcessIdentity(process.pid);
  const recordedIdentity = Object.fromEntries(
    Object.entries(activeIdentity ?? {})
      .filter(([kind]) => kind !== "pid-only")
      .map(([kind, value]) => [kind, `reused:${value}`]),
  );
  if (Object.keys(recordedIdentity).length === 0) {
    t.skip("this platform exposes no strong process identity");
    return;
  }

  const stateHome = await mkdtemp(join(tmpdir(), "fraktik-state-pid-reuse-"));
  const previousStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateHome;
  const threadId = "pid-reuse-fixture";
  const lockPath = join(
    taskStateDirectory(),
    `spinoff-${encodeURIComponent(threadId)}.lock`,
  );
  try {
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      join(lockPath, "owner.json"),
      `${JSON.stringify({
        pid: process.pid,
        token: "stale-owner",
        processIdentity: recordedIdentity,
      })}\n`,
    );

    let entered = false;
    await withQueenSpinoffLock(
      threadId,
      async () => {
        entered = true;
        const owner = JSON.parse(
          await readFile(join(lockPath, "owner.json"), "utf8"),
        );
        assert.equal(owner.pid, process.pid);
        assert.notEqual(owner.token, "stale-owner");
        assert.ok(Object.keys(owner.processIdentity).length > 0);
      },
      1_000,
    );
    assert.equal(entered, true);
  } finally {
    if (previousStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previousStateHome;
    await rm(stateHome, { recursive: true, force: true });
  }
});
