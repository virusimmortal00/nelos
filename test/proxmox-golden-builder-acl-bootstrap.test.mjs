import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  cleanupScopedAclBootstrapV1,
  executeScopedAclBootstrapV1,
  reconcileScopedAclBootstrapV1,
  validateScopedAclBootstrapPlanV1,
} from "../validation/proxmox-desktop/v1/golden-builder-acl-bootstrap.mjs";
import { canonicalJsonV1, sha256V1 } from "../validation/proxmox-desktop/v1/build-golden-image.mjs";
import { createScopedAclBootstrapPlanV2 } from "../validation/proxmox-desktop/v1/prepare-golden-builder.mjs";

const NOW = Date.parse("2026-08-20T16:00:00.000Z");
const BUILD_SECRET = "build-token-secret-value-0123456789";
const ATTEST_SECRET = "attestor-token-secret-value-9876543210";

function reservation() {
  return {
    schemaVersion: 2,
    reservationId: "golden-acl-test",
    providerId: "proxmox-lab",
    apiUrl: "https://192.168.1.110:8006/api2/json",
    tlsCaDigest: "sha256:04eccf7506f3f0de1fe2949aea667ce8fdc48f0ce33fcf758b05d1596739964d",
    node: "prox2",
    storage: "local-lvm",
    networkAclPath: "/sdn/zones/nelosbld/nelosbld",
    sourceCommit: "a".repeat(40),
    buildNonce: "c".repeat(32),
    buildTokenId: "nelosgoldbuild@pve!build-cccccccccccc",
    attestorTokenId: "nelosgoldattest@pve!attest-cccccccccccc",
    expiresAt: new Date(NOW + 3_600_000).toISOString(),
    cleanupExpiresAt: new Date(NOW + 7_200_000).toISOString(),
    maxBuildMs: 300_000,
    sourceArtifact: {
      name: "ubuntu-24.04-server-cloudimg-amd64.img",
      digest: "sha256:0533b0655c32e68b31d792ecd6ccfca95abdbc536c4446874fe0513bd4140ffe",
      signatureScheme: "openpgp-detached-sha256sums",
      signatureFingerprint: "843938DF228D22F7B3742BC0D94AA3F0EFE21092",
    },
    volumeAttestor: {
      helperDigest: `sha256:${"1".repeat(64)}`,
      hostKeyFingerprint: `SHA256:${"A".repeat(43)}`,
      identityFingerprint: `SHA256:${"B".repeat(43)}`,
      sshHost: "192.168.1.110",
      sshPort: 22,
      sshUser: "nelosmeasure",
    },
    sourceTemplate: {
      vmId: 9024,
      name: "nelos-ubuntu-24-04-source",
      configDigest: `sha256:${"2".repeat(64)}`,
      volumeMeasurementDigest: `sha256:${"3".repeat(64)}`,
    },
    outputTemplate: { vmId: 9027, name: "nelos-desktop-ubuntu-24-04-v1", macAddress: "02:4E:45:4C:90:27" },
  };
}

async function privateRoot(t) {
  const path = await realpath(await mkdtemp(join(tmpdir(), "nelos-golden-acl-")));
  await chmod(path, 0o700);
  t.after(() => rm(path, { recursive: true, force: true }));
  return path;
}

function successRunner(calls, { zone = "nelosbld", aclPath = "/sdn/zones/nelosbld/nelosbld", secondResponse = null } = {}) {
  return async ({ argv, sensitive }) => {
    calls.push({ argv: [...argv], sensitive: sensitive === true });
    if (argv[0] === "/usr/bin/pvesh" && argv[2] === "/cluster/sdn/vnets") {
      return Buffer.from(JSON.stringify([{ vnet: "nelosbld", zone, pending: 0 }]));
    }
    if (argv[0] === "/usr/bin/pvesh" && argv[2] === "/access/acl") {
      return Buffer.from(JSON.stringify([{ path: aclPath, roleid: "existing" }]));
    }
    if (argv.slice(0, 5).join(" ") === "/usr/sbin/pveum user token add nelosgoldbuild@pve") {
      return Buffer.from(JSON.stringify({ "full-tokenid": "nelosgoldbuild@pve!build-cccccccccccc", info: { privsep: 1 }, value: BUILD_SECRET }));
    }
    if (argv.slice(0, 5).join(" ") === "/usr/sbin/pveum user token add nelosgoldattest@pve") {
      return secondResponse ?? Buffer.from(JSON.stringify({ "full-tokenid": "nelosgoldattest@pve!attest-cccccccccccc", info: { expire: 0, privsep: 1 }, value: ATTEST_SECRET }));
    }
    return Buffer.alloc(0);
  };
}

