import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDesktopSmokeEvidenceBundleV1, DESKTOP_SMOKE_DIAGNOSTIC_LIMITS_V1 } from "nelos/desktop-smoke-evidence-contract";
import { parseMachineDesktopDriverResponseV1 } from "../src/machine-desktop-smoke-adapter.mjs";
import { createProxmoxDesktopDriverV1, ProxmoxDesktopDriverError, validateProxmoxDesktopDriverConfigV1, writeProxmoxDesktopDriverErrorV1 } from "nelos/proxmox-desktop-test-driver";

const requested = Object.freeze({ version: "0.12.20", digest: `sha256:${"a".repeat(64)}`, sourceRevision: "b".repeat(40) });
const runId = "release-run-1";

async function state(t, overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), "nelos-proxmox-driver-")); t.after(() => rm(root, { recursive: true, force: true }));
  const scenarioLibrary = JSON.parse(await readFile(new URL("../validation/desktop-smoke/scenario-sets/release.json", import.meta.url), "utf8"));
  const config = {
    schemaVersion: 1,
    api: { url: "https://pve.test.invalid:8006/api2/json", node: "pve-desktop", credentialFile: "/protected/token", caFile: "/protected/ca" },
    template: { vmid: 9100, name: "nelos-template", maintainedTag: "nelos-maintained-desktop-v1", storageIds: ["template-store"] },
    disposable: { vmid: 9199, name: "nelos-disposable", storage: "clone-store", guestHost: "guest.test.invalid", accountPrefix: "nelos-smoke", codexHomeRoot: "/var/lib/nelos-smoke" },
    ssh: { user: "nelos-driver", identityFile: "/protected/id", knownHostsFile: "/protected/known-hosts", guestDriver: "/usr/local/libexec/guest-driver", stagingRoot: "/var/lib/nelos-candidate" },
    reviewer: { executable: "/usr/local/libexec/reviewer" }, stateDirectory: join(root, "operations"),
  };
  let resources = [{ vmid: 9100, name: "nelos-template", node: "pve-desktop", template: 1 }];
  const calls = []; let installed = requested;
  const bundle = createDesktopSmokeEvidenceBundleV1({
    run: { schemaVersion: 1, runId, scenarioSetId: "release", candidate: requested, startedAt: "2026-08-28T00:00:00.000Z", finishedAt: "2026-08-28T00:00:01.000Z", outcome: "passed", scenarioIds: scenarioLibrary.scenarios.map(({ scenarioId }) => scenarioId).sort(), diagnosticLimits: { ...DESKTOP_SMOKE_DIAGNOSTIC_LIMITS_V1 } },
    checkpoints: [], artifacts: [], assertionResults: [], diagnostics: [], files: [],
  }).bytes;
  const runtime = {
    async verifyJq() { calls.push(["jq"]); },
    async listResources() { calls.push(["resources"]); return structuredClone(resources); },
    async getVmConfig() { calls.push(["template"]); return { template: 1, name: "nelos-template", tags: "other;nelos-maintained-desktop-v1", scsi0: "template-store:vm-9100-disk-0" }; },
    async listStorage() { calls.push(["storage"]); return [{ storage: "clone-store", active: 1, enabled: 1, content: "images,rootdir" }]; },
    async cloneVm() { calls.push(["clone"]); resources.push({ vmid: 9199, name: "nelos-disposable", node: "pve-desktop", template: 0 }); },
    async startVm() { calls.push(["start"]); },
    async stageCandidate(path) { calls.push(["stage", path]); return "/var/lib/nelos-candidate/release-run-1"; },
    async guest(operation, payload) {
      calls.push(["guest", operation, payload]);
      if (operation === "prepare-clone") return { prepared: true, accountId: payload.accountId, guestCodexHome: payload.guestCodexHome };
      if (operation === "install-candidate") return { identity: installed, digestVerified: true, exclusive: true };
      if (operation === "launch-and-read-loaded-identity") return { requestedCandidate: installed, loadedIdentity: installed, desktopLaunched: true, exclusive: true };
      if (operation === "execute-canonical-scenario") return { scenarioId: payload.scenario.scenarioId, operationId: payload.operationId, outcome: "passed", failure: null, assertionResults: payload.scenario.assertions.map(({ assertionId }) => ({ assertionId, outcome: "passed", code: "ASSERTION_PASSED" })), actionReceipts: payload.scenario.actions.map(({ actionId }) => ({ actionId, outcome: "completed", attempts: 1, submissionState: actionId.startsWith("submit-") ? "submitted" : "not_applicable" })) };
      if (operation === "package-sanitized-evidence") return { runId, bundleBase64: bundle.toString("base64"), sanitized: true, rawCapturesRemoved: true, temporaryMaterialRemoved: true };
      throw new Error(`unexpected guest operation ${operation}`);
    },
    async destroyVm() { calls.push(["destroy"]); resources = resources.filter(({ vmid }) => vmid !== 9199); },
    async review() { calls.push(["review"]); return { schemaVersion: 1, outcome: "clean", findings: [] }; },
    ...overrides,
  };
  return { root, config, scenarioLibrary, runtime, calls, bundle, setInstalled(value) { installed = value; }, driver: createProxmoxDesktopDriverV1({ config, runtime, scenarioLibrary }) };
}
function request(operation, payload) { return { schemaVersion: 1, operation, payload }; }
function candidate() { return { ...requested, packagePath: "/staged/reviewed-candidate" }; }
function cloneReceipt() { return { cloneId: `nelos-disposable-${runId}`, templateRef: "pve-desktop:9100:nelos-template", accountId: `nelos-smoke-${runId}`, guestCodexHome: `/var/lib/nelos-smoke/${runId}`, runId, fresh: true, templateMaintained: true, templateClean: true }; }
async function cloneAndInstall(stateValue) {
  const clone = await stateValue.driver.dispatch(request("clone-template-vm", { operationId: `op:${runId}:clone`, runId, candidate: candidate(), scenarioSetId: "release" }));
  await stateValue.driver.dispatch(request("install-candidate-vm", { operationId: `op:${runId}:install`, clone, candidate: candidate() })); return clone;
}

