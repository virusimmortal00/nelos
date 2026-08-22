import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PRODUCTION_GUEST_CODEX_IDENTITY_V1,
  materializeProductionGuestTaskRunV1,
  productionGuestTaskDigestV1,
  readProductionGuestTaskIntentV1,
  validateProductionGuestTaskReceiptV1,
  writeProductionGuestTaskIntentV1,
} from "../src/production-guest-task.mjs";

const RUN_ID = "desktop-run-20260820";
const FENCE = "fence-20260820";
const SCENARIO_ID = "desktop-status-scenario";

async function fixture(t) {
  const base = await realpath(await mkdtemp(join(tmpdir(), "nelos-guest-task-intent-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "packet"); await mkdir(root, { mode: 0o700 });
  const rootInfo = await import("node:fs/promises").then(({ lstat }) => lstat(root));
  const owner = { expectedUid: rootInfo.uid, expectedGid: rootInfo.gid };
  const prepared = await writeProductionGuestTaskIntentV1({ root, runId: RUN_ID, fencingToken: FENCE, scenarioId: SCENARIO_ID, title: SCENARIO_ID }, owner);
  const binding = { automationUser: "nelosauto", fencingToken: FENCE, gatewayId: "9023", hostId: "prox2", imageId: "golden", leaseId: "lease-1", macAddress: "02:4E:45:4C:94:01", networkId: "nelosbld", networkPolicyDigest: `sha256:${"9".repeat(64)}`, providerId: "proxmox-lab", runId: RUN_ID, stateRoot: `/var/lib/nelos-desktop/runs/${RUN_ID}`, vmId: "9401" };
  const receipt = {
    schemaVersion: 1, type: "nelos-production-guest-task-receipt", binding,
    intentDigest: prepared.intentDigest, taskSlotId: prepared.taskSlotId,
    taskId: "01a01fff-0000-7000-8000-000000000001", title: SCENARIO_ID, createdAt: 1786000001,
    codexIdentity: structuredClone(PRODUCTION_GUEST_CODEX_IDENTITY_V1), accountBindingDigest: `sha256:${"a".repeat(64)}`,
    initialTurnStarted: false,
    inventory: { beforeTaskIds: [], afterTaskIds: ["01a01fff-0000-7000-8000-000000000001"], complete: true, maximumTasks: 100 },
  };
  return { base, binding, owner, prepared, receipt, root };
}

test("controller seals only a deterministic guest task intent and creates no local Codex task", async (t) => {
  const value = await fixture(t);
  assert.match(value.prepared.taskSlotId, /^task-slot-[0-9a-f]{64}$/u);
  assert.equal(value.prepared.intentDigest, productionGuestTaskDigestV1(value.prepared.value));
  assert.equal(value.prepared.value.runtime.cwd, "/home/nelosauto/workspace");
  assert.doesNotMatch(JSON.stringify(value.prepared.value), /email|auth\.json|controller.*codex/iu);
  const reread = await readProductionGuestTaskIntentV1({
    path: value.prepared.intentPath, digest: value.prepared.intentDigest,
    root: { path: value.root, uid: value.owner.expectedUid, gid: value.owner.expectedGid },
  });
  assert.deepEqual(reread, value.prepared.value);
});

test("guest receipt binds fresh exact inventory, account, runtime, run, and fence before materialization", async (t) => {
  const value = await fixture(t);
  assert.equal(validateProductionGuestTaskReceiptV1(value.receipt, { intent: value.prepared.value, binding: value.binding }), value.receipt);
  const run = { scenarios: [{ scenarioId: SCENARIO_ID, task: { taskId: value.prepared.taskSlotId, createdForScenario: SCENARIO_ID, fresh: true } }] };
  const materialized = materializeProductionGuestTaskRunV1(run, value.receipt, { intent: value.prepared.value, binding: value.binding });
  assert.equal(materialized.scenarios[0].task.taskId, value.receipt.taskId);
  assert.equal(run.scenarios[0].task.taskId, value.prepared.taskSlotId);
  for (const hostile of [
    { ...value.receipt, accountBindingDigest: "bad" },
    { ...value.receipt, taskId: value.prepared.taskSlotId, inventory: { ...value.receipt.inventory, afterTaskIds: [value.prepared.taskSlotId] } },
    { ...value.receipt, inventory: { ...value.receipt.inventory, beforeTaskIds: ["old-task"] } },
    { ...value.receipt, binding: { ...value.receipt.binding, fencingToken: "other-fence" } },
    { ...value.receipt, codexIdentity: { ...value.receipt.codexIdentity, codexHome: "/root/.codex" } },
  ]) assert.throws(() => validateProductionGuestTaskReceiptV1(hostile, { intent: value.prepared.value, binding: value.binding }));
});

test("altered content-addressed intent mode or bytes fails closed", async (t) => {
  const value = await fixture(t);
  await chmod(value.prepared.intentPath, 0o600);
  await assert.rejects(readProductionGuestTaskIntentV1({ path: value.prepared.intentPath, digest: value.prepared.intentDigest, root: { path: value.root, uid: value.owner.expectedUid, gid: value.owner.expectedGid } }), (error) => error.code === "UNTRUSTED_GUEST_TASK_INTENT");
  await chmod(value.prepared.intentPath, 0o400);
  await chmod(value.prepared.intentPath, 0o600); await writeFile(value.prepared.intentPath, `${JSON.stringify({})}\n`); await chmod(value.prepared.intentPath, 0o400);
  assert.notEqual(await readFile(value.prepared.intentPath, "utf8"), `${JSON.stringify(value.prepared.value)}\n`);
  await assert.rejects(readProductionGuestTaskIntentV1({ path: value.prepared.intentPath, digest: value.prepared.intentDigest, root: { path: value.root, uid: value.owner.expectedUid, gid: value.owner.expectedGid } }));
});
