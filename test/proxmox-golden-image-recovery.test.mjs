import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PackerBoundaryV1,
  canonicalJsonV1,
  classifyPackerProcessObservationV1,
  goldenOwnershipV1,
  sha256V1,
} from "../validation/proxmox-desktop/v1/build-golden-image.mjs";
import {
  openGoldenImageJournalV1,
  reconcileGoldenImageBuildV1,
} from "../validation/proxmox-desktop/v1/golden-image-recovery.mjs";

const NOW = Date.parse("2026-08-20T16:00:00.000Z");
const OPERATION_ID = `sha256:${"9".repeat(64)}`;

function sourceConfig() {
  return { name: "nelos-ubuntu-24-04-source", template: 1, scsi0: "local-lvm:base-9024-disk-0,size=64G", efidisk0: "local-lvm:base-9024-disk-1,efitype=4m,size=4M" };
}

function measurementContent(value, role, config) {
  const vmId = role === "source" ? value.sourceTemplate.vmId : value.outputTemplate.vmId;
  const name = role === "source" ? value.sourceTemplate.name : value.outputTemplate.name;
  const volumes = Object.entries(config).filter(([key]) => /^(?:efidisk|ide|sata|scsi|virtio)[0-9]+$/u.test(key))
    .map(([diskKey, encoded]) => ({ diskKey, volumeId: encoded.split(",", 1)[0] })).filter(({ volumeId }) => !volumeId.endsWith("-cloudinit"))
    .sort((left, right) => left.diskKey.localeCompare(right.diskKey))
    .map((item, index) => ({ ...item, byteLength: index ? 68_719_476_736 : 4_194_304, digest: `sha256:${(role === "source" ? "1" : "2").repeat(64)}` }));
  return {
    schemaVersion: 1, providerId: value.providerId, node: value.node, storage: value.storage, vmId, name, role, status: "stopped",
    configDigest: sha256V1(config), helperDigest: value.volumeAttestor.helperDigest, attestorFingerprint: value.volumeAttestor.identityFingerprint, volumes,
  };
}

function measurement(value, role, config) {
  const content = measurementContent(value, role, config);
  return { ...content, measuredAt: new Date(NOW + 60_000).toISOString(), contentDigest: sha256V1(content) };
}

function reservation(overrides = {}) {
  const source = sourceConfig();
  const value = {
    schemaVersion: 2,
    reservationId: "golden-recovery-9027",
    providerId: "proxmox-lab",
    apiUrl: "https://192.168.1.110:8006/api2/json",
    tlsCaDigest: "sha256:04eccf7506f3f0de1fe2949aea667ce8fdc48f0ce33fcf758b05d1596739964d",
    node: "prox2", storage: "local-lvm", networkAclPath: "/sdn/zones/nelosbld/nelosbld", sourceCommit: "b".repeat(40), buildNonce: "c".repeat(32),
    buildTokenId: "nelosgoldbuild@pve!build-cccccccccccc", attestorTokenId: "nelosgoldattest@pve!attest-cccccccccccc",
    expiresAt: new Date(NOW + 3_600_000).toISOString(), cleanupExpiresAt: new Date(NOW + 7_200_000).toISOString(), maxBuildMs: 1_800_000,
    sourceArtifact: {
      name: "ubuntu-24.04-server-cloudimg-amd64.img", digest: "sha256:0533b0655c32e68b31d792ecd6ccfca95abdbc536c4446874fe0513bd4140ffe",
      signatureScheme: "openpgp-detached-sha256sums", signatureFingerprint: "843938DF228D22F7B3742BC0D94AA3F0EFE21092",
    },
    volumeAttestor: { helperDigest: `sha256:${"e".repeat(64)}`, hostKeyFingerprint: `SHA256:${"A".repeat(43)}`, identityFingerprint: `SHA256:${"B".repeat(43)}`, sshHost: "192.168.1.110", sshPort: 22, sshUser: "nelosmeasure" },
    sourceTemplate: { vmId: 9024, name: source.name, configDigest: sha256V1(source), volumeMeasurementDigest: "pending" },
    outputTemplate: { vmId: 9027, name: "nelos-desktop-ubuntu-24-04-v1", macAddress: "02:4E:45:4C:90:27" },
    ...overrides,
  };
  if (value.sourceTemplate.volumeMeasurementDigest === "pending") value.sourceTemplate.volumeMeasurementDigest = sha256V1(measurementContent(value, "source", source));
  return value;
}