test("Proxmox provider runs the exact five scenarios and 19 actions with four at-most-once submissions", async (t) => {
  const value = await state(t); const clone = await cloneAndInstall(value);
  assert.deepEqual(await value.driver.dispatch(request("read-loaded-identity-vm", { operationId: `op:${runId}:identity`, clone })), requested);
  let actionCount = 0; let submissionCount = 0;
  for (const scenario of value.scenarioLibrary.scenarios) {
    const receipt = await value.driver.dispatch(request("execute-scenario-vm", { operationId: `op:${runId}:scenario:${scenario.scenarioId}`, clone, scenario, deadlines: { scenarioMs: scenario.deadlineMs, actionMs: Math.min(300000, scenario.deadlineMs) }, maxActionAttempts: 2 }));
    actionCount += receipt.actionReceipts.length; submissionCount += receipt.actionReceipts.filter(({ submissionState }) => submissionState === "submitted").length;
  }
  assert.equal(actionCount, 19); assert.equal(submissionCount, 4);
  const packaged = await value.driver.dispatch(request("package-evidence-vm", { operationId: `op:${runId}:package`, clone, runId, scenarioIds: value.scenarioLibrary.scenarios.map(({ scenarioId }) => scenarioId) }));
  assert.equal(packaged.sanitized, true); assert.equal(packaged.rawCapturesRemoved, true); assert.equal(packaged.temporaryMaterialRemoved, true);
  assert.deepEqual(await value.driver.dispatch(request("destroy-clone-vm", { operationId: `op:${runId}:destroy`, clone })), { cloneId: clone.cloneId, destroyed: true });
  assert.deepEqual(await value.driver.dispatch(request("verify-absent-vm", { operationId: `op:${runId}:absence`, clone })), { cloneId: clone.cloneId, absent: true, independent: true });
  assert.equal(value.calls.filter(([kind]) => kind === "jq").length, 11);
});

test("closed request/config shapes, template identity, clone collision, and storage inputs fail closed", async (t) => {
  const value = await state(t);
  await assert.rejects(value.driver.dispatch({ schemaVersion: 1, operation: "clone-template-vm", payload: {}, extra: true }), /unsupported shape/u);
  assert.throws(() => validateProxmoxDesktopDriverConfigV1({ ...value.config, credential: "embedded" }), /unsupported shape/u);
  const ambiguous = await state(t, { async listResources() { return [{ vmid: 9100, name: "nelos-template", node: "pve-desktop", template: 1 }, { vmid: 9101, name: "nelos-template", node: "pve-desktop", template: 1 }]; } });
  await assert.rejects(cloneAndInstall(ambiguous), (error) => error.code === "TEMPLATE_IDENTITY_AMBIGUOUS");
  const collision = await state(t, { async listResources() { return [{ vmid: 9100, name: "nelos-template", node: "pve-desktop", template: 1 }, { vmid: 9199, name: "occupied", node: "pve-desktop", template: 0 }]; } });
  await assert.rejects(cloneAndInstall(collision), (error) => error.code === "CLONE_COLLISION");
  const badStorage = await state(t, { async listStorage() { return [{ storage: "clone-store", active: 0, enabled: 1, content: "images" }]; } });
  await assert.rejects(cloneAndInstall(badStorage), (error) => error.code === "DISPOSABLE_STORAGE_UNAVAILABLE");
});

