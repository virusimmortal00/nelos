import assert from "node:assert/strict";
import test from "node:test";
import { setImmediate as tick } from "node:timers/promises";
import { ExecutorGrantAuthorityV1, gateExecutorWaveV1 } from "../src/executor-grants.mjs";
import { executorDigest, normalizeExecutorWaveV1 } from "../src/executor-contract.mjs";
import { executorProviders, executorWave } from "./support/executor-fixture.mjs";

function authority(t, options = {}) {
  const service = new ExecutorGrantAuthorityV1({ ...executorProviders(), ...options });
  t.after(() => service.close());
  return service;
}

test("#125: JSON capability claims and a modified receipt cannot authorize an executor", async (t) => {
  const wave = executorWave();
  const service = authority(t, { authorize: null });
  assert.equal((await service.issue({ wave })).kind, "authorization-required");
  await assert.rejects(service.issue({ wave, launcherAvailable: true, userIntentConfirmed: true }), /invalid-contract/);
  const fake = { executionGrantId: `grant:${"a".repeat(36)}`, creationAuthorized: true, launcherAvailable: true };
  const gated = await gateExecutorWaveV1({ authority: service, wave, executionGrantId: fake.executionGrantId });
  assert.equal(gated.kind, "authorization-required");
  assert.equal(gated.reason, "unknown-execution-grant");
  assert.equal((await gateExecutorWaveV1({ authority: { validate: () => fake }, wave })).kind, "execution-unavailable");
});

test("issued IDs reference private scope records and gate the whole wave", async (t) => {
  const service = authority(t);
  const wave = executorWave();
  const issued = await service.issue({ wave });
  assert.equal(issued.kind, "execution-granted");
  assert.match(issued.executionGrantId, /^grant:/);
  issued.scopeDigest = "0".repeat(64);
  const result = await gateExecutorWaveV1({ authority: service, wave, executionGrantId: issued.executionGrantId });
  assert.equal(result.kind, "execution-admitted");
  assert.equal(result.scopeDigest, executorDigest(wave));
  result.wave.members[0].model = "mutated-output";
  assert.equal((await service.validate({ wave, executionGrantId: issued.executionGrantId })).kind, "execution-admitted");
});

test("target, launch sequence, prompt, route, policy, and membership changes require a fresh grant", async (t) => {
  const service = authority(t);
  const wave = executorWave();
  const { executionGrantId } = await service.issue({ wave });
  const variants = [
    (w) => { w.members[0].target.hostId = "another-host"; },
    (w) => { w.members[0].target.codexHomeId = "2".repeat(64); },
    (w) => { w.members[0].target.repositoryId = "2".repeat(64); },
    (w) => { w.members[0].target.cwd = "/another/worktree"; },
    (w) => { w.members[0].model = "different-model"; },
    (w) => { w.members[0].reasoningEffort = "low"; },
    (w) => { w.members[0].permissionProfile = "full-access"; },
    (w) => { w.members[0].approvalPolicy = "never"; },
    (w) => { w.members[0].promptDigest = "2".repeat(64); },
    (w) => { w.members[0].launchSequence += 1; },
    (w) => { w.members[0].attempt += 1; },
    (w) => { w.waveDigest = "2".repeat(64); },
    (w) => { w.members.push({ ...w.members[0], workUnitId: "unit-2", sliceId: "second" }); },
  ];
  for (const mutate of variants) {
    const changed = structuredClone(wave);
    mutate(changed);
    assert.equal((await service.validate({ wave: changed, executionGrantId })).reason, "execution-grant-scope-mismatch");
  }
});

test("account/config/owner changes, revocation, expiry, and restart invalidate grants", async (t) => {
  for (const field of ["epoch", "account", "config"]) {
    const providers = executorProviders();
    const service = authority(t, providers);
    const wave = executorWave();
    const { executionGrantId } = await service.issue({ wave });
    providers.state[field] = field === "epoch" ? "next-owner" : "2".repeat(64);
    assert.equal((await service.validate({ wave, executionGrantId })).reason, "stale-execution-grant");
    assert.equal((await service.validate({ wave, executionGrantId })).kind, "authorization-required");
  }
  let now = 1000;
  const service = authority(t, executorProviders({ now: () => now }));
  const wave = executorWave();
  const grant = await service.issue({ wave });
  assert.equal((await authority(t).validate({ wave, executionGrantId: grant.executionGrantId })).kind, "authorization-required");
  now = grant.expiresAt;
  assert.equal((await service.validate({ wave, executionGrantId: grant.executionGrantId })).kind, "authorization-required");
  const next = await service.issue({ wave });
  service.revoke(next.executionGrantId);
  assert.equal((await service.validate({ wave, executionGrantId: next.executionGrantId })).kind, "authorization-required");
});

