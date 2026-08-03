import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  canonicalBytes,
  deriveTaskDigest,
  deriveTaskIdentity,
  reviseTask,
  sealTask,
  sha256Bytes,
  transitionTask,
} from "../src/experimentation-contract/index.mjs";
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
  analyzeCorpusDuplicates,
  candidateTaskEnvelope,
  canonicalGradeBytes,
  createStarterDevelopmentRelease,
  createTaskPackage,
  deriveTaskPackageDigest,
  deriveTaskPackageId,
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

function independentTask(task, text) {
  const candidate = structuredClone(task);
  candidate.prompt = {
    ...candidate.prompt,
    text,
    digest: sha256Bytes(Buffer.from(text, "utf8")),
  };
  candidate.specRevision = 1;
  candidate.previousDigest = null;
  candidate.taskId = deriveTaskIdentity(candidate);
  candidate.digest = deriveTaskDigest(candidate);
  return sealTask(candidate);
}

function taskPackageRecord(taskPackage, task) {
  const candidate = { ...structuredClone(taskPackage), task };
  candidate.packageId = deriveTaskPackageId(candidate);
  candidate.digest = deriveTaskPackageDigest(candidate);
  return candidate;
}

function resealedTask(task, changes) {
  const candidate = { ...structuredClone(task), ...structuredClone(changes) };
  candidate.taskId = deriveTaskIdentity(candidate);
  candidate.digest = deriveTaskDigest(candidate);
  return sealTask(candidate);
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
  assert.throws(
    () => reviseCorpusFromPackages(starter.release, {
      version: "1.1.0",
      createdAt: "2026-08-02T00:00:00Z",
      summary: "Attempt a partial grader implementation rotation.",
      members: starter.packages.map((taskPackage) => ({
        taskPackage: taskPackage === original ? revisedPackage : taskPackage,
        strata: strataByTask.get(taskPackage.task.taskId),
      })),
    }),
    (error) => error instanceof CorpusError && error.code === "GRADER_IDENTITY_COLLISION",
  );
  const rotatedPackages = starter.packages.map((taskPackage) => {
    if (taskPackage === original) return revisedPackage;
    const task = reviseTask(taskPackage.task, {
      grader: { ...taskPackage.task.grader, digest: changedBundle.digest },
    });
    return createTaskPackage({
      task,
      assets: taskPackage.assets.map((asset) => ({
        ...asset,
        bytes: Buffer.from(asset.bytes, "base64"),
      })),
      graderBundle: changedBundle,
    });
  });
  const revisedRelease = reviseCorpusFromPackages(starter.release, {
    version: "1.1.0",
    createdAt: "2026-08-02T00:00:00Z",
    summary: "Rotate the transitive grader implementation identity.",
    members: rotatedPackages.map((taskPackage, index) => ({
      taskPackage,
      strata: strataByTask.get(starter.packages[index].task.taskId),
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

  const fixtureId = taskPackage.task.fixture.digest;
  assert.throws(
    () => createTaskPackage({
      task: taskPackage.task,
      graderBundle: taskPackage.graderBundle,
      assets: taskPackage.assets.map((asset) => ({
        ...asset,
        audience: asset.digest === fixtureId ? "grader" : asset.audience,
        bytes: Buffer.from(asset.bytes, "base64"),
      })),
    }),
    (error) => error instanceof CorpusError && error.code === "MISSING_ASSET" && error.path === "/task/fixture/digest",
  );
});

test("package and grading admission reject every non-sealed task lifecycle", () => {
  const original = createStarterDevelopmentRelease().packages[0];
  const draft = resealedTask(original.task, { state: "draft" });
  const rejected = [
    draft,
    transitionTask(original.task, "retired"),
    transitionTask(original.task, "invalidated"),
  ];
  for (const task of rejected) {
    const taskPackage = taskPackageRecord(original, task);
    assert.throws(
      () => validateTaskPackage(taskPackage),
      (error) => error instanceof CorpusError &&
        error.code === "TASK_NOT_SEALED" &&
        error.path === "/task/state",
      task.state,
    );
  }
  assert.throws(
    () => gradeTaskAttempt({
      taskPackage: taskPackageRecord(original, rejected.at(-1)),
      submission: submission({}),
      observation: {
        attemptId: "attempt:invalidated-task",
        termination: "exited",
        exitCode: 0,
        contaminated: false,
      },
      attestation,
    }),
    (error) => error instanceof CorpusError && error.code === "TASK_NOT_SEALED",
  );
});

test("exact JSON grader packages reject incompatible oracle and output contracts", () => {
  const original = createStarterDevelopmentRelease().packages[0];
  const assets = original.assets.map((asset) => ({
    ...asset,
    bytes: Buffer.from(asset.bytes, "base64"),
  }));
  for (const task of [
    reviseTask(original.task, {
      grader: {
        ...original.task.grader,
        oracle: { ...original.task.grader.oracle, kind: "human" },
      },
    }),
    reviseTask(original.task, {
      outputs: original.task.outputs.map((output) => ({
        ...output,
        kind: output.required ? "text" : output.kind,
      })),
    }),
    reviseTask(original.task, {
      artifacts: original.task.artifacts.map((artifact, index) => ({
        ...artifact,
        required: index === 0,
      })),
    }),
  ]) {
    assert.throws(
      () => createTaskPackage({ task, assets, graderBundle: original.graderBundle }),
      (error) => error instanceof CorpusError && error.code === "GRADER_CONTRACT_MISMATCH",
    );
  }
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

test("corpus revision rejects task revision jumps and unmatched predecessors", () => {
  const starter = createStarterDevelopmentRelease();
  const original = starter.packages[0];
  const revision = reviseTask(original.task, {
    permissions: { ...original.task.permissions, subprocess: false },
  });
  const strataByTask = new Map(
    starter.release.tasks.map((entry) => [entry.taskId, entry.strata]),
  );
  const reviseWith = (taskPackage) => reviseCorpusFromPackages(starter.release, {
    version: "1.1.0",
    createdAt: "2026-08-02T00:00:00Z",
    summary: "Attempt an invalid task revision.",
    members: starter.packages.map((candidate) => ({
      taskPackage: candidate === original ? taskPackage : candidate,
      strata: strataByTask.get(candidate.task.taskId),
    })),
  });
  const jumpedTask = resealedTask(revision, { specRevision: 3 });
  const jumpedPackage = createTaskPackage({
    task: jumpedTask,
    assets: original.assets.map((asset) => ({
      ...asset,
      bytes: Buffer.from(asset.bytes, "base64"),
    })),
    graderBundle: original.graderBundle,
  });
  assert.throws(
    () => reviseWith(jumpedPackage),
    (error) => error instanceof CorpusError &&
      error.code === "INVALID_TASK_REVISION" &&
      error.path.endsWith("/specRevision"),
  );

  const unmatchedTask = resealedTask(revision, {
    previousDigest: `sha256:${"f".repeat(64)}`,
  });
  const unmatchedPackage = createTaskPackage({
    task: unmatchedTask,
    assets: original.assets.map((asset) => ({
      ...asset,
      bytes: Buffer.from(asset.bytes, "base64"),
    })),
    graderBundle: original.graderBundle,
  });
  assert.throws(
    () => reviseWith(unmatchedPackage),
    (error) => error instanceof CorpusError &&
      error.code === "INVALID_TASK_LINEAGE" &&
      error.path.endsWith("/previousDigest"),
  );
});

test("independent successor tasks are audited as additions, not revisions", () => {
  const starter = createStarterDevelopmentRelease();
  const original = starter.packages[0];
  const task = independentTask(
    original.task,
    `${original.task.prompt.text} Independent addition.`,
  );
  const addedPackage = createTaskPackage({
    task,
    assets: original.assets.map((asset) => ({
      ...asset,
      bytes: Buffer.from(asset.bytes, "base64"),
    })),
    graderBundle: original.graderBundle,
  });
  const strataByTask = new Map(starter.release.tasks.map((entry) => [entry.taskId, entry.strata]));
  const successor = reviseCorpusFromPackages(starter.release, {
    version: "1.1.0",
    createdAt: "2026-08-02T00:00:00Z",
    summary: "Add one independent governed task.",
    members: [
      ...starter.packages.map((taskPackage) => ({
        taskPackage,
        strata: strataByTask.get(taskPackage.task.taskId),
      })),
      { taskPackage: addedPackage, strata: strataByTask.get(original.task.taskId) },
    ],
  });
  assert.deepEqual(
    successor.changelog.find(({ kind }) => kind === "task-added")?.taskIds,
    [addedPackage.task.taskId],
  );
  assert.equal(
    successor.changelog.some(({ kind, taskIds }) => (
      kind === "task-revised" && taskIds.includes(addedPackage.task.taskId)
    )),
    false,
  );
});

test("successor releases recompute exact and near duplicate analysis deterministically", () => {
  const starter = createStarterDevelopmentRelease();
  const original = starter.packages[0];
  const duplicateTask = resealedTask(original.task, {
    specRevision: 1,
    previousDigest: null,
    determinism: {
      ...original.task.determinism,
      seed: original.task.determinism.seed + 100,
    },
  });
  const duplicatePackage = createTaskPackage({
    task: duplicateTask,
    assets: original.assets.map((asset) => ({
      ...asset,
      bytes: Buffer.from(asset.bytes, "base64"),
    })),
    graderBundle: original.graderBundle,
  });
  const nearTask = independentTask(
    original.task,
    `${original.task.prompt.text} Safely.`,
  );
  const nearPackage = createTaskPackage({
    task: nearTask,
    assets: original.assets.map((asset) => ({
      ...asset,
      bytes: Buffer.from(asset.bytes, "base64"),
    })),
    graderBundle: original.graderBundle,
  });
  const packages = [...starter.packages, duplicatePackage, nearPackage];
  const strataByTask = new Map(
    starter.release.tasks.map((entry) => [entry.taskId, entry.strata]),
  );
  const successor = reviseCorpusFromPackages(starter.release, {
    version: "1.1.0",
    createdAt: "2026-08-02T00:00:00Z",
    summary: "Add a duplicate adversarial fixture.",
    members: packages.map((taskPackage) => ({
      taskPackage,
      strata: strataByTask.get(
        taskPackage === duplicatePackage || taskPackage === nearPackage
          ? original.task.taskId
          : taskPackage.task.taskId,
      ),
    })),
  });
  const exactGroup = successor.duplicateAnalysis.exactGroups.find(
    ({ taskIds }) => taskIds.includes(duplicatePackage.task.taskId),
  );
  assert.deepEqual(
    exactGroup?.taskIds,
    [original.task.taskId, duplicatePackage.task.taskId].sort(),
  );
  const nearGroup = successor.duplicateAnalysis.nearGroups.find(
    ({ taskIds }) => taskIds.includes(nearPackage.task.taskId),
  );
  assert.ok(nearGroup.taskIds.includes(original.task.taskId));
  assert.ok(nearGroup.maximumSimilarity >= 0.8);
  assert.deepEqual(
    successor.duplicateAnalysis,
    analyzeCorpusDuplicates([...packages].reverse(), 0.8),
  );
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

test("candidate-controlled non-canonical JSON is malformed, not a grader failure", () => {
  const taskPackage = createStarterDevelopmentRelease().packages[0];
  for (const [attemptId, bytes] of [
    ["overflow", Buffer.from("1e400", "utf8")],
    ["lone-surrogate", Buffer.from('"\\ud800"', "utf8")],
  ]) {
    const grade = gradeTaskAttempt({
      taskPackage,
      submission: submission(bytes),
      observation: {
        attemptId: `attempt:${attemptId}`,
        termination: "exited",
        exitCode: 0,
        contaminated: false,
      },
      attestation,
    });
    assert.equal(grade.outcome, "malformed", attemptId);
  }
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
  for (const accessLog of [
    [{ ...controls.accessLog[0], taskId: undefined }],
    [{ ...controls.accessLog[0], taskId: "not-a-task" }],
  ]) {
    assert.throws(
      () => validateEvaluationPartitions({ ...controls, accessLog }),
      (error) => error instanceof CorpusError && error.code === "INVALID_ACCESS_LOG",
    );
  }
  const tampered = structuredClone(development);
  tampered.task.prompt.text = "tampered prompt";
  assert.throws(
    () => validateEvaluationPartitions({
      ...controls,
      developmentPackages: [tampered],
    }),
    (error) => error.code === "INVALID_DIGEST",
  );
});