test("jq absence blocks every provider path before dispatch and preflight failures remain safely retryable", async (t) => {
  let providerCalls = 0; const missing = await state(t, { async verifyJq() { throw new ProxmoxDesktopDriverError("JQ_UNAVAILABLE", "jq missing"); }, async listResources() { providerCalls += 1; return []; } });
  await assert.rejects(cloneAndInstall(missing), (error) => error.code === "JQ_UNAVAILABLE" && error.details?.retryDisposition === "safe_before_dispatch"); assert.equal(providerCalls, 0);
  let reads = 0; const safe = await state(t, { async listResources() { reads += 1; if (reads === 1) throw new ProxmoxDesktopDriverError("API_UNAVAILABLE", "safe"); return [{ vmid: 9100, name: "nelos-template", node: "pve-desktop", template: 1 }]; } });
  await assert.rejects(cloneAndInstall(safe), (error) => error.code === "API_UNAVAILABLE" && error.details?.retryDisposition === "safe_before_dispatch"); const clone = await cloneAndInstall(safe); assert.equal(clone.runId, runId); assert.equal(reads, 2); assert.equal(safe.calls.filter(([kind]) => kind === "clone").length, 1);
});

test("every post-dispatch clone failure destroys the exact disposable VM and independently proves absence", async (t) => {
  const failures = [
    { name: "clone task polling", overrides: { async cloneVm() { throw new ProxmoxDesktopDriverError("PROXMOX_TASK_FAILED", "clone polling failed"); } } },
    { name: "start", overrides: { async startVm() { throw new ProxmoxDesktopDriverError("PROXMOX_TASK_FAILED", "start failed"); } } },
    { name: "guest preparation", overrides: { async guest() { throw new ProxmoxDesktopDriverError("GUEST_PREPARE_FAILED", "prepare failed"); } } },
  ];
  for (const injected of failures) {
    await t.test(injected.name, async (t) => {
      const value = await state(t, injected.overrides);
      await assert.rejects(cloneAndInstall(value), (error) => error.details?.retryDisposition === "ambiguous_after_dispatch");
      assert.equal(value.calls.filter(([kind]) => kind === "destroy").length, 1);
      assert.equal(value.calls.filter(([kind]) => kind === "resources").length, 2);
    });
  }
  const ambiguous = await state(t, { async cloneVm() { throw new ProxmoxDesktopDriverError("PROXMOX_TASK_FAILED", "clone polling failed"); }, async destroyVm() { throw new ProxmoxDesktopDriverError("DESTROY_FAILED", "destroy failed"); } });
  await assert.rejects(cloneAndInstall(ambiguous), (error) => error.code === "CLEANUP_NOT_PROVEN" && error.details?.retryDisposition === "ambiguous_after_dispatch");
});

test("candidate installation and loaded Desktop identity bind version, digest, revision, and exclusivity", async (t) => {
  const badInstall = await state(t); badInstall.setInstalled({ ...requested, sourceRevision: "c".repeat(40) });
  await assert.rejects(cloneAndInstall(badInstall), (error) => error.code === "CANDIDATE_IDENTITY_MISMATCH");
  const badLoaded = await state(t); const clone = await cloneAndInstall(badLoaded); badLoaded.setInstalled({ ...requested, digest: `sha256:${"d".repeat(64)}` });
  await assert.rejects(badLoaded.driver.dispatch(request("read-loaded-identity-vm", { operationId: `op:${runId}:identity`, clone })), (error) => error.code === "CANDIDATE_IDENTITY_MISMATCH");
});

