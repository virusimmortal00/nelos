import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createDesktopSmokeEvidenceBundleV1, DESKTOP_SMOKE_DIAGNOSTIC_LIMITS_V1 } from "nelos/desktop-smoke-evidence-contract";
import { createMachineFreshVmDesktopAdapterTestV1, createMachineFreshVmDesktopAdapterV1, parseMachineDesktopDriverResponseV1, PROXMOX_CLONE_PROCESS_LIMITS_V1 } from "../src/machine-desktop-smoke-adapter.mjs";
import { FRESH_VM_DEADLINES_V1 } from "../src/fresh-vm-desktop-runner.mjs";
import { createProxmoxDesktopDriverV1, ProxmoxDesktopDriverError, validateProxmoxDesktopDriverConfigV1, writeProxmoxDesktopDriverErrorV1 } from "nelos/proxmox-desktop-test-driver";

const requested = Object.freeze({ version: "0.12.20", digest: `sha256:${"a".repeat(64)}`, sourceRevision: "b".repeat(40) });
const runId = "release-run-1";

function scenarioReceiptsFor(scenarioLibrary) {
  return scenarioLibrary.scenarios.map((scenario) => ({ scenarioId: scenario.scenarioId, operationId: `op:${runId}:scenario:${scenario.scenarioId}`, outcome: "passed", failure: null, assertionResults: scenario.assertions.map(({ assertionId }) => ({ assertionId, outcome: "passed", code: "ASSERTION_PASSED" })), actionReceipts: scenario.actions.map(({ actionId }) => ({ actionId, outcome: "completed", attempts: 1, submissionState: actionId.startsWith("submit-") ? "submitted" : "not_applicable" })) }));
}
function evidenceBundleFor(scenarioLibrary, scenarioReceipts, { omitAssertionId = null, overrideAssertion = null } = {}) {
  const results = scenarioLibrary.scenarios.flatMap((scenario) => {
    const receipt = scenarioReceipts.find((item) => item.scenarioId === scenario.scenarioId);
    return receipt.assertionResults.filter(({ assertionId }) => assertionId !== omitAssertionId).map((result) => {
      const assertion = scenario.assertions.find(({ assertionId }) => assertionId === result.assertionId); const changed = overrideAssertion?.assertionId === result.assertionId ? { ...result, ...overrideAssertion } : result;
      return { schemaVersion: 1, assertionId: changed.assertionId, runId, scenarioId: scenario.scenarioId, checkpointId: assertion.checkpointId, outcome: changed.outcome, code: changed.code };
    });
  });
  const checkpointIds = new Set(results.map(({ checkpointId }) => checkpointId));
  const checkpoints = scenarioLibrary.scenarios.flatMap((scenario) => scenario.checkpoints.filter(({ checkpointId }) => checkpointIds.has(checkpointId)).map((checkpoint) => ({ schemaVersion: 1, checkpointId: checkpoint.checkpointId, runId, scenarioId: scenario.scenarioId, type: checkpoint.type, outcome: "skipped", artifactIds: [] })));
  return createDesktopSmokeEvidenceBundleV1({ run: { schemaVersion: 1, runId, scenarioSetId: "release", candidate: requested, startedAt: "2026-08-28T00:00:00.000Z", finishedAt: "2026-08-28T00:00:01.000Z", outcome: scenarioReceipts.every(({ outcome }) => outcome === "passed") ? "passed" : "failed", scenarioIds: scenarioLibrary.scenarios.map(({ scenarioId }) => scenarioId).sort(), diagnosticLimits: { ...DESKTOP_SMOKE_DIAGNOSTIC_LIMITS_V1 } }, checkpoints, artifacts: [], assertionResults: results, diagnostics: [], files: [] }).bytes;
}

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
  const bundle = evidenceBundleFor(scenarioLibrary, scenarioReceiptsFor(scenarioLibrary));
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
    async cleanupCloneAttempt() { calls.push(["cleanup-attempt"]); const present = resources.some(({ vmid }) => vmid === 9199); if (present) { calls.push(["destroy"]); resources = resources.filter(({ vmid }) => vmid !== 9199); } return { destructionDisposition: present ? "destroyed" : "not_present_after_settlement", absent: true, independent: true }; },
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
async function executeAllScenarios(stateValue, clone) {
  const receipts = [];
  for (const scenario of stateValue.scenarioLibrary.scenarios) receipts.push(await stateValue.driver.dispatch(request("execute-scenario-vm", { operationId: `op:${runId}:scenario:${scenario.scenarioId}`, clone, scenario, deadlines: { scenarioMs: scenario.deadlineMs, actionMs: Math.min(300000, scenario.deadlineMs) }, maxActionAttempts: 2 })));
  return receipts;
}
function packagePayload(stateValue, clone, scenarioReceipts, operationId = `op:${runId}:package`) { return { operationId, clone, runId, scenarioIds: stateValue.scenarioLibrary.scenarios.map(({ scenarioId }) => scenarioId), scenarioReceipts }; }

