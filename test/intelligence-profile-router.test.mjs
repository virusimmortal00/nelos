import assert from "node:assert/strict";
import test from "node:test";

import { INTELLIGENCE_PROFILE_CATALOG } from "../src/intelligence-profile-catalog.mjs";
import { routeIntelligenceProfile } from "../src/intelligence-profile-router.mjs";

test("reviewed catalog records evidence and local-policy provenance", () => {
  assert.deepEqual(
    {
      schemaVersion: INTELLIGENCE_PROFILE_CATALOG.schemaVersion,
      catalogVersion: INTELLIGENCE_PROFILE_CATALOG.catalogVersion,
      reviewedAt: INTELLIGENCE_PROFILE_CATALOG.reviewedAt,
      sourceUrl: INTELLIGENCE_PROFILE_CATALOG.sourceUrl,
      policyVersion: INTELLIGENCE_PROFILE_CATALOG.policy.version,
      evidenceKind: INTELLIGENCE_PROFILE_CATALOG.evidence.kind,
      policyKind: INTELLIGENCE_PROFILE_CATALOG.policy.kind,
      hostEvidenceKind: INTELLIGENCE_PROFILE_CATALOG.hostCapabilityEvidence.kind,
    },
    {
      schemaVersion: 1,
      catalogVersion: "openai-2026-07-21",
      reviewedAt: "2026-07-21",
      sourceUrl: "https://developers.openai.com/api/docs/guides/latest-model",
      policyVersion: 3,
      evidenceKind: "verified-openai-docs",
      policyKind: "local-reviewed-policy",
      hostEvidenceKind: "current-codex-desktop-capability",
    },
  );
});

test("task shapes deterministically select reviewed profiles at lowest sufficient effort", async (t) => {
  const scenarios = [
    ["complex/open-ended", "sol", "gpt-5.6-sol", "medium"],
    ["everyday", "terra", "gpt-5.6-terra", "low"],
    ["clear/repeatable", "luna", "gpt-5.6-luna", "low"],
  ];
  for (const [taskShape, profile, requestedModel, requestedEffort] of scenarios) {
    await t.test(taskShape, () => {
      const first = routeIntelligenceProfile({ taskShape, launchSurface: "durable-task" });
      const second = routeIntelligenceProfile({ taskShape, launchSurface: "durable-task" });
      assert.deepEqual(first, second);
      assert.equal(first.profile, profile);
      assert.equal(first.requestedModel, requestedModel);
      assert.equal(first.requestedEffort, requestedEffort);
      assert.equal(first.modelSelection, "recommended");
      assert.equal(first.effortSelection, "recommended");
      assert.deepEqual(first.launch.nativeTask, {
        model: requestedModel,
        thinking: requestedEffort,
      });
      assert.deepEqual(first.launch.standaloneTask, {
        model: requestedModel,
        effort: requestedEffort,
      });
      assert.match(first.rationale, /\.$/);
    });
  }
});

test("joined-subagent routing never selects Luna", () => {
  const recommended = routeIntelligenceProfile({
    taskShape: "clear/repeatable",
    launchSurface: "joined-subagent",
  });
  assert.equal(recommended.profile, "terra");
  assert.equal(recommended.requestedModel, "gpt-5.6-terra");
  assert.equal(recommended.modelSelection, "recommended");
  assert.match(recommended.rationale, /joined-subagent work uses Terra/);

  for (const override of [
    { profileOverride: "luna" },
    { modelOverride: "gpt-5.6-luna" },
  ]) {
    assert.throws(
      () =>
        routeIntelligenceProfile({
          taskShape: "clear/repeatable",
          launchSurface: "joined-subagent",
          ...override,
        }),
      /joined-subagent launches do not support gpt-5\.6-luna/,
    );
  }

  const durable = routeIntelligenceProfile({
    taskShape: "clear/repeatable",
    launchSurface: "durable-task",
  });
  assert.equal(durable.requestedModel, "gpt-5.6-luna");
});

test("explicit validated model and effort overrides win", () => {
  const route = routeIntelligenceProfile({
    taskShape: "complex/open-ended",
    modelOverride: "gpt-5.6-luna",
    effortOverride: "low",
    launchSurface: "durable-task",
  });
  assert.equal(route.profile, "luna");
  assert.equal(route.requestedModel, "gpt-5.6-luna");
  assert.equal(route.requestedEffort, "low");
  assert.equal(route.modelSelection, "override");
  assert.equal(route.effortSelection, "override");
  assert.match(route.rationale, /^Explicit validated model or reasoning/);
});