function cleanupHarness(plan) {
  const users = new Set(plan.tokenRequests.map(({ user }) => user));
  const tokens = new Set(plan.tokenRequests.map(({ tokenId }) => tokenId));
  const roles = new Set(plan.setupCommands.filter((argv) => argv.slice(0, 3).join(" ") === "/usr/sbin/pveum role add").map((argv) => argv[3]));
  const grants = new Map(plan.setupCommands.filter((argv) => argv.slice(0, 3).join(" ") === "/usr/sbin/pveum acl modify").map((argv) => {
    const grant = { path: argv[3], role: argv[argv.indexOf("--roles") + 1], user: argv[argv.indexOf("--users") + 1] };
    return [canonicalJsonV1(grant), grant];
  }));
  const observation = () => {
    const content = {
      complete: true,
      grants: [...grants.values()].sort((left, right) => canonicalJsonV1(left).localeCompare(canonicalJsonV1(right))),
      roles: [...roles].sort(),
      tokens: [...tokens].sort(),
      users: [...users].sort(),
      inventoryDigest: sha256V1({ grants: [...grants.keys()].sort(), roles: [...roles].sort(), tokens: [...tokens].sort(), users: [...users].sort() }),
    };
    return { ...content, observationDigest: sha256V1(content) };
  };
  const runCommand = async ({ argv }) => {
    if (argv.slice(0, 4).join(" ") === "/usr/sbin/pveum user token remove") tokens.delete(`${argv[4]}!${argv[5]}`);
    else if (argv.slice(0, 3).join(" ") === "/usr/sbin/pveum acl delete") {
      grants.delete(canonicalJsonV1({ path: argv[3], role: argv[argv.indexOf("--roles") + 1], user: argv[argv.indexOf("--users") + 1] }));
    } else if (argv.slice(0, 3).join(" ") === "/usr/sbin/pveum user delete") users.delete(argv[3]);
    else if (argv.slice(0, 3).join(" ") === "/usr/sbin/pveum role delete") roles.delete(argv[3]);
    else assert.fail(`unexpected cleanup command: ${argv.join(" ")}`);
    return Buffer.alloc(0);
  };
  return { observation, runCommand, state: { grants, roles, tokens, users } };
}

async function stageTokenFiles(root) {
  await Promise.all([
    writeFile(join(root, "build-token"), `${BUILD_SECRET}\n`, { mode: 0o400 }),
    writeFile(join(root, "attestor-token"), `${ATTEST_SECRET}\n`, { mode: 0o400 }),
  ]);
  await Promise.all([chmod(join(root, "build-token"), 0o400), chmod(join(root, "attestor-token"), 0o400)]);
}

test("ACL plan contains no secret-producing command and binds the observed VNet ACL identity", () => {
  const value = reservation();
  const plan = createScopedAclBootstrapPlanV2(value, { now: NOW });
  assert.equal(validateScopedAclBootstrapPlanV1(plan, value, { now: NOW }), plan);
  assert.deepEqual(plan.network, { vnet: "nelosbld", zone: "nelosbld", aclPath: "/sdn/zones/nelosbld/nelosbld" });
  assert.equal(plan.tokenRequests.length, 2);
  assert.ok(plan.setupCommands.every((command) => !command.includes("token")));
  assert.doesNotMatch(canonicalJsonV1(plan), new RegExp(`${BUILD_SECRET}|${ATTEST_SECRET}`, "u"));
  assert.throws(() => validateScopedAclBootstrapPlanV1({ ...plan, unexpected: true }, value, { now: NOW }), { code: "INVALID_CONTRACT" });
});