function outputConfig(value) {
  return {
    name: value.outputTemplate.name, template: 1, digest: "d".repeat(40), cores: 4, sockets: 1, memory: 8192, cpu: "x86-64-v2-AES", machine: "q35", bios: "ovmf",
    scsihw: "virtio-scsi-single", vga: "virtio", onboot: 0, protection: 0, agent: "enabled=1,fstrim_cloned_disks=1", ciuser: "ubuntu", ipconfig0: "ip=dhcp",
    description: goldenOwnershipV1(value), tags: `nelos-golden;nelos-build-${value.buildNonce}`, net0: `virtio=${value.outputTemplate.macAddress},bridge=nelosbld,firewall=1`,
    ide2: `${value.storage}:vm-${value.outputTemplate.vmId}-cloudinit,media=cdrom,size=4M`, scsi0: `${value.storage}:vm-${value.outputTemplate.vmId}-disk-0,size=64G`,
    efidisk0: `${value.storage}:vm-${value.outputTemplate.vmId}-disk-1,efitype=4m,size=4M`,
  };
}

function machineOutput(value) {
  const target = "desktop.proxmox-clone.desktop";
  return [
    `1787241600,${target},artifact-count,1`, `1787241601,${target},artifact,0,builder-id,proxmox.clone`,
    `1787241602,${target},artifact,0,id,${value.outputTemplate.vmId}`, `1787241603,${target},artifact,0,files-count,0`,
    `1787241604,${target},artifact,0,string,VM%!(PACKER_COMMA)%20${value.outputTemplate.vmId}`, `1787241605,${target},artifact,0,end`, "",
  ].join("\n");
}

function immutableInputs(value) {
  const digest = `sha256:${"a".repeat(64)}`;
  return { candidateArchiveDigest: digest, candidateDigest: digest, packageLockDigest: digest, packerHclDigest: digest, recipeDigest: digest, sourceCommit: value.sourceCommit, sourceInputsDigest: digest, toolchainLockDigest: digest, wrapperDigest: digest };
}

function taskObservation(value, startedAt, { active = false, empty = false, digestSalt = "" } = {}) {
  const tasks = empty ? [] : [{
    upid: `UPID:prox2:00000001:00000002:00000003:qmclone:${value.outputTemplate.vmId}:${value.buildTokenId}:`, node: value.node, vmId: value.outputTemplate.vmId,
    user: value.buildTokenId, type: "qmclone", status: active ? "running" : "stopped", exitStatus: active ? null : "OK", startedAt, endedAt: active ? null : new Date(Date.parse(startedAt) + 30_000).toISOString(),
  }];
  const content = { complete: true, query: { startedAt, user: value.buildTokenId, vmId: value.outputTemplate.vmId }, tasks };
  return { ...content, digest: digestSalt ? `sha256:${digestSalt.repeat(64).slice(0, 64)}` : sha256V1(content) };
}

