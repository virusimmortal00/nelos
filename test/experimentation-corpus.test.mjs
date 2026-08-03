import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalBytes, reviseTask, sha256Bytes } from "../src/experimentation-contract/index.mjs";
import {
  graderBundleForImplementationManifest,
} from "../src/experimentation-corpus/grader.mjs";
import {
  graderImplementationDigest,
  graderImplementationManifest,
} from "../src/experimentation-corpus/grader-identity.mjs";
import {
  CorpusError,
  STARTER_TASK_FAMILIES,
  candidateTaskEnvelope,
  canonicalGradeBytes,
  createStarterDevelopmentRelease,
  createTaskPackage,
  gradeTaskAttempt,
  reviseCorpusFromPackages,
  validateEvaluationPartitions,
  validateTaskPackage,
  starterGraderBundle,
} from "../src/experimentation-corpus/index.mjs";

const attestation = {
  issuer: "nelos-host-runtime",
  candidateEnvironmentId: "candidate:fixture",
  graderEnvironmentId: "grader:fixture",
};

function submission(value, selfReport = { strictPass: true, scoreBasisPoints: 10000 }) {
  const bytes = Buffer.isBuffer(value) ? value : canonicalBytes(value);
  return { outputs: [{ id: "result", encoding: "base64", bytes: bytes.toString("base64") }], selfReport };
}

function replaceOracle(taskPackage, oracle) {
  const bytes = canonicalBytes(oracle);
  const digest = sha256Bytes(bytes);
  const assets = taskPackage.assets.map((asset) => ({
    ...asset,
    bytes: asset.assetId.endsWith(":oracle") ? bytes : Buffer.from(asset.bytes, "base64"),
  }));
  const task = reviseTask(taskPackage.task, {
    grader: { ...taskPackage.task.grader, oracle: { ...taskPackage.task.grader.oracle, digest } },
  });
  return createTaskPackage({ task, assets, graderBundle: taskPackage.graderBundle });
}

function replaceOracleBytes(taskPackage, bytes) {
  const digest = sha256Bytes(bytes);
  const assets = taskPackage.assets.map((asset) => ({
    ...asset,
    bytes: asset.assetId.endsWith(":oracle")
      ? bytes
      : Buffer.from(asset.bytes, "base64"),
  }));
  const task = reviseTask(taskPackage.task, {
    grader: {
      ...taskPackage.task.grader,
      oracle: { ...taskPackage.task.grader.oracle, digest },
    },
  });
  return createTaskPackage({ task, assets, graderBundle: taskPackage.graderBundle });
}

test("starter release is reproducible and covers every required task family", async () => {
  const first = createStarterDevelopmentRelease();
  const second = createStarterDevelopmentRelease();
  assert.deepEqual(first, second);
  assert.equal(first.release.state, "published");
  assert.equal(first.packages.length, 10);
  assert.deepEqual(
    first.release.strata.categories.map((entry) => entry.id).sort(),
    STARTER_TASK_FAMILIES.map((entry) => entry.id).sort(),
  );
  const lock = JSON.parse(await readFile(new URL("../corpus/starter/release-lock.json", import.meta.url), "utf8"));
  assert.equal(first.release.releaseId, lock.releaseId);
  assert.equal(first.release.digest, lock.digest);
  assert.deepEqual(first.packages.map((entry) => entry.digest).sort(), lock.packageDigests);
  const manifest = graderImplementationManifest();
  assert.equal(starterGraderBundle().implementationDigest, graderImplementationDigest(manifest));
  assert.deepEqual(manifest.files.map(({ path }) => path), [...manifest.files.map(({ path }) => path)].sort());
  for (const required of [
    "src/experimentation-corpus/grader.mjs",
    "src/experimentation-corpus/package.mjs",
    "src/experimentation-corpus/errors.mjs",
    "src/experimentation-contract/canonical-json.mjs",
    "src/experimentation-contract/identity.mjs",
    "src/experimentation-contract/revision.mjs",
  ]) {
    const member = manifest.files.find(({ path }) => path === required);
    assert.ok(member, required);
    assert.equal(
      member.digest,
      sha256Bytes(await readFile(new URL(`../${required}`, import.meta.url))),
      required,
    );
  }
});