test("executor captures two one-shot values into distinct 0400 files and returns metadata only", async (t) => {
  const value = reservation(); const plan = createScopedAclBootstrapPlanV2(value, { now: NOW }); const root = await privateRoot(t); const calls = [];
  const receiptPath = join(root, "acl-receipt.json");
  const receipt = await executeScopedAclBootstrapV1({ reservation: value, plan, tokenRoot: root, receiptPath, authorizePlan: plan.planDigest }, {
    runCommand: successRunner(calls), clock: { now: () => NOW }, expectedUid: process.getuid(),
  });
  assert.equal(await readFile(join(root, "build-token"), "utf8"), `${BUILD_SECRET}\n`);
  assert.equal(await readFile(join(root, "attestor-token"), "utf8"), `${ATTEST_SECRET}\n`);
  assert.equal((await lstat(join(root, "build-token"))).mode & 0o777, 0o400);
  assert.equal((await lstat(join(root, "attestor-token"))).mode & 0o777, 0o400);
  assert.equal((await lstat(receiptPath)).mode & 0o777, 0o400);
  const publicEvidence = `${canonicalJsonV1(receipt)}\n${await readFile(receiptPath, "utf8")}\n${canonicalJsonV1(calls.map(({ argv, sensitive }) => ({ argv, sensitive })))}`;
  assert.doesNotMatch(publicEvidence, new RegExp(`${BUILD_SECRET}|${ATTEST_SECRET}`, "u"));
  assert.deepEqual(receipt.tokenFiles.map(({ kind, mode }) => ({ kind, mode })), [{ kind: "build", mode: "0400" }, { kind: "attestor", mode: "0400" }]);
  assert.equal(calls.filter(({ sensitive }) => sensitive).length, 2);
  assert.equal((await readdir(root)).some((name) => name.endsWith(".intent.json")), false);
});

test("wrong VNet zone or ACL path fails before any identity mutation", async (t) => {
  const value = reservation(); const plan = createScopedAclBootstrapPlanV2(value, { now: NOW }); const root = await privateRoot(t);
  for (const variant of [{ zone: "wrong" }, { aclPath: "/sdn/zones/nelos/vnets/nelosbld" }]) {
    const calls = [];
    await assert.rejects(() => executeScopedAclBootstrapV1({ reservation: value, plan, tokenRoot: root, receiptPath: join(root, `receipt-${calls.length}.json`), authorizePlan: plan.planDigest }, {
      runCommand: successRunner(calls, variant), clock: { now: () => NOW }, expectedUid: process.getuid(),
    }), { code: "VNET_IDENTITY_MISMATCH" });
    assert.equal(calls.some(({ argv }) => argv[0] === "/usr/sbin/pveum"), false);
  }
});

test("malformed second token is scrubbed, rolled back, and absent from errors, receipts, and journals", async (t) => {
  const value = reservation(); const plan = createScopedAclBootstrapPlanV2(value, { now: NOW }); const root = await privateRoot(t); const calls = [];
  const hostile = Buffer.from(JSON.stringify({ "full-tokenid": "wrong@pve!token", info: { privsep: 1 }, value: ATTEST_SECRET }));
  let caught;
  try {
    await executeScopedAclBootstrapV1({ reservation: value, plan, tokenRoot: root, receiptPath: join(root, "receipt.json"), authorizePlan: plan.planDigest }, {
      runCommand: successRunner(calls, { secondResponse: hostile }), clock: { now: () => NOW }, expectedUid: process.getuid(),
    });
  } catch (error) { caught = error; }
  assert.equal(caught?.code, "ACL_BOOTSTRAP_ROLLED_BACK");
  assert.doesNotMatch(JSON.stringify({ code: caught?.code, message: caught?.message, details: caught?.details }), new RegExp(`${BUILD_SECRET}|${ATTEST_SECRET}`, "u"));
  const files = await readdir(root);
  assert.deepEqual(files, []);
  assert.equal(calls.some(({ argv }) => argv.slice(0, 4).join(" ") === "/usr/sbin/pveum user token remove"), true);
});