function runtime(value, startedAt, { outputPresent = true, activeTask = false, emptyTasks = false, incompletePacker = false, invalidOutput = false, taskMismatch = false, packerStates = null, terminateResult = null } = {}) {
  const state = { outputPresent, destroys: 0, recoverCalls: 0, terminateCalls: 0, providerReads: 0, commits: 0 };
  const config = { ...outputConfig(value), ...(invalidOutput ? { memory: 4096 } : {}) }; const receipts = new Map();
  const makeApi = (kind) => ({
    async inventory() { state.providerReads += 1; return state.outputPresent ? [{ vmid: value.outputTemplate.vmId, name: value.outputTemplate.name, node: value.node, type: "qemu", template: 1 }] : []; },
    async storageContent() { state.providerReads += 1; return state.outputPresent ? [{ vmid: value.outputTemplate.vmId, volid: `${value.storage}:vm-${value.outputTemplate.vmId}-disk-0` }] : []; },
    async config(vmId) { return vmId === value.sourceTemplate.vmId ? sourceConfig() : config; },
    async status() { return { status: "stopped" }; },
    async pending() { return []; },
    async operationTasks() {
      state.providerReads += 1;
      const observation = taskObservation(value, startedAt, { active: activeTask, empty: emptyTasks });
      if (kind === "attestor" && taskMismatch) return { ...observation, tasks: [], digest: sha256V1({ complete: true, query: observation.query, tasks: [] }) };
      return observation;
    },
    async destroyOwned(vmId) {
      assert.equal(vmId, 9027); state.destroys += 1; state.outputPresent = false;
      return { destroyed: true, absent: true, providerOperationId: `UPID:prox2:1:2:3:qmdestroy:${vmId}:nelosgoldbuild@pve:` };
    },
  });
  const text = machineOutput(value);
  let packerIndex = 0;
  return {
    state,
    builderApi: makeApi("builder"), attestorApi: makeApi("attestor"),
    volumeAttestor: { async measure({ role }) { return measurement(value, role, role === "source" ? sourceConfig() : config); } },
    packer: {
      async recover() {
        state.recoverCalls += 1;
        if (packerStates) return structuredClone(packerStates[Math.min(packerIndex++, packerStates.length - 1)]);
        return incompletePacker ? { schemaVersion: 2, state: "abandoned", operationId: OPERATION_ID } : { schemaVersion: 2, state: "completed", operationId: OPERATION_ID, exitCode: 0, machineOutput: text, machineOutputDigest: sha256V1(text) };
      },
      async terminate() { state.terminateCalls += 1; return structuredClone(terminateResult ?? { schemaVersion: 1, state: "terminated", operationId: OPERATION_ID, signal: "SIGTERM" }); },
    },
    receiptStore: {
      async commit(receipt) { state.commits += 1; const existing = receipts.get(receipt.attestationDigest); if (existing) assert.deepEqual(existing, receipt); else receipts.set(receipt.attestationDigest, structuredClone(receipt)); },
      async read(digest) { return structuredClone(receipts.get(digest)); },
    },
  };
}

async function privateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "nelos-golden-recovery-")); await chmod(root, 0o700); t.after(() => rm(root, { recursive: true, force: true })); return root;
}

async function mutationJournal(t, value = reservation()) {
  const root = await privateRoot(t); const clock = { now: () => NOW }; const journal = await openGoldenImageJournalV1(root, value, { clock });
  await journal.record("preflighted", { reservationId: value.reservationId });
  await journal.record("mutation-started", { attempt: 1, operationId: OPERATION_ID, outputVmId: 9027, ownership: goldenOwnershipV1(value), startedAt: new Date(NOW).toISOString() });
  return { clock, journal, root };
}

test("persistent golden journal adopts one exact digest chain and rejects tampering", async (t) => {
  const value = reservation(); const { journal, root, clock } = await mutationJournal(t, value);
  const adopted = await openGoldenImageJournalV1(root, value, { clock });
  assert.equal(adopted.mode, "adopted"); assert.equal(adopted.entries.length, journal.entries.length); assert.equal(adopted.attempt, 1);
  const document = JSON.parse(await readFile(journal.path, "utf8")); document.entries[1].details.reservationId = "forged";
  await writeFile(journal.path, `${canonicalJsonV1(document)}\n`, { mode: 0o600 });
  await assert.rejects(openGoldenImageJournalV1(root, value, { clock }), { code: "INVALID_JOURNAL" });
});

test("fresh-process recovery resumes a completed Packer output without replay and commits attestation", async (t) => {
  const value = reservation(); const { journal, clock } = await mutationJournal(t, value); const boundaries = runtime(value, new Date(NOW).toISOString());
  const result = await reconcileGoldenImageBuildV1({ reservation: value, immutableInputs: immutableInputs(value), ...boundaries, journal, clock });
  assert.equal(result.state, "committed"); assert.equal(boundaries.state.recoverCalls, 1); assert.equal(boundaries.state.destroys, 0); assert.equal(boundaries.state.commits, 1);
  assert.deepEqual(journal.entries.slice(-3).map(({ phase }) => phase), ["packer-exited", "attested", "committed"]);
});

test("active provider task returns pending and never replays Packer or deletes output", async (t) => {
  const value = reservation(); const { journal, clock } = await mutationJournal(t, value); const boundaries = runtime(value, new Date(NOW).toISOString(), { activeTask: true });
  await assert.rejects(reconcileGoldenImageBuildV1({ reservation: value, immutableInputs: immutableInputs(value), ...boundaries, journal, clock }), { code: "RECOVERY_PENDING" });
  assert.equal(boundaries.state.recoverCalls, 1); assert.equal(boundaries.state.destroys, 0); assert.equal(journal.entries.at(-1).phase, "mutation-started");
});