test("Proxmox provider runs the exact five scenarios and 19 actions with four at-most-once submissions", async (t) => {
  const value = await state(t); const clone = await cloneAndInstall(value);
  assert.deepEqual(await value.driver.dispatch(request("read-loaded-identity-vm", { operationId: `op:${runId}:identity`, clone })), requested);
  const scenarioReceipts = await executeAllScenarios(value, clone); let actionCount = 0; let submissionCount = 0;
  for (const receipt of scenarioReceipts) { actionCount += receipt.actionReceipts.length; submissionCount += receipt.actionReceipts.filter(({ submissionState }) => submissionState === "submitted").length; }
  assert.equal(actionCount, 19); assert.equal(submissionCount, 4);
  const packaged = await value.driver.dispatch(request("package-evidence-vm", packagePayload(value, clone, scenarioReceipts)));
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
    { name: "clone task polling", expectedDestroy: 0, overrides: { async cloneVm() { throw new ProxmoxDesktopDriverError("PROXMOX_TASK_FAILED", "clone polling failed"); } } },
    { name: "start", expectedDestroy: 1, overrides: { async startVm() { throw new ProxmoxDesktopDriverError("PROXMOX_TASK_FAILED", "start failed"); } } },
    { name: "guest preparation", expectedDestroy: 1, overrides: { async guest() { throw new ProxmoxDesktopDriverError("GUEST_PREPARE_FAILED", "prepare failed"); } } },
  ];
  for (const injected of failures) {
    await t.test(injected.name, async (t) => {
      const value = await state(t, injected.overrides);
      await assert.rejects(cloneAndInstall(value), (error) => error.details?.retryDisposition === "ambiguous_after_dispatch");
      assert.equal(value.calls.filter(([kind]) => kind === "destroy").length, injected.expectedDestroy);
      assert.equal(value.calls.filter(([kind]) => kind === "cleanup-attempt").length, 1);
    });
  }
  const ambiguous = await state(t, { async cloneVm() { throw new ProxmoxDesktopDriverError("PROXMOX_TASK_FAILED", "clone polling failed"); }, async cleanupCloneAttempt() { throw new ProxmoxDesktopDriverError("DESTROY_FAILED", "destroy failed"); } });
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

test("process boundary reserves adapter-owned cleanup for late clone state, child death, polling deadlines, cleanup deadlines, and ambiguous absence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "nelos-clone-process-boundary-")); t.after(() => rm(root, { recursive: true, force: true }));
  const shell = await realpath("/bin/sh");
  const writeScripts = async (cloneScript, cleanupScript) => {
    await writeFile(join(root, "clone-template-vm"), `IFS= read -r _\n${cloneScript}`, { mode: 0o600 });
    await writeFile(join(root, "cleanup-clone-attempt-vm"), `IFS= read -r _\n${cleanupScript}`, { mode: 0o600 });
  };
  const payload = { operationId: "op:process:clone", runId: "process-run-1", candidate: candidate(), scenarioSetId: "release" };
  const adapter = (primaryMs = 250, cleanupMs = 8_000) => createMachineFreshVmDesktopAdapterTestV1({ executable: shell, workingDirectory: root, primaryMs, cleanupMs, cleanupSettlementMs: 1_000 });
  const cleanupSuccess = 'rm -f late-clone\nprintf \'%s\\n\' \'{"runId":"process-run-1","destructionDisposition":"destroyed","absent":true,"independent":true}\'\n';

  await writeScripts("sleep 10\n", `sleep 2\n${cleanupSuccess}`);
  const late = new Promise((resolvePromise, rejectPromise) => setTimeout(() => writeFile(join(root, "late-clone"), "created-by-external-provider-task").then(resolvePromise, rejectPromise), 500));
  await assert.rejects(adapter().cloneTemplate(payload), (error) => error.code === "DESKTOP_DRIVER_FAILED"); await late;
  await assert.rejects(access(join(root, "late-clone")));

  await writeScripts("exit 9\n", `touch child-cleaned\n${cleanupSuccess}`);
  await assert.rejects(adapter().cloneTemplate(payload), (error) => error.code === "DESKTOP_DRIVER_FAILED"); await access(join(root, "child-cleaned"));

  await writeScripts('printf \'%s\\n\' \'{"schemaVersion":1,"error":{"code":"PROVIDER_DEADLINE_EXCEEDED","message":"clone polling deadline","details":{"retryDisposition":"ambiguous_after_dispatch"}}}\'\nexit 1\n', cleanupSuccess);
  await assert.rejects(adapter().cloneTemplate(payload), (error) => error.code === "PROVIDER_DEADLINE_EXCEEDED" && error.details?.retryDisposition === "ambiguous_after_dispatch");

  await writeScripts("exit 9\n", "sleep 1\n");
  await assert.rejects(adapter(250, 250).cloneTemplate(payload), (error) => error.code === "CLEANUP_NOT_PROVEN" && error.details?.cleanupCode === "DESKTOP_DRIVER_FAILED");

  await writeScripts("exit 9\n", 'printf \'%s\\n\' \'{"runId":"process-run-1","destructionDisposition":"destroyed","absent":false,"independent":true}\'\n');
  await assert.rejects(adapter().cloneTemplate(payload), (error) => error.code === "CLEANUP_NOT_PROVEN");
});