test("model and reasoning can be selected independently of task-shape routing", () => {
  const modelOnly = routeIntelligenceProfile({ profileOverride: "sol", launchSurface: "durable-task" });
  assert.deepEqual(
    {
      taskShape: modelOnly.taskShape,
      profile: modelOnly.profile,
      requestedModel: modelOnly.requestedModel,
      requestedEffort: modelOnly.requestedEffort,
      modelSelection: modelOnly.modelSelection,
      effortSelection: modelOnly.effortSelection,
      nativeTask: modelOnly.launch.nativeTask,
    },
    {
      taskShape: null,
      profile: "sol",
      requestedModel: "gpt-5.6-sol",
      requestedEffort: null,
      modelSelection: "override",
      effortSelection: "inherit",
      nativeTask: { model: "gpt-5.6-sol" },
    },
  );

  const effortOnly = routeIntelligenceProfile({ effortOverride: "high", launchSurface: "durable-task" });
  assert.deepEqual(
    {
      taskShape: effortOnly.taskShape,
      profile: effortOnly.profile,
      requestedModel: effortOnly.requestedModel,
      requestedEffort: effortOnly.requestedEffort,
      modelSelection: effortOnly.modelSelection,
      effortSelection: effortOnly.effortSelection,
      nativeTask: effortOnly.launch.nativeTask,
    },
    {
      taskShape: null,
      profile: null,
      requestedModel: null,
      requestedEffort: "high",
      modelSelection: "inherit",
      effortSelection: "override",
      nativeTask: { thinking: "high" },
    },
  );

  const explicit = routeIntelligenceProfile({
    modelOverride: "gpt-5.6-terra",
    effortOverride: "max",
    launchSurface: "durable-task",
  });
  assert.deepEqual(explicit.launch.nativeTask, {
    model: "gpt-5.6-terra",
    thinking: "max",
  });
});

test("explicit profile overrides win and conflicting explicit overrides fail", () => {
  const route = routeIntelligenceProfile({
    taskShape: "everyday",
    profileOverride: "sol",
    effortOverride: "high",
    launchSurface: "durable-task",
  });
  assert.equal(route.profile, "sol");
  assert.equal(route.requestedModel, "gpt-5.6-sol");
  assert.equal(route.requestedEffort, "high");
  assert.throws(
    () =>
      routeIntelligenceProfile({
        taskShape: "everyday",
        profileOverride: "sol",
        modelOverride: "gpt-5.6-terra",
        launchSurface: "durable-task",
      }),
    /explicit intelligence profile and model overrides conflict/,
  );
});

test("unsupported task shapes, models, and efforts fail without fallback", () => {
  assert.throws(
    () =>
      routeIntelligenceProfile({
        taskShape: "everyday",
        launchSurface: "unsupported",
      }),
    /unsupported intelligence launch surface: unsupported/,
  );
  assert.throws(
    () =>
      routeIntelligenceProfile({
        taskShape: "everyday",
        profileOverride: "unsupported",
        launchSurface: "durable-task",
      }),
    /unsupported intelligence profile: unsupported/,
  );
  assert.throws(
    () => routeIntelligenceProfile({ taskShape: "mystery", launchSurface: "durable-task" }),
    /unsupported intelligence task shape: mystery/,
  );
  assert.throws(
    () =>
      routeIntelligenceProfile({
        taskShape: "everyday",
        modelOverride: "gpt-unknown",
        launchSurface: "durable-task",
      }),
    /unsupported intelligence model: gpt-unknown/,
  );
  assert.throws(
    () =>
      routeIntelligenceProfile({
        taskShape: "everyday",
        effortOverride: "extreme",
        launchSurface: "durable-task",
      }),
    /unsupported reasoning effort for terra: extreme/,
  );
  for (const effortOverride of ["high", "xhigh", "max"]) {
    assert.equal(
      routeIntelligenceProfile({
        taskShape: "clear/repeatable",
        effortOverride,
        launchSurface: "durable-task",
      }).requestedEffort,
      effortOverride,
    );
  }
  assert.throws(
    () => routeIntelligenceProfile({ effortOverride: "extreme", launchSurface: "durable-task" }),
    /unsupported independent reasoning effort: extreme/,
  );
});

test("omitted routing preserves host defaults", () => {
  assert.equal(routeIntelligenceProfile(), null);
  assert.equal(routeIntelligenceProfile({}), null);
  assert.throws(
    () => routeIntelligenceProfile({ taskShape: "everyday" }),
    /unsupported intelligence launch surface: undefined/,
  );
});

test("Ultra requires explicit native fan-out permission", () => {
  assert.throws(
    () =>
      routeIntelligenceProfile({
        taskShape: "complex/open-ended",
        effortOverride: "ultra",
        launchSurface: "durable-task",
      }),
    /Ultra requires explicit native-fan-out permission/,
  );
  assert.equal(
    routeIntelligenceProfile({
      taskShape: "complex/open-ended",
      effortOverride: "ultra",
      nativeFanoutAllowed: true,
      launchSurface: "durable-task",
    }).requestedEffort,
    "ultra",
  );
  assert.throws(
    () =>
      routeIntelligenceProfile({
        effortOverride: "ultra",
        nativeFanoutAllowed: true,
        launchSurface: "durable-task",
      }),
    /Ultra requires an explicit or recommended Sol or Terra profile/,
  );
});