test("durable Packer ownership blocks task-gap retry before either provider is queried", async (t) => {
  const value = reservation({ reservationId: "golden-process-task-gap" }); const { journal, clock } = await mutationJournal(t, value);
  const processRecord = { pid: 4102, processGroupId: 4102, startTimeTicks: "991827", uid: 1000 };
  const boundaries = runtime(value, new Date(NOW).toISOString(), {
    outputPresent: false, emptyTasks: true,
    packerStates: [{ schemaVersion: 2, state: "running", operationId: OPERATION_ID, process: processRecord }],
  });
  await assert.rejects(reconcileGoldenImageBuildV1({ reservation: value, immutableInputs: immutableInputs(value), ...boundaries, journal, clock }), { code: "RECOVERY_PENDING" });
  assert.equal(boundaries.state.providerReads, 0); assert.equal(boundaries.state.destroys, 0); assert.equal(boundaries.state.terminateCalls, 0);
});

test("cleanup-only reconciliation terminates the exact process group before provider cleanup and never admits retry", async (t) => {
  const value = reservation({ reservationId: "golden-process-cleanup" }); const { journal, clock } = await mutationJournal(t, value);
  const processRecord = { pid: 4103, processGroupId: 4103, startTimeTicks: "991828", uid: 1000 };
  const boundaries = runtime(value, new Date(NOW).toISOString(), {
    incompletePacker: true,
    packerStates: [
      { schemaVersion: 2, state: "running", operationId: OPERATION_ID, process: processRecord },
      { schemaVersion: 2, state: "abandoned", operationId: OPERATION_ID },
    ],
  });
  const result = await reconcileGoldenImageBuildV1({ reservation: value, immutableInputs: immutableInputs(value), ...boundaries, journal, clock }, { cleanupOnly: true });
  assert.deepEqual(result, { schemaVersion: 1, state: "cleaned", retryAllowed: false });
  assert.equal(boundaries.state.terminateCalls, 1); assert.equal(boundaries.state.destroys, 1);
});

test("PID reuse, orphaned groups, and kill failure quarantine before provider mutation", async (t) => {
  const record = { pid: 4104, processGroupId: 4104, startTimeTicks: "991829", uid: 1000 };
  assert.equal(classifyPackerProcessObservationV1(record, { leader: { ...record, startTimeTicks: "991830" }, groupMembers: [4104] }), "identity-mismatch");
  assert.equal(classifyPackerProcessObservationV1(record, { leader: null, groupMembers: [4105] }), "orphaned");
  assert.equal(classifyPackerProcessObservationV1(record, { leader: null, groupMembers: [] }), "absent");
  for (const processState of ["identity-mismatch", "orphaned"]) {
    const value = reservation({ reservationId: `golden-process-${processState}` }); const { journal, clock } = await mutationJournal(t, value);
    const boundaries = runtime(value, new Date(NOW).toISOString(), { packerStates: [{ schemaVersion: 2, state: processState, operationId: OPERATION_ID }] });
    await assert.rejects(reconcileGoldenImageBuildV1({ reservation: value, immutableInputs: immutableInputs(value), ...boundaries, journal, clock }), { code: "PACKER_PROCESS_QUARANTINED" });
    assert.equal(boundaries.state.providerReads, 0); assert.equal(boundaries.state.destroys, 0);
  }
  const value = reservation({ reservationId: "golden-process-kill-failed" }); const { journal, clock } = await mutationJournal(t, value);
  const boundaries = runtime(value, new Date(NOW).toISOString(), {
    packerStates: [{ schemaVersion: 2, state: "running", operationId: OPERATION_ID, process: record }],
    terminateResult: { schemaVersion: 1, state: "quarantined", operationId: OPERATION_ID, reason: "kill-failed" },
  });
  await assert.rejects(reconcileGoldenImageBuildV1({ reservation: value, immutableInputs: immutableInputs(value), ...boundaries, journal, clock }, { cleanupOnly: true }), { code: "PACKER_PROCESS_QUARANTINED" });
  assert.equal(boundaries.state.providerReads, 0); assert.equal(boundaries.state.destroys, 0); assert.equal(boundaries.state.terminateCalls, 1);
});

