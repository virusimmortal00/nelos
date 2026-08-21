import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  PinnedCodexTaskPreparationClientV1,
  prepareProductionTaskV1,
  readProductionTaskReceiptV1,
} from "../src/production-task-preparation.mjs";

const fakeCommand = resolve("test/support/fake-production-task-app-server.mjs");
const errorCode = (code) => (error) => error?.code === code;

async function fixture(t, { mode = "normal" } = {}) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nelos-production-task-")));
  t.after(() => rm(base, { force: true, recursive: true }));
  const root = join(base, "packet");
  const cwd = join(base, "workspace");
  const codexHome = join(base, "codex-home");
  await mkdir(root, { mode: 0o700 });
  await mkdir(cwd, { mode: 0o700 });
  await mkdir(codexHome, { mode: 0o700 });
  const statePath = join(base, "app-server-state.json");
  await writeFile(statePath, `${JSON.stringify({
    expectedCwd: cwd,
    initialize: {
      codexHome,
      platformFamily: "unix",
      platformOs: "macos",
      userAgent: "Codex Desktop/0.148.0-alpha.15",
    },
    methods: [],
    mode,
    startCalls: 0,
    threads: {},
  })}\n`, { mode: 0o600 });
  const clientFactory = () => new PinnedCodexTaskPreparationClientV1({
    command: fakeCommand,
    expectedCommand: fakeCommand,
    environment: { ...process.env, CODEX_HOME: codexHome, NELOS_FAKE_PRODUCTION_TASK_STATE: statePath },
    requestTimeoutMs: 2_000,
    spawnProcess: (_command, args, options) => spawn(process.execPath, [fakeCommand, ...args], options),
  });
  const rootInfo = await lstat(root);
  const dependencies = { clientFactory, expectedUid: rootInfo.uid, expectedGid: rootInfo.gid };
  const input = { root, cwd, title: "production-desktop-scenario", authorizeCreate: true };
  return { base, clientFactory, codexHome, dependencies, input, root, statePath };
}

async function state(path) { return JSON.parse(await readFile(path, "utf8")); }

test("one-shot preparation creates, titles, reads back, and content-addresses one empty persistent task", async (t) => {
  const value = await fixture(t);
  assert.equal(value.clientFactory().expectedCodexHome, value.codexHome);
  await assert.rejects(
    prepareProductionTaskV1({ ...value.input, authorizeCreate: false }, value.dependencies),
    errorCode("TASK_CREATION_AUTHORIZATION_REQUIRED"),
  );
  const result = await prepareProductionTaskV1(value.input, value.dependencies);
  assert.equal(result.adopted, false);
  assert.equal(result.title, value.input.title);
  assert.match(result.taskId, /^01a01fff-/u);
  assert.match(result.receiptDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(result.receiptPath, join(value.root, `production-task-${result.receiptDigest.slice(7)}.json`));
  assert.equal((await lstat(result.receiptPath)).mode & 0o777, 0o400);
  const receipt = await readProductionTaskReceiptV1({
    path: result.receiptPath,
    digest: result.receiptDigest,
    root: { path: value.root, uid: value.dependencies.expectedUid, gid: value.dependencies.expectedGid },
    expectedCommand: fakeCommand,
  });
  assert.equal(receipt.initialTurnStarted, false);
  assert.doesNotMatch(JSON.stringify(receipt), /email|account|codexHome/iu);
  const observed = await state(value.statePath);
  assert.equal(observed.startCalls, 1);
  assert.equal(observed.threads[result.taskId].name, value.input.title);
  assert.deepEqual(observed.threads[result.taskId].turns, []);
  assert.equal(observed.methods.includes("turn/start"), false);
  assert.deepEqual(observed.methods.filter((method) => method === "thread/start"), ["thread/start"]);

  const adopted = await prepareProductionTaskV1({ ...value.input, authorizeCreate: false }, value.dependencies);
  assert.equal(adopted.adopted, true);
  assert.equal(adopted.receiptDigest, result.receiptDigest);
  assert.equal((await state(value.statePath)).startCalls, 1);
});

test("a crash after sealing the returned identity adopts that task without a second thread/start", async (t) => {
  const value = await fixture(t);
  await assert.rejects(
    prepareProductionTaskV1(value.input, {
      ...value.dependencies,
      afterCreatedMarker: () => { throw new Error("synthetic controller crash"); },
    }),
    /synthetic controller crash/u,
  );
  assert.equal((await state(value.statePath)).startCalls, 1);
  const adopted = await prepareProductionTaskV1({ ...value.input, authorizeCreate: false }, value.dependencies);
  assert.equal(adopted.adopted, true);
  assert.equal((await state(value.statePath)).startCalls, 1);
});

test("adoption fails closed when the exact task title changes", async (t) => {
  const value = await fixture(t);
  const prepared = await prepareProductionTaskV1(value.input, value.dependencies);
  const changed = await state(value.statePath);
  changed.threads[prepared.taskId].name = "externally-changed-title";
  await writeFile(value.statePath, `${JSON.stringify(changed)}\n`);
  await assert.rejects(
    prepareProductionTaskV1({ ...value.input, authorizeCreate: false }, value.dependencies),
    errorCode("TASK_TITLE_CHANGED"),
  );
  assert.equal((await state(value.statePath)).startCalls, 1);
});

test("altered receipt bytes or mode cannot be adopted", async (t) => {
  const value = await fixture(t);
  const prepared = await prepareProductionTaskV1(value.input, value.dependencies);
  await chmod(prepared.receiptPath, 0o600);
  await writeFile(prepared.receiptPath, "{}\n");
  await assert.rejects(
    prepareProductionTaskV1({ ...value.input, authorizeCreate: false }, value.dependencies),
    errorCode("UNTRUSTED_TASK_RECEIPT"),
  );
  assert.equal((await state(value.statePath)).startCalls, 1);
});

test("an ambiguous thread/start stops permanently instead of creating another task", async (t) => {
  const value = await fixture(t, { mode: "ambiguous-start" });
  await assert.rejects(
    prepareProductionTaskV1(value.input, value.dependencies),
    errorCode("TASK_CREATION_AMBIGUOUS"),
  );
  assert.equal((await state(value.statePath)).startCalls, 1);
  await assert.rejects(
    prepareProductionTaskV1(value.input, value.dependencies),
    errorCode("TASK_CREATION_AMBIGUOUS"),
  );
  assert.equal((await state(value.statePath)).startCalls, 1);
});

test("changed title or cwd cannot reuse a sealed one-shot creation intent", async (t) => {
  const value = await fixture(t);
  await assert.rejects(
    prepareProductionTaskV1(value.input, {
      ...value.dependencies,
      afterCreatedMarker: () => { throw new Error("synthetic controller crash"); },
    }),
  );
  await assert.rejects(
    prepareProductionTaskV1({ ...value.input, title: "different-title" }, value.dependencies),
    errorCode("TASK_INTENT_MISMATCH"),
  );
  const otherCwd = join(value.base, "other-workspace");
  await mkdir(otherCwd, { mode: 0o700 });
  await assert.rejects(
    prepareProductionTaskV1({ ...value.input, cwd: otherCwd }, value.dependencies),
    errorCode("TASK_INTENT_MISMATCH"),
  );
  assert.equal((await state(value.statePath)).startCalls, 1);
});