test("unproven rollback leaves a plan-bound intent for explicit reconciliation", async (t) => {
  const value = reservation(); const plan = createScopedAclBootstrapPlanV2(value, { now: NOW }); const root = await privateRoot(t); let mutationSeen = false;
  const failing = async ({ argv }) => {
    if (argv[0] === "/usr/bin/pvesh" && argv[2] === "/cluster/sdn/vnets") return Buffer.from(JSON.stringify([{ vnet: "nelosbld", zone: "nelosbld", pending: 0 }]));
    if (argv[0] === "/usr/bin/pvesh") return Buffer.from(JSON.stringify([{ path: "/sdn/zones/nelosbld/nelosbld" }]));
    mutationSeen = true; throw Object.assign(new Error(`${BUILD_SECRET}: provider failure`), { code: "COMMAND_FAILED" });
  };
  await assert.rejects(() => executeScopedAclBootstrapV1({ reservation: value, plan, tokenRoot: root, receiptPath: join(root, "receipt.json"), authorizePlan: plan.planDigest }, {
    runCommand: failing, clock: { now: () => NOW }, expectedUid: process.getuid(),
  }), { code: "ACL_RECONCILIATION_REQUIRED" });
  assert.equal(mutationSeen, true);
  assert.equal((await readdir(root)).filter((name) => name.endsWith(".intent.json")).length, 1);
  const result = await reconcileScopedAclBootstrapV1({ reservation: value, plan, tokenRoot: root, authorizePlan: plan.planDigest }, {
    runCommand: async () => Buffer.alloc(0), clock: { now: () => NOW }, expectedUid: process.getuid(),
  });
  assert.equal(result.state, "rolled-back");
  assert.deepEqual(await readdir(root), []);
});

test("successful ACL cleanup removes provider identities and both local secrets with metadata-only evidence", async (t) => {
  const value = reservation(); const plan = createScopedAclBootstrapPlanV2(value, { now: NOW }); const root = await privateRoot(t);
  await stageTokenFiles(root);
  const harness = cleanupHarness(plan); const receiptPath = join(root, "cleanup-receipt.json");
  const receipt = await cleanupScopedAclBootstrapV1({ reservation: value, plan, tokenRoot: root, receiptPath, authorizePlan: plan.planDigest }, {
    runCommand: harness.runCommand, observeAccess: async () => harness.observation(), clock: { now: () => NOW }, expectedUid: process.getuid(),
  });
  assert.equal(receipt.kind, "nelos-golden-builder-acl-cleanup-receipt");
  assert.equal(receipt.actionCount, plan.rollbackCommands.length + plan.tokenRequests.length);
  assert.deepEqual([...harness.state.users, ...harness.state.tokens, ...harness.state.roles, ...harness.state.grants.keys()], []);
  assert.equal(await lstat(join(root, "build-token")).then(() => true, () => false), false);
  assert.equal(await lstat(join(root, "attestor-token")).then(() => true, () => false), false);
  assert.equal((await lstat(receiptPath)).mode & 0o777, 0o400);
  const publicEvidence = `${canonicalJsonV1(receipt)}\n${await readFile(receiptPath, "utf8")}`;
  assert.doesNotMatch(publicEvidence, new RegExp(`${BUILD_SECRET}|${ATTEST_SECRET}`, "u"));
  assert.equal((await readdir(root)).some((name) => name.includes(".acl-cleanup-") && name.endsWith(".intent.json")), false);
  assert.deepEqual(await cleanupScopedAclBootstrapV1({ reservation: value, plan, tokenRoot: root, receiptPath, authorizePlan: plan.planDigest }, {
    runCommand: harness.runCommand, observeAccess: async () => harness.observation(), clock: { now: () => NOW }, expectedUid: process.getuid(),
  }), receipt);
});