test("bounded Packer terminator never signals a PID-reused or unsignalable group", async (t) => {
  const value = reservation({ reservationId: "golden-process-boundary" }); const root = await privateRoot(t);
  const record = { pid: 4106, processGroupId: 4106, startTimeTicks: "991831", uid: process.getuid() };
  const state = {
    schemaVersion: 2, kind: "nelos-golden-packer-operation", operationId: OPERATION_ID, reservationDigest: sha256V1(value), outputVmId: 9027,
    state: "running", startedAt: new Date(NOW).toISOString(), supervisorModuleDigest: `sha256:${"8".repeat(64)}`, process: record,
  };
  await writeFile(join(root, `${OPERATION_ID.slice(7)}.packer-operation.json`), `${canonicalJsonV1(state)}\n`, { mode: 0o600 });
  let signals = 0;
  const exactControl = {
    spawnSupervisor() { throw new Error("not used"); },
    async observe() { return { leader: structuredClone(record), groupMembers: [record.pid] }; },
    signalGroup() { signals += 1; throw Object.assign(new Error("denied"), { code: "EPERM" }); },
  };
  const boundary = new PackerBoundaryV1({
    packerBin: "/usr/bin/false", pluginBin: "/usr/bin/false", runRoot: root, operationRoot: root, sourceRoot: root,
    token: { value: () => "unused" }, reservation: value, varFile: join(root, "vars.json"), caFile: join(root, "ca.pem"), processControl: exactControl,
  });
  assert.deepEqual(await boundary.terminate({ operationId: OPERATION_ID, reservation: value }), { schemaVersion: 1, state: "quarantined", operationId: OPERATION_ID, reason: "term-failed" });
  assert.equal(signals, 1);
  const reused = new PackerBoundaryV1({
    packerBin: "/usr/bin/false", pluginBin: "/usr/bin/false", runRoot: root, operationRoot: root, sourceRoot: root,
    token: { value: () => "unused" }, reservation: value, varFile: join(root, "vars.json"), caFile: join(root, "ca.pem"),
    processControl: { ...exactControl, async observe() { return { leader: { ...record, startTimeTicks: "991999" }, groupMembers: [record.pid] }; } },
  });
  assert.deepEqual(await reused.terminate({ operationId: OPERATION_ID, reservation: value }), { schemaVersion: 1, state: "quarantined", operationId: OPERATION_ID, reason: "identity-mismatch" });
  assert.equal(signals, 1);
});

test("incomplete Packer output is cleaned only from independent task and ownership proof, then admits a new attempt", async (t) => {
  const value = reservation(); const { journal, clock } = await mutationJournal(t, value); const boundaries = runtime(value, new Date(NOW).toISOString(), { incompletePacker: true });
  const cleaned = await reconcileGoldenImageBuildV1({ reservation: value, immutableInputs: immutableInputs(value), ...boundaries, journal, clock });
  assert.deepEqual(cleaned, { schemaVersion: 1, state: "cleaned", retryAllowed: true }); assert.equal(boundaries.state.destroys, 1);
  const retry = await reconcileGoldenImageBuildV1({ reservation: value, immutableInputs: immutableInputs(value), ...boundaries, journal, clock });
  assert.equal(retry.state, "retry-admitted"); assert.equal(retry.retryAllowed, true); assert.equal(journal.attempt, 2);
});

test("completed Packer output with invalid recipe geometry is cleaned instead of resumed", async (t) => {
  const value = reservation(); const { journal, clock } = await mutationJournal(t, value); const boundaries = runtime(value, new Date(NOW).toISOString(), { invalidOutput: true });
  const result = await reconcileGoldenImageBuildV1({ reservation: value, immutableInputs: immutableInputs(value), ...boundaries, journal, clock });
  assert.equal(result.state, "cleaned"); assert.equal(boundaries.state.destroys, 1); assert.equal(boundaries.state.commits, 0);
});

test("cleanup reconciles crashes immediately before and after the exact destroy effect", async (t) => {
  for (const phase of ["cleanup-admitted", "cleanup-returned"]) {
    const value = reservation({ reservationId: `golden-recovery-${phase}` }); const { journal, clock } = await mutationJournal(t, value);
    const boundaries = runtime(value, new Date(NOW).toISOString(), { incompletePacker: true }); let injected = false;
    await assert.rejects(reconcileGoldenImageBuildV1({ reservation: value, immutableInputs: immutableInputs(value), ...boundaries, journal, clock }, {
      checkpoint: async ({ phase: current }) => { if (!injected && current === phase) { injected = true; throw Object.assign(new Error("simulated process loss"), { code: "SIMULATED_CRASH" }); } },
    }), { code: "SIMULATED_CRASH" });
    assert.equal(injected, true);
    const priorDestroys = boundaries.state.destroys;
    const result = await reconcileGoldenImageBuildV1({ reservation: value, immutableInputs: immutableInputs(value), ...boundaries, journal, clock });
    assert.ok(new Set(["cleaned", "retry-admitted"]).has(result.state));
    assert.equal(boundaries.state.destroys, phase === "cleanup-admitted" ? priorDestroys + 1 : priorDestroys);
  }
});