test("scenario deadline and ambiguous submission dispatch are never retried", async (t) => {
  let scenarioCalls = 0; const value = await state(t, { async guest(operation, payload) { if (operation !== "execute-canonical-scenario") return stateGuestFallback(value, operation, payload); scenarioCalls += 1; return new Promise(() => {}); } });
  // Replace the self-referential override with the default behavior for setup.
  value.runtime.guest = async (operation, payload) => {
    if (operation === "prepare-clone") return { prepared: true, accountId: payload.accountId, guestCodexHome: payload.guestCodexHome };
    if (operation === "install-candidate") return { identity: requested, digestVerified: true, exclusive: true };
    if (operation === "execute-canonical-scenario") { scenarioCalls += 1; return new Promise(() => {}); }
    throw new Error("unexpected");
  };
  const clone = await cloneAndInstall(value); const scenario = structuredClone(value.scenarioLibrary.scenarios[1]); scenario.deadlineMs = 10; scenario.actions.forEach((action) => { action.timeoutMs = Math.min(action.timeoutMs, 10); });
  // The changed scenario is rejected before dispatch; the canonical scenario with a bounded controller deadline times out after dispatch.
  await assert.rejects(value.driver.dispatch(request("execute-scenario-vm", { operationId: "op:changed", clone, scenario, deadlines: { scenarioMs: 10, actionMs: 10 }, maxActionAttempts: 2 })), /canonical/u);
  const canonical = value.scenarioLibrary.scenarios[1];
  await assert.rejects(value.driver.dispatch(request("execute-scenario-vm", { operationId: "op:ambiguous", clone, scenario: canonical, deadlines: { scenarioMs: 10, actionMs: 10 }, maxActionAttempts: 2 })), (error) => error.code === "PROVIDER_DEADLINE_EXCEEDED" && error.details?.retryDisposition === "ambiguous_after_dispatch");
  await assert.rejects(value.driver.dispatch(request("execute-scenario-vm", { operationId: "op:ambiguous", clone, scenario: canonical, deadlines: { scenarioMs: 10, actionMs: 10 }, maxActionAttempts: 2 })), (error) => error.code === "AMBIGUOUS_AFTER_DISPATCH"); assert.equal(scenarioCalls, 1);
});

test("passed scenario receipts require every canonical action and assertion exactly once and passed", async (t) => {
  const value = await state(t); const clone = await cloneAndInstall(value); const scenario = value.scenarioLibrary.scenarios[0];
  const complete = () => ({ scenarioId: scenario.scenarioId, operationId: "unused", outcome: "passed", failure: null, assertionResults: scenario.assertions.map(({ assertionId }) => ({ assertionId, outcome: "passed", code: "ASSERTION_PASSED" })), actionReceipts: scenario.actions.map(({ actionId }) => ({ actionId, outcome: "completed", attempts: 1, submissionState: actionId.startsWith("submit-") ? "submitted" : "not_applicable" })) });
  const variants = [
    (receipt) => { receipt.assertionResults.pop(); },
    (receipt) => { receipt.assertionResults[1] = structuredClone(receipt.assertionResults[0]); },
    (receipt) => { receipt.actionReceipts[0].outcome = "skipped"; },
    (receipt) => { receipt.assertionResults[0].outcome = "failed"; },
  ];
  for (const [index, mutate] of variants.entries()) {
    const operationId = `op:invalid-scenario:${index}`; const receipt = complete(); receipt.operationId = operationId; mutate(receipt);
    value.runtime.guest = async () => receipt;
    await assert.rejects(value.driver.dispatch(request("execute-scenario-vm", { operationId, clone, scenario, deadlines: { scenarioMs: scenario.deadlineMs, actionMs: Math.min(300000, scenario.deadlineMs) }, maxActionAttempts: 2 })), (error) => error.code === "INVALID_GUEST_RECEIPT" && error.details?.retryDisposition === "ambiguous_after_dispatch");
  }
});

test("CLI error framing preserves only typed retry disposition through the machine adapter boundary", async (t) => {
  const missing = await state(t, { async verifyJq() { throw new ProxmoxDesktopDriverError("JQ_UNAVAILABLE", "jq missing"); } });
  let jqError; try { await cloneAndInstall(missing); } catch (error) { jqError = error; }
  let wire = ""; writeProxmoxDesktopDriverErrorV1({ write(chunk) { wire += chunk; } }, jqError);
  assert.throws(() => parseMachineDesktopDriverResponseV1({ status: 1, stdout: wire, operation: "clone-template-vm" }), (error) => error.code === "JQ_UNAVAILABLE" && error.details?.retryDisposition === "safe_before_dispatch");
  wire = ""; writeProxmoxDesktopDriverErrorV1({ write(chunk) { wire += chunk; } }, new ProxmoxDesktopDriverError("OPERATION_LOST", "lost", { retryDisposition: "ambiguous_after_dispatch", unsafe: "discarded" }));
  assert.throws(() => parseMachineDesktopDriverResponseV1({ status: 1, stdout: wire, operation: "execute-scenario-vm" }), (error) => error.code === "OPERATION_LOST" && error.details?.retryDisposition === "ambiguous_after_dispatch");
  assert.throws(() => parseMachineDesktopDriverResponseV1({ status: 1, stdout: '{"schemaVersion":1,"error":{"code":"JQ_UNAVAILABLE","message":"jq missing","details":{"retryDisposition":"safe_before_dispatch","extra":true}}}\n', operation: "clone-template-vm" }), (error) => error.code === "DESKTOP_DRIVER_FAILED");
});