test("transitive grader dependency changes rotate every dependent identity and old packages fail closed", () => {
  const starter = createStarterDevelopmentRelease();
  const original = starter.packages[0];
  const manifest = structuredClone(graderImplementationManifest());
  const dependency = manifest.files.find(({ path }) => path === "src/experimentation-contract/canonical-json.mjs");
  dependency.digest = sha256Bytes(Buffer.from("changed canonicalization dependency", "utf8"));
  const changedBundle = graderBundleForImplementationManifest(manifest);

  assert.notEqual(changedBundle.implementationDigest, original.graderBundle.implementationDigest);
  assert.notEqual(changedBundle.digest, original.graderBundle.digest);
  const revisedTask = reviseTask(original.task, {
    grader: { ...original.task.grader, digest: changedBundle.digest },
  });
  const revisedPackage = createTaskPackage({
    task: revisedTask,
    assets: original.assets.map((asset) => ({ ...asset, bytes: Buffer.from(asset.bytes, "base64") })),
    graderBundle: changedBundle,
  });
  assert.notEqual(revisedTask.taskId, original.task.taskId);
  assert.notEqual(revisedTask.digest, original.task.digest);
  assert.notEqual(revisedPackage.packageId, original.packageId);
  assert.notEqual(revisedPackage.digest, original.digest);
  assert.throws(
    () => gradeTaskAttempt({
      taskPackage: revisedPackage,
      submission: submission({}),
      observation: { attemptId: "attempt:changed-grader", termination: "exited", exitCode: 0, contaminated: false },
      attestation,
    }),
    (error) => error instanceof CorpusError && error.code === "GRADER_IDENTITY_MISMATCH",
  );

  const strataByTask = new Map(starter.release.tasks.map((entry) => [entry.taskId, entry.strata]));
  const revisedRelease = reviseCorpusFromPackages(starter.release, {
    version: "1.1.0",
    createdAt: "2026-08-02T00:00:00Z",
    summary: "Rotate the transitive grader implementation identity.",
    members: starter.packages.map((taskPackage) => ({
      taskPackage: taskPackage === original ? revisedPackage : taskPackage,
      strata: strataByTask.get(taskPackage.task.taskId),
    })),
  });
  assert.notEqual(revisedRelease.releaseId, starter.release.releaseId);
  assert.notEqual(revisedRelease.digest, starter.release.digest);
});

test("grader implementation identity is independent of manifest property order", () => {
  const manifest = graderImplementationManifest();
  const reordered = {
    files: manifest.files.map(({ path, digest }) => ({ digest, path })),
    schemaVersion: manifest.schemaVersion,
  };
  assert.equal(
    graderImplementationDigest(reordered),
    graderImplementationDigest(manifest),
  );
});

test("task packages bind all candidate and hidden assets and expose no oracle bytes", () => {
  const { packages } = createStarterDevelopmentRelease();
  const taskPackage = packages[0];
  assert.equal(validateTaskPackage(taskPackage), taskPackage);
  assert.ok(Object.isFrozen(taskPackage));
  const envelope = candidateTaskEnvelope(taskPackage);
  assert.ok(envelope.assets.every((asset) => asset.audience === "candidate"));
  assert.ok(!envelope.assets.some((asset) => asset.digest === taskPackage.task.grader.oracle.digest));

  const changed = structuredClone(taskPackage);
  changed.task.limits.wallClockSeconds += 1;
  assert.throws(() => validateTaskPackage(changed), (error) => error.code === "INVALID_DIGEST");

  const oracle = taskPackage.assets.find((asset) => asset.digest === taskPackage.task.grader.oracle.digest);
  assert.throws(
    () => createTaskPackage({
      task: taskPackage.task,
      graderBundle: taskPackage.graderBundle,
      assets: [
        ...taskPackage.assets.map((asset) => ({ ...asset, bytes: Buffer.from(asset.bytes, "base64") })),
        {
          assetId: "asset:leaked-oracle",
          mediaType: oracle.mediaType,
          audience: "candidate",
          bytes: Buffer.from(oracle.bytes, "base64"),
        },
      ],
    }),
    (error) => error instanceof CorpusError && error.code === "HIDDEN_ASSET_EXPOSED" && error.path.endsWith("/audience"),
  );
});