test("attestation and receipt commit checkpoints are idempotent across fresh-process loss", async (t) => {
  for (const crashPhase of ["attested", "receipt-committed"]) {
    const value = reservation({ reservationId: `golden-recovery-${crashPhase}` }); const { journal, clock } = await mutationJournal(t, value);
    const boundaries = runtime(value, new Date(NOW).toISOString()); let injected = false;
    await assert.rejects(reconcileGoldenImageBuildV1({ reservation: value, immutableInputs: immutableInputs(value), ...boundaries, journal, clock }, {
      checkpoint: async ({ phase }) => { if (!injected && phase === crashPhase) { injected = true; throw Object.assign(new Error("simulated process loss"), { code: "SIMULATED_CRASH" }); } },
    }), { code: "SIMULATED_CRASH" });
    const result = await reconcileGoldenImageBuildV1({ reservation: value, immutableInputs: immutableInputs(value), ...boundaries, journal, clock });
    assert.equal(result.state, "committed"); assert.equal(journal.entries.at(-1).phase, "committed"); assert.equal(boundaries.state.destroys, 0);
  }
});

test("missing or disagreeing provider history quarantines 9027 without deletion", async (t) => {
  for (const options of [{ emptyTasks: true }, { taskMismatch: true }]) {
    const value = reservation({ reservationId: `golden-recovery-quarantine-${Object.keys(options)[0]}` }); const { journal, clock } = await mutationJournal(t, value);
    const boundaries = runtime(value, new Date(NOW).toISOString(), options);
    await assert.rejects(reconcileGoldenImageBuildV1({ reservation: value, immutableInputs: immutableInputs(value), ...boundaries, journal, clock }), {
      code: options.taskMismatch ? "INDEPENDENT_RECOVERY_MISMATCH" : "OUTPUT_RECOVERY_UNPROVEN",
    });
    assert.equal(boundaries.state.destroys, 0); assert.equal(boundaries.state.outputPresent, true);
  }
});

test("terminal cleanup remains adoptable after active expiry and never authorizes a new build", async (t) => {
  const value = reservation({ expiresAt: new Date(NOW + 2_000_000).toISOString(), cleanupExpiresAt: new Date(NOW + 5_000_000).toISOString(), maxBuildMs: 1_800_000 });
  const { journal } = await mutationJournal(t, value); const startedAt = new Date(NOW).toISOString(); const boundaries = runtime(value, startedAt, { outputPresent: false });
  const lateClock = { now: () => NOW + 2_100_000 };
  const result = await reconcileGoldenImageBuildV1({ reservation: value, immutableInputs: immutableInputs(value), ...boundaries, journal, clock: lateClock });
  assert.deepEqual(result, { schemaVersion: 1, state: "cleaned", retryAllowed: false });
  assert.equal(boundaries.state.destroys, 0); assert.equal(boundaries.state.recoverCalls, 1);
});

test("Linux wrapper wires the persistent journal, durable Packer record, and dual provider-task recovery", async () => {
  const wrapper = await readFile(new URL("../validation/proxmox-desktop/v1/build-golden-image.mjs", import.meta.url), "utf8");
  assert.match(wrapper, /openGoldenImageJournalV1/u);
  assert.match(wrapper, /reconcileGoldenImageBuildV1/u);
  assert.match(wrapper, /\.packer-operation\.json/u);
  assert.match(wrapper, /async operationTasks\(\{ startedAt \}\)/u);
  assert.match(wrapper, /journal\.mode === "created"/u);
  assert.match(wrapper, /outcome\.state === "committed"\) committedReceipt = outcome\.receipt/u);
  assert.match(wrapper, /canonicalJsonV1\(\{ goldenImage: committedReceipt\.goldenImage, attestationDigest: committedReceipt\.attestationDigest, path \}\)/u);
  assert.match(wrapper, /"validation\/proxmox-desktop\/v1\/golden-image-recovery\.mjs"/u);
  assert.doesNotMatch(wrapper, /persistent journal already exists for this reservation/u);
});
