import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ContractError,
  canonicalize,
  canonicalizeTask,
  deriveTaskDigest,
  deriveTaskIdentity,
  parseCanonicalTask,
  reviseTask,
  sealRecord,
  sealTask,
  transitionTask,
  validateTask,
  verifyTaskIdentity,
  verifyTaskRevision,
} from "../src/experimentation-contract/index.mjs";

const FIXTURE_ROOT = new URL("./fixtures/experimentation-contract/", import.meta.url);
const D = (character) => `sha256:${character.repeat(64)}`;

function taskDraft() {
  const value = {
    schemaVersion: 1,
    taskId: `task:${"0".repeat(64)}`,
    specRevision: 1,
    previousDigest: null,
    digest: D("0"),
    state: "draft",
    prompt: {
      kind: "objective",
      encoding: "utf-8",
      text: "Return the canonical result bytes.",
      digest: "sha256:98b0227df6627f83cd9f3a644a91bd58999c173e9e7700c19dec4b8747e0f07b",
    },
    fixture: { format: "json", version: "1.0.0", digest: D("1") },
    baseline: { format: "json", digest: D("2") },
    inputs: [
      { id: "request", kind: "json", digest: D("3"), canonicalization: "canonical-json-v1", required: true },
    ],
    determinism: { seed: 42, clock: "2026-07-31T12:00:00Z", timezone: "UTC", locale: "en-US" },
    permissions: { filesystem: "read-only", subprocess: false, systemClock: false },
    tools: [{ id: "node", version: "22.0.0", digest: D("4") }],
    network: { mode: "none", allowHosts: [] },
    environment: [{ name: "LANG", value: "en_US.UTF-8" }],
    limits: {
      wallClockSeconds: 300,
      tokenBudget: 100000,
      toolCalls: 1000,
      diskBytes: 1073741824,
      processes: 4,
      networkRequests: 0,
    },
    outputs: [{ id: "result", kind: "json", required: true, maxBytes: 1048576, shapeDigest: D("5") }],
    artifacts: [{ id: "trace", mediaType: "application/json", required: false, maxBytes: 1048576, shapeDigest: D("9") }],
    grader: {
      id: "exact-grader",
      version: "1.2.0",
      digest: D("6"),
      rubricDigest: D("7"),
      inputVisibility: "hidden",
      oracle: { kind: "exact", version: "1.0.0", digest: D("8") },
    },
    visibility: "private",
    partialCredit: {
      mode: "weighted",
      criteria: [
        { id: "correctness", weightBasisPoints: 8000 },
        { id: "format", weightBasisPoints: 2000 },
      ],
    },
  };
  value.taskId = deriveTaskIdentity(value);
  value.digest = deriveTaskDigest(value);
  return value;
}

function mutable(value) {
  return structuredClone(value);
}

function expectError(action, code, path, schemaVersion = 1) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof ContractError);
    assert.equal(error.code, code);
    assert.equal(error.path, path);
    assert.equal(error.contractKind, "Task");
    assert.equal(error.schemaVersion, schemaVersion);
    return true;
  });
}

test("golden Task and semantic revision are exact canonical fixtures", async () => {
  const goldenBytes = await readFile(new URL("task-v1.json", FIXTURE_ROOT));
  const revisionBytes = await readFile(new URL("task-v1-revision.json", FIXTURE_ROOT));
  const golden = parseCanonicalTask(goldenBytes);
  const revision = parseCanonicalTask(revisionBytes);

  assert.equal(canonicalizeTask(golden), goldenBytes.toString("utf8"));
  assert.equal(canonicalizeTask(revision), revisionBytes.toString("utf8"));
  assert.equal(verifyTaskIdentity(golden), golden);
  assert.equal(deriveTaskIdentity(golden), golden.taskId);
  assert.equal(canonicalize(verifyTaskRevision(sealRecord(golden), sealRecord(revision))), canonicalize(revision));
  assert.equal(canonicalize(sealTask(taskDraft())), canonicalize(golden));
  assert.equal(canonicalize(reviseTask(sealRecord(golden), { visibility: "team" })), canonicalize(revision));
});

test("Task lifecycle permits only the explicit closed graph", () => {
  const at = (state) => {
    const value = { ...mutable(taskDraft()), state };
    value.digest = deriveTaskDigest(value);
    return sealTask(value);
  };
  for (const [from, to] of [
    ["draft", "reviewed"], ["draft", "invalidated"], ["reviewed", "sealed"],
    ["reviewed", "invalidated"], ["sealed", "retired"], ["sealed", "invalidated"],
  ]) {
    const original = at(from);
    const transitioned = transitionTask(original, to);
    assert.equal(transitioned.state, to);
    assert.equal(transitioned.taskId, original.taskId);
    assert.notEqual(transitioned.digest, original.digest);
  }
  expectError(() => transitionTask(at("draft"), "sealed"), "UNAUTHORIZED_TRANSITION", "/state");
  expectError(() => transitionTask(at("retired"), "reviewed"), "TERMINAL_TRANSITION", "/state");
});