test("every semantic task change creates a new immutable task and package identity", () => {
  const starter = createStarterDevelopmentRelease();
  const original = starter.packages[0];
  const revisedTask = reviseTask(original.task, { permissions: { ...original.task.permissions, subprocess: false } });
  const revised = createTaskPackage({
    task: revisedTask,
    assets: original.assets.map((asset) => ({ ...asset, bytes: Buffer.from(asset.bytes, "base64") })),
    graderBundle: original.graderBundle,
  });
  assert.equal(revised.task.specRevision, original.task.specRevision + 1);
  assert.equal(revised.task.previousDigest, original.task.digest);
  assert.notEqual(revised.task.taskId, original.task.taskId);
  assert.notEqual(revised.packageId, original.packageId);
  assert.notEqual(revised.digest, original.digest);

  const strataByTask = new Map(starter.release.tasks.map((entry) => [entry.taskId, entry.strata]));
  const successor = reviseCorpusFromPackages(starter.release, {
    version: "1.1.0",
    createdAt: "2026-08-02T00:00:00Z",
    summary: "Revise one task permission contract.",
    members: starter.packages.map((taskPackage) => ({
      taskPackage: taskPackage === original ? revised : taskPackage,
      strata: strataByTask.get(taskPackage.task.taskId),
    })),
  });
  assert.equal(successor.revision, starter.release.revision + 1);
  assert.equal(successor.previousDigest, starter.release.digest);
  assert.notEqual(successor.releaseId, starter.release.releaseId);
  assert.ok(successor.retainedExclusions.some((entry) => entry.taskId === original.task.taskId));
});

test("task package asset identity uses locale-independent code-unit ordering", () => {
  const original = createStarterDevelopmentRelease().packages[0];
  const extraAssets = [
    {
      assetId: "asset:a-b",
      mediaType: "text/plain",
      audience: "candidate",
      bytes: Buffer.from("hyphen", "utf8"),
    },
    {
      assetId: "asset:a.b",
      mediaType: "text/plain",
      audience: "candidate",
      bytes: Buffer.from("period", "utf8"),
    },
  ];
  const taskPackage = createTaskPackage({
    task: original.task,
    graderBundle: original.graderBundle,
    assets: [
      ...original.assets.map((asset) => ({
        ...asset,
        bytes: Buffer.from(asset.bytes, "base64"),
      })),
      ...extraAssets,
    ],
  });
  const assetIds = taskPackage.assets.map(({ assetId }) => assetId);
  assert.deepEqual(assetIds, [...assetIds].sort());
});

test("task contract requires exactly one required output", () => {
  const original = createStarterDevelopmentRelease().packages[0].task;
  assert.throws(
    () => reviseTask(original, {
      outputs: original.outputs.map((output) => ({ ...output, required: false })),
    }),
    (error) => error.code === "INVALID_FORMAT" && error.path === "/outputs",
  );
  assert.throws(
    () => reviseTask(original, {
      outputs: [
        ...original.outputs,
        { ...original.outputs[0], id: "second", required: true },
      ],
    }),
    (error) => error.code === "INVALID_FORMAT" && error.path === "/outputs",
  );
});

test("golden machine outcomes are deterministic and ignore worker self-report", async () => {
  const fixtures = JSON.parse(await readFile(new URL("./fixtures/experimentation-corpus/golden-outcomes.json", import.meta.url), "utf8"));
  const base = createStarterDevelopmentRelease().packages.find((entry) => entry.task.prompt.text.includes("Localized defect repair"));
  const family = "localized-repair";
  for (const fixture of fixtures) {
    const taskPackage = fixture.name === "grader-failure" ? replaceOracle(base, { forceGraderFailure: true }) : base;
    const values = {
      exact: { answer: `${family}:verified`, family },
      partial: { answer: `${family}:verified`, family: "wrong" },
      malformed: Buffer.from("{not-json", "utf8"),
    };
    const observed = {
      attemptId: `attempt:${fixture.name}`,
      termination: fixture.termination,
      exitCode: fixture.exitCode,
      contaminated: fixture.contaminated,
    };
    const input = submission(values[fixture.submission], { outcome: "success", scoreBasisPoints: 10000 });
    const grade = gradeTaskAttempt({ taskPackage, submission: input, observation: observed, attestation });
    const replay = gradeTaskAttempt({ taskPackage, submission: { ...input, selfReport: { outcome: "failure" } }, observation: observed, attestation });
    assert.equal(grade.outcome, fixture.outcome, fixture.name);
    assert.equal(grade.strictPass, fixture.strictPass, fixture.name);
    assert.equal(grade.scoreBasisPoints, fixture.scoreBasisPoints, fixture.name);
    assert.deepEqual(canonicalGradeBytes(grade), canonicalGradeBytes(replay), fixture.name);
  }
});