test("production clone deadline geometry reserves both process phases before the controller can abandon the adapter", () => {
  const adapter = createMachineFreshVmDesktopAdapterV1();
  assert.equal(adapter.cloneControllerMinimumMs, PROXMOX_CLONE_PROCESS_LIMITS_V1.primaryMs + PROXMOX_CLONE_PROCESS_LIMITS_V1.cleanupMs + 60_000);
  assert.ok(FRESH_VM_DEADLINES_V1.cloneMs > PROXMOX_CLONE_PROCESS_LIMITS_V1.primaryMs + PROXMOX_CLONE_PROCESS_LIMITS_V1.cleanupMs);
  assert.ok(FRESH_VM_DEADLINES_V1.runMs > FRESH_VM_DEADLINES_V1.cloneMs);
});

function stateGuestFallback() { throw new Error("unused"); }

test("unsafe or altered evidence and review material are rejected while deterministic receipts replay", async (t) => {
  const value = await state(t); const clone = await cloneAndInstall(value); const scenarioReceipts = await executeAllScenarios(value, clone);
  const packageRequest = request("package-evidence-vm", packagePayload(value, clone, scenarioReceipts, "op:package"));
  const first = await value.driver.dispatch(packageRequest); const second = await value.driver.dispatch(packageRequest); assert.deepEqual(first, second); assert.equal(value.calls.filter(([, operation]) => operation === "package-sanitized-evidence").length, 1);
  const unsafe = await state(t, { async guest(operation, payload) { if (operation === "prepare-clone") return { prepared: true, accountId: payload.accountId, guestCodexHome: payload.guestCodexHome }; if (operation === "install-candidate") return { identity: requested, digestVerified: true, exclusive: true }; if (operation === "execute-canonical-scenario") return { scenarioId: payload.scenario.scenarioId, operationId: payload.operationId, outcome: "passed", failure: null, assertionResults: payload.scenario.assertions.map(({ assertionId }) => ({ assertionId, outcome: "passed", code: "ASSERTION_PASSED" })), actionReceipts: payload.scenario.actions.map(({ actionId }) => ({ actionId, outcome: "completed", attempts: 1, submissionState: actionId.startsWith("submit-") ? "submitted" : "not_applicable" })) }; if (operation === "package-sanitized-evidence") return { runId, bundleBase64: Buffer.from("{}").toString("base64"), sanitized: true, rawCapturesRemoved: true, temporaryMaterialRemoved: true }; throw new Error("unexpected"); } });
  const unsafeClone = await cloneAndInstall(unsafe); const unsafeReceipts = await executeAllScenarios(unsafe, unsafeClone); await assert.rejects(unsafe.driver.dispatch(request("package-evidence-vm", packagePayload(unsafe, unsafeClone, unsafeReceipts, "op:unsafe"))), (error) => error.code === "INVALID_EVIDENCE_CONTRACT" && error.details?.retryDisposition === "ambiguous_after_dispatch");
  const bytes = Buffer.from([1, 2, 3]); const digest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const context = { schemaVersion: 1, manifestContext: { bundleId: "bundle-1", runId, bundleDigest: `sha256:${"e".repeat(64)}`, format: "nelos-desktop-smoke-evidence-v1", totals: { recordCount: 1, fileCount: 1, fileBytes: 3, diagnosticCount: 0, diagnosticBytes: 0 } }, screenshots: [{ artifactId: "shot-1", scenarioId: "planning-lifecycle", checkpointId: "plan-ready-state", evidenceDigest: digest, mediaType: "image/png", byteLength: 3, width: 1, height: 1, bytes }] };
  assert.deepEqual(await value.driver.dispatch(request("review-sanitized-bundle", context)), { schemaVersion: 1, outcome: "clean", findings: [] });
  const altered = structuredClone(context); altered.screenshots[0].bytes = bytes; altered.screenshots[0].byteLength = 2; await assert.rejects(value.driver.dispatch(request("review-sanitized-bundle", altered)), /digest/u);
  const secret = structuredClone(context); secret.screenshots[0].bytes = bytes; secret.screenshots[0].secret = "x"; await assert.rejects(value.driver.dispatch(request("review-sanitized-bundle", secret)), /unsupported shape/u);
});