test("invalid fixture matrix returns exact structured codes and JSON pointers", async () => {
  const cases = JSON.parse(await readFile(new URL("invalid-task-cases.json", FIXTURE_ROOT), "utf8"));
  const valid = sealTask(taskDraft());
  const mutators = {
    unknownNested(task) { task.grader.oracle.extra = true; },
    missingRequired(task) { delete task.limits.tokenBudget; },
    invalidEnum(task) { task.network.mode = "open"; },
    duplicateTool(task) { task.tools.push(structuredClone(task.tools[0])); },
    duplicateOutput(task) { task.outputs.push(structuredClone(task.outputs[0])); },
    duplicateArtifact(task) { task.artifacts.push(structuredClone(task.artifacts[0])); },
    duplicatePartialCredit(task) { task.partialCredit.criteria[1].id = "correctness"; },
    bound(task) { task.limits.wallClockSeconds = 0; },
    malformedDigest(task) { task.fixture.digest = "sha256:ABC"; },
    secretEnvironmentName(task) { task.environment[0] = { name: "API_TOKEN", value: "redacted" }; },
    secretEnvironmentValue(task) { task.environment[0].value = "ghp_abcdefghijklmnopqrstuvwxyz123456"; },
    digestMismatch(task) { task.prompt.text = "changed bytes"; },
  };
  for (const fixture of cases) {
    const candidate = mutable(valid);
    mutators[fixture.mutation](candidate);
    expectError(() => validateTask(candidate), fixture.code, fixture.path);
  }
});

test("unsupported versions and non-canonical input fail before admission", () => {
  const valid = mutable(sealTask(taskDraft()));
  valid.schemaVersion = 2;
  expectError(() => validateTask(valid), "UNSUPPORTED_SCHEMA_VERSION", "/schemaVersion", 2);

  const canonical = canonicalizeTask(sealTask(taskDraft()));
  const nonCanonical = canonical.replace('{"artifacts"', '{ "artifacts"');
  expectError(() => parseCanonicalTask(Buffer.from(nonCanonical)), "NON_CANONICAL_JSON", "");
});

test("revisions reject unchanged semantics, invalid lineage, and record digest mismatch", () => {
  const base = sealTask(taskDraft());
  expectError(() => reviseTask(base, {}), "REVISION_WITHOUT_SEMANTIC_CHANGE", "");

  const revision = reviseTask(base, { visibility: "team" });
  const badLineageValue = { ...mutable(revision), previousDigest: D("f") };
  badLineageValue.digest = deriveTaskDigest(badLineageValue);
  const badLineage = sealTask(badLineageValue);
  expectError(() => verifyTaskRevision(base, badLineage), "INVALID_LINEAGE", "/previousDigest");

  const badDigest = mutable(base);
  badDigest.digest = D("e");
  expectError(() => validateTask(badDigest), "REVISION_DIGEST_MISMATCH", "/digest");

  const badIdentity = mutable(base);
  badIdentity.taskId = `task:${"f".repeat(64)}`;
  badIdentity.digest = deriveTaskDigest(badIdentity);
  expectError(() => verifyTaskIdentity(badIdentity), "INVALID_DIGEST", "/taskId");
});

test("identity projection binds every semantic category but excludes lifecycle metadata", () => {
  const base = sealTask(taskDraft());
  const mutations = {
    prompt(task) { task.prompt.text += "!"; task.prompt.digest = "sha256:cdae3af4d4988944a4e75c5d5d15faebcb010875446c80a580ca544ddfdc6521"; },
    fixture(task) { task.fixture.digest = D("a"); },
    baseline(task) { task.baseline.digest = D("a"); },
    inputs(task) { task.inputs[0].digest = D("a"); },
    determinism(task) { task.determinism.seed += 1; },
    permissions(task) { task.permissions.subprocess = true; },
    tools(task) { task.tools[0].digest = D("a"); },
    network(task) { task.network = { mode: "allowlist", allowHosts: ["example.com"] }; },
    environment(task) { task.environment[0].value = "C.UTF-8"; },
    limits(task) { task.limits.tokenBudget += 1; },
    outputs(task) { task.outputs[0].maxBytes += 1; },
    artifacts(task) { task.artifacts[0].maxBytes += 1; },
    grader(task) { task.grader.rubricDigest = D("a"); },
    visibility(task) { task.visibility = "team"; },
    partialCredit(task) { task.partialCredit.criteria[0].weightBasisPoints = 7000; task.partialCredit.criteria[1].weightBasisPoints = 3000; },
  };
  for (const [field, mutate] of Object.entries(mutations)) {
    const changed = mutable(base);
    mutate(changed);
    assert.notEqual(deriveTaskIdentity(changed), base.taskId, field);
  }
  const lifecycleOnly = mutable(base);
  lifecycleOnly.state = "reviewed";
  lifecycleOnly.specRevision = 99;
  lifecycleOnly.previousDigest = D("a");
  lifecycleOnly.digest = D("b");
  assert.equal(deriveTaskIdentity(lifecycleOnly), base.taskId);
});