function stateGuestFallback() { throw new Error("unused"); }

test("unsafe or altered evidence and review material are rejected while deterministic receipts replay", async (t) => {
  const value = await state(t); const clone = await cloneAndInstall(value);
  const packageRequest = request("package-evidence-vm", { operationId: "op:package", clone, runId, scenarioIds: value.scenarioLibrary.scenarios.map(({ scenarioId }) => scenarioId) });
  const first = await value.driver.dispatch(packageRequest); const second = await value.driver.dispatch(packageRequest); assert.deepEqual(first, second); assert.equal(value.calls.filter(([, operation]) => operation === "package-sanitized-evidence").length, 1);
  const unsafe = await state(t, { async guest(operation, payload) { if (operation === "prepare-clone") return { prepared: true, accountId: payload.accountId, guestCodexHome: payload.guestCodexHome }; if (operation === "install-candidate") return { identity: requested, digestVerified: true, exclusive: true }; if (operation === "package-sanitized-evidence") return { runId, bundleBase64: Buffer.from("{}").toString("base64"), sanitized: true, rawCapturesRemoved: true, temporaryMaterialRemoved: true }; throw new Error("unexpected"); } });
  const unsafeClone = await cloneAndInstall(unsafe); await assert.rejects(unsafe.driver.dispatch(request("package-evidence-vm", { operationId: "op:unsafe", clone: unsafeClone, runId, scenarioIds: unsafe.scenarioLibrary.scenarios.map(({ scenarioId }) => scenarioId) })), (error) => error.code === "INVALID_EVIDENCE_CONTRACT" && error.details?.retryDisposition === "ambiguous_after_dispatch");
  const bytes = Buffer.from([1, 2, 3]); const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const context = { schemaVersion: 1, manifestContext: { bundleId: "bundle-1", runId, bundleDigest: `sha256:${"e".repeat(64)}`, format: "nelos-desktop-smoke-evidence-v1", totals: { recordCount: 1, fileCount: 1, fileBytes: 3, diagnosticCount: 0, diagnosticBytes: 0 } }, screenshots: [{ artifactId: "shot-1", scenarioId: "planning-lifecycle", checkpointId: "plan-ready-state", evidenceDigest: digest, mediaType: "image/png", byteLength: 3, width: 1, height: 1, bytes }] };
  assert.deepEqual(await value.driver.dispatch(request("review-sanitized-bundle", context)), { schemaVersion: 1, outcome: "clean", findings: [] });
  const altered = structuredClone(context); altered.screenshots[0].bytes = bytes; altered.screenshots[0].byteLength = 2; await assert.rejects(value.driver.dispatch(request("review-sanitized-bundle", altered)), /digest/u);
  const secret = structuredClone(context); secret.screenshots[0].bytes = bytes; secret.screenshots[0].secret = "x"; await assert.rejects(value.driver.dispatch(request("review-sanitized-bundle", secret)), /unsupported shape/u);
});

test("destruction failure remains ambiguous and independent absence rejects a surviving clone", async (t) => {
  let destroys = 0; const value = await state(t, { async destroyVm() { destroys += 1; throw new ProxmoxDesktopDriverError("DESTROY_FAILED", "injected"); } }); const clone = await cloneAndInstall(value);
  const destroy = request("destroy-clone-vm", { operationId: "op:destroy-fail", clone }); await assert.rejects(value.driver.dispatch(destroy), (error) => error.code === "DESTROY_FAILED"); await assert.rejects(value.driver.dispatch(destroy), (error) => error.code === "AMBIGUOUS_AFTER_DISPATCH"); assert.equal(destroys, 1);
  await assert.rejects(value.driver.dispatch(request("verify-absent-vm", { operationId: "op:absence-live", clone })), (error) => error.code === "CLONE_STILL_PRESENT");
});

test("installation artifact fixes pinned-host SSH and contains no embedded credential", async () => {
  const source = await readFile(new URL("../src/proxmox-desktop-test-driver.mjs", import.meta.url), "utf8"); const example = await readFile(new URL("../validation/proxmox/desktop-driver/config.json.example", import.meta.url), "utf8");
  assert.match(source, /StrictHostKeyChecking=yes/u); assert.match(source, /UserKnownHostsFile=/u); assert.match(source, /\/usr\/bin\/jq/u); assert.doesNotMatch(example, /PVEAPIToken|tokenSecret|credential\s*:/u);
});