test("ACL cleanup resumes idempotently after every pre-effect, post-effect, and receipt checkpoint crash", async (t) => {
  const value = reservation(); const plan = createScopedAclBootstrapPlanV2(value, { now: NOW });
  const actionCount = plan.rollbackCommands.length + plan.tokenRequests.length;
  const crashPoints = [
    ...Array.from({ length: actionCount }, (_, index) => ({ phase: "action-authorized", index })),
    ...Array.from({ length: actionCount }, (_, index) => ({ phase: "effect-returned", index })),
    { phase: "receipt-committed", index: actionCount },
  ];
  for (const [caseIndex, crashPoint] of crashPoints.entries()) {
    const root = await privateRoot(t); await stageTokenFiles(root); const harness = cleanupHarness(plan); const receiptPath = join(root, `cleanup-${caseIndex}.json`);
    let injected = false;
    await assert.rejects(cleanupScopedAclBootstrapV1({ reservation: value, plan, tokenRoot: root, receiptPath, authorizePlan: plan.planDigest }, {
      runCommand: harness.runCommand,
      observeAccess: async () => harness.observation(),
      checkpoint: async ({ phase, index }) => {
        if (!injected && phase === crashPoint.phase && index === crashPoint.index) { injected = true; throw Object.assign(new Error("simulated process loss"), { code: "SIMULATED_CRASH" }); }
      },
      clock: { now: () => NOW }, expectedUid: process.getuid(),
    }), { code: "SIMULATED_CRASH" }, `${crashPoint.phase}:${crashPoint.index}`);
    assert.equal(injected, true);
    const receipt = await cleanupScopedAclBootstrapV1({ reservation: value, plan, tokenRoot: root, receiptPath, authorizePlan: plan.planDigest }, {
      runCommand: harness.runCommand, observeAccess: async () => harness.observation(), clock: { now: () => NOW }, expectedUid: process.getuid(),
    });
    assert.equal(receipt.actionCount, actionCount);
    assert.deepEqual([...harness.state.users, ...harness.state.tokens, ...harness.state.roles, ...harness.state.grants.keys()], []);
    assert.equal((await readdir(root)).some((name) => name.endsWith(".intent.json")), false);
  }
});

test("ACL cleanup remains authorized after active build expiry but fails at cleanup expiry", async (t) => {
  const value = reservation(); const plan = createScopedAclBootstrapPlanV2(value, { now: NOW }); const root = await privateRoot(t);
  await stageTokenFiles(root); const harness = cleanupHarness(plan); const afterBuild = Date.parse(value.expiresAt) + 1;
  await cleanupScopedAclBootstrapV1({ reservation: value, plan, tokenRoot: root, receiptPath: join(root, "cleanup.json"), authorizePlan: plan.planDigest }, {
    runCommand: harness.runCommand, observeAccess: async () => harness.observation(), clock: { now: () => afterBuild }, expectedUid: process.getuid(),
  });
  await assert.rejects(cleanupScopedAclBootstrapV1({ reservation: value, plan, tokenRoot: root, receiptPath: join(root, "expired.json"), authorizePlan: plan.planDigest }, {
    runCommand: harness.runCommand, observeAccess: async () => harness.observation(), clock: { now: () => Date.parse(value.cleanupExpiresAt) }, expectedUid: process.getuid(),
  }), { code: "EXPIRED_RESERVATION" });
});

test("ACL plan and receipt schemas close every nested record", async () => {
  const [planSchema, receiptSchema, cleanupReceiptSchema] = await Promise.all([
    readFile(resolve("validation/proxmox-desktop/v1/golden-builder-acl-bootstrap-plan.schema.json"), "utf8").then(JSON.parse),
    readFile(resolve("validation/proxmox-desktop/v1/golden-builder-acl-bootstrap-receipt.schema.json"), "utf8").then(JSON.parse),
    readFile(resolve("validation/proxmox-desktop/v1/golden-builder-acl-cleanup-receipt.schema.json"), "utf8").then(JSON.parse),
  ]);
  for (const schema of [planSchema, receiptSchema, cleanupReceiptSchema]) {
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort());
  }
  assert.equal(planSchema.properties.network.additionalProperties, false);
  assert.equal(planSchema.$defs.buildToken.additionalProperties, false);
  assert.equal(planSchema.$defs.attestorToken.additionalProperties, false);
  assert.equal(receiptSchema.$defs.file.additionalProperties, false);
  assert.equal(cleanupReceiptSchema.$defs.file.additionalProperties, false);
});