test("provider rejects partial packaged assertions and receipt-to-evidence divergence", async (t) => {
  const value = await state(t); const clone = await cloneAndInstall(value); const receipts = await executeAllScenarios(value, clone);
  const diverged = structuredClone(receipts); diverged[0].assertionResults[0].code = "DIFFERENT_RESULT";
  await assert.rejects(value.driver.dispatch(request("package-evidence-vm", packagePayload(value, clone, diverged, "op:receipt-divergence"))), (error) => error.code === "EVIDENCE_EXECUTION_MISMATCH" && error.details?.retryDisposition === "safe_before_dispatch");
  const omitted = value.scenarioLibrary.scenarios[0].assertions[0].assertionId; const partialBundle = evidenceBundleFor(value.scenarioLibrary, receipts, { omitAssertionId: omitted });
  value.runtime.guest = async (operation) => { if (operation === "package-sanitized-evidence") return { runId, bundleBase64: partialBundle.toString("base64"), sanitized: true, rawCapturesRemoved: true, temporaryMaterialRemoved: true }; throw new Error("unexpected guest operation"); };
  await assert.rejects(value.driver.dispatch(request("package-evidence-vm", packagePayload(value, clone, receipts, "op:partial-evidence"))), (error) => error.code === "EVIDENCE_EXECUTION_MISMATCH" && error.details?.retryDisposition === "ambiguous_after_dispatch");
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