test("missing executor/approval capability and incomplete certification fail before issuing any grant", async (t) => {
  assert.equal((await authority(t, { evaluate: null }).issue({ wave: executorWave() })).reason, "executor-unavailable");
  for (const mutate of [
    (p) => { p.state.operations = ["observe"]; },
    (p) => { p.state.interaction = "preauthorized-unattended"; },
    (p) => { p.state.allow = false; },
  ]) {
    const p = executorProviders(); mutate(p);
    assert.notEqual((await authority(t, p).issue({ wave: executorWave() })).kind, "execution-granted");
  }
  const p = executorProviders();
  const evaluate = async (scope) => {
    const result = await p.evaluate(scope); result.context.certificationId = null; return result;
  };
  assert.notEqual((await authority(t, { ...p, evaluate }).issue({ wave: executorWave() })).kind, "execution-granted");
});

test("a config change while authorization is pending cannot mint a stale grant", async (t) => {
  const p = executorProviders();
  const authorize = async (...args) => {
    const result = await p.authorize(...args); p.state.config = "2".repeat(64); return result;
  };
  assert.equal((await authority(t, { ...p, authorize }).issue({ wave: executorWave() })).reason, "stale-execution-context");
});

test("provider deadlines and shutdown stop late issuance without exposing provider errors", async (t) => {
  let release;
  const p = executorProviders();
  const service = authority(t, { ...p, timeoutMs: 10, authorize: (...args) =>
    new Promise((resolve) => { release = async () => resolve(await p.authorize(...args)); }) });
  assert.equal((await service.issue({ wave: executorWave() })).reason, "authority-unavailable");
  await release();
  service.close();
  assert.equal((await service.issue({ wave: executorWave() })).reason, "authority-closed");
  const broken = authority(t, { evaluate: () => { throw new Error("private credential"); } });
  assert.doesNotMatch(JSON.stringify(await broken.issue({ wave: executorWave() })), /private credential/);
});

test("grant capacity is rechecked after concurrent authorizations", async (t) => {
  const service = authority(t, { maximumGrants: 1 });
  const results = await Promise.all([service.issue({ wave: executorWave() }), service.issue({ wave: executorWave() })]);
  assert.equal(results.filter(({ kind }) => kind === "execution-granted").length, 1);
  assert.equal(results.filter(({ reason }) => reason === "grant-capacity").length, 1);
});

test("temporary admission failures deny the call without destroying a valid grant", async (t) => {
  const providers = executorProviders();
  let mode = "ready";
  const releases = [];
  const service = authority(t, { ...providers, evaluate: async (...args) => {
    if (mode === "busy") await new Promise((resolve) => releases.push(resolve));
    if (mode === "broken") throw new Error("temporary probe failure");
    return providers.evaluate(...args);
  } });
  const wave = executorWave();
  const { executionGrantId } = await service.issue({ wave });
  mode = "busy";
  const pending = Array.from({ length: 16 }, () => service.validate({ wave, executionGrantId }));
  await tick();
  assert.equal(releases.length, 16);
  assert.equal((await service.validate({ wave, executionGrantId })).reason, "authority-busy");
  mode = "ready";
  releases.forEach((release) => release());
  assert.ok((await Promise.all(pending)).every(({ kind }) => kind === "execution-admitted"));
  mode = "broken";
  assert.equal((await service.validate({ wave, executionGrantId })).reason, "authority-unavailable");
  mode = "ready";
  assert.equal((await service.validate({ wave, executionGrantId })).kind, "execution-admitted");
  providers.state.config = "9".repeat(64);
  assert.equal((await service.validate({ wave, executionGrantId })).reason, "stale-execution-grant");
  assert.equal((await service.validate({ wave, executionGrantId })).reason, "unknown-execution-grant");
});

test("canonical scope ignores member/key ordering and preserves foreign paths verbatim", () => {
  const wave = executorWave();
  wave.members[0].target.cwd = "C:\\remote\\project";
  wave.members.push({ ...wave.members[0], sliceId: "another", workUnitId: "another-unit" });
  const normalized = normalizeExecutorWaveV1(wave);
  wave.members.reverse();
  assert.deepEqual(normalizeExecutorWaveV1(wave), normalized);
  assert.equal(normalized.members[0].target.cwd, "C:\\remote\\project");
  assert.throws(() => normalizeExecutorWaveV1({ ...wave, capabilities: { launcherAvailable: true } }), /invalid-contract/);
});