test("invalid hidden oracle JSON is a grader failure, not a candidate malformed result", () => {
  const original = createStarterDevelopmentRelease().packages[0];
  const taskPackage = replaceOracleBytes(
    original,
    Buffer.from("{invalid-oracle", "utf8"),
  );
  const grade = gradeTaskAttempt({
    taskPackage,
    submission: submission({ answer: "candidate-json-is-valid" }),
    observation: {
      attemptId: "attempt:invalid-oracle",
      termination: "exited",
      exitCode: 0,
      contaminated: false,
    },
    attestation,
  });
  assert.equal(grade.outcome, "grader-failure");
});

test("graders fail closed unless host and candidate environments are distinct", () => {
  const taskPackage = createStarterDevelopmentRelease().packages[0];
  assert.throws(
    () => gradeTaskAttempt({
      taskPackage,
      submission: submission({}),
      observation: { attemptId: "attempt:unsafe", termination: "exited", exitCode: 0, contaminated: false },
      attestation: { ...attestation, graderEnvironmentId: attestation.candidateEnvironmentId },
    }),
    (error) => error instanceof CorpusError && error.code === "UNSAFE_GRADER_BOUNDARY",
  );
});

test("private evaluation access, similarity, and predeclared exclusions are enforced", () => {
  const development = createStarterDevelopmentRelease().packages[0];
  const privateTask = reviseTask(development.task, { visibility: "private" });
  const privatePackage = createTaskPackage({
    task: privateTask,
    assets: development.assets.map((asset) => ({ ...asset, bytes: Buffer.from(asset.bytes, "base64") })),
    graderBundle: development.graderBundle,
  });
  const controls = {
    developmentPackages: [development],
    privatePackages: [privatePackage],
    frozenAt: "2026-08-02T00:00:00Z",
    accessLog: [{ actor: "evaluator:one", role: "evaluator", at: "2026-08-02T01:00:00Z", taskId: privateTask.taskId, action: "grade" }],
    exclusions: [{ taskId: privateTask.taskId, reasonCode: "contamination", declaredAt: "2026-08-01T00:00:00Z", reason: "near duplicate of development task" }],
  };
  const report = validateEvaluationPartitions(controls);
  assert.equal(report.similarity.length, 1);
  assert.ok(Object.isFrozen(report));
  assert.throws(
    () => validateEvaluationPartitions({
      ...controls,
      accessLog: [{ actor: "author:one", role: "author", at: "2026-08-01T00:00:00Z", taskId: privateTask.taskId, action: "read" }],
    }),
    (error) => error instanceof CorpusError && error.code === "PRIVATE_ACCESS_VIOLATION",
  );
  assert.throws(
    () => validateEvaluationPartitions({ ...controls, exclusions: [] }),
    (error) => error instanceof CorpusError && error.code === "SIMILARITY_EXCLUSION_REQUIRED",
  );
  assert.throws(
    () => validateEvaluationPartitions({ ...controls, nearThreshold: Number.NaN }),
    (error) => error instanceof CorpusError && error.code === "INVALID_SIMILARITY_THRESHOLD",
  );
  assert.throws(
    () => validateEvaluationPartitions({
      ...controls,
      accessLog: [{ ...controls.accessLog[0], at: "not-a-time" }],
    }),
    (error) => error instanceof CorpusError && error.code === "INVALID_ACCESS_LOG" && error.path.endsWith("/at"),
  );
  assert.throws(
    () => validateEvaluationPartitions({
      ...controls,
      exclusions: [{ ...controls.exclusions[0], declaredAt: "not-a-time" }],
    }),
    (error) => error instanceof CorpusError && error.code === "INVALID_EXCLUSION" && error.path.endsWith("/declaredAt"),
  );
  assert.throws(
    () => validateEvaluationPartitions({ ...controls, exclusions: [null] }),
    (error) => error instanceof CorpusError && error.code === "INVALID_EXCLUSION",
  );
});
