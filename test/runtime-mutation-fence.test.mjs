import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  commitRuntimeMutationV1,
  RuntimeMutationBoundaryV1,
  RuntimeMutationFenceError,
} from "../src/runtime-mutation-fence.mjs";
import { NelosConfigStoreV1 } from "../src/nelos-configuration.mjs";

const LOADED = Object.freeze({
  version: "0.12.5",
  sourceRevision: "a".repeat(40),
  integrity: `sha256:${"1".repeat(64)}`,
  buildIdentity: `nelos-build:${"a".repeat(32)}`,
  modulePath: "/cache/nelos/0.12.5",
});
const INSTALLED = Object.freeze({
  version: "0.12.6",
  sourceRevision: "b".repeat(40),
  integrity: `sha256:${"2".repeat(64)}`,
  buildIdentity: `nelos-build:${"b".repeat(32)}`,
  modulePath: "/cache/nelos/0.12.6",
});

function health(state = "healthy") {
  const installedIdentities = state === "ambiguous-install"
    ? [LOADED, INSTALLED]
    : state === "restart-required" ? [INSTALLED] : [];
  return {
    state,
    loaded: LOADED,
    installed: state === "restart-required" ? INSTALLED : null,
    installedIdentities,
    mutationAllowed: state === "healthy" || state === "degraded",
    detail: `${state} fixture`,
    recovery: state === "healthy"
      ? "None required."
      : `Perform the one ${state} recovery action.`,
  };
}

test("tool annotations centrally exempt read-only work and admit both mutation classes", async () => {
  let checks = 0;
  const boundary = new RuntimeMutationBoundaryV1({
    health: async ({ verifyIntegrity }) => {
      checks += 1;
      assert.equal(verifyIntegrity, true);
      return health();
    },
  });
  const readOnly = { readOnlyHint: true, destructiveHint: false };
  const stateful = { readOnlyHint: false, destructiveHint: false };
  const destructive = { readOnlyHint: false, destructiveHint: true };

  assert.equal(await boundary.run(readOnly, async () => "diagnostic"), "diagnostic");
  assert.equal(checks, 0);
  assert.equal(await boundary.run(stateful, async () => "stateful"), "stateful");
  assert.equal(await boundary.run(destructive, async () => "destructive"), "destructive");
  assert.equal(checks, 2);
});

test("every rejected runtime state returns a typed identity-bearing error and one recovery action", async () => {
  const cases = [
    ["restart-required", "STALE_RUNTIME"],
    ["ambiguous-install", "AMBIGUOUS_RUNTIME_INSTALL"],
    ["integrity-failure", "RUNTIME_INTEGRITY_FAILURE"],
  ];
  for (const [state, code] of cases) {
    const boundary = new RuntimeMutationBoundaryV1({ health: async () => health(state) });
    await assert.rejects(
      boundary.run({ readOnlyHint: false }, async () => assert.fail("ran mutation")),
      (error) => {
        assert.ok(error instanceof RuntimeMutationFenceError);
        assert.equal(error.code, code);
        assert.equal(error.phase, "admission");
        assert.deepEqual(error.loaded, LOADED);
        assert.deepEqual(error.installed, state === "restart-required" ? INSTALLED : null);
        assert.deepEqual(
          error.installedIdentities,
          state === "ambiguous-install"
            ? [LOADED, INSTALLED]
            : state === "restart-required" ? [INSTALLED] : [],
        );
        assert.equal(error.recoveryAction, `Perform the one ${state} recovery action.`);
        return true;
      },
    );
  }
});

test("durable commits revalidate and refuse a runtime that became stale after admission", async () => {
  const observations = [health(), health("restart-required")];
  const boundary = new RuntimeMutationBoundaryV1({ health: async () => observations.shift() });
  let committed = false;
  await assert.rejects(
    boundary.run({ readOnlyHint: false }, () =>
      commitRuntimeMutationV1(async () => { committed = true; })
    ),
    (error) => error.code === "STALE_RUNTIME" && error.phase === "pre-commit",
  );
  assert.equal(committed, false);
  assert.equal(observations.length, 0);
});

test("the shared boundary prevents a real store rename after cache replacement", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nelos-mutation-fence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "config.toml");
  const observations = [health(), health("restart-required")];
  const boundary = new RuntimeMutationBoundaryV1({
    health: async () => observations.shift(),
  });
  const store = new NelosConfigStoreV1({ path });

  await assert.rejects(
    boundary.run({ readOnlyHint: false }, () => store.setCleanupPolicy("keep")),
    (error) => error.code === "STALE_RUNTIME" && error.phase === "pre-commit",
  );
  await assert.rejects(readFile(path, "utf8"), { code: "ENOENT" });
});

test("a commit drains after its final check while later commits observe replacement", async () => {
  let current = health();
  const boundary = new RuntimeMutationBoundaryV1({ health: async () => current });
  let releaseCommit;
  const commitBlocked = new Promise((resolve) => { releaseCommit = resolve; });
  let enteredCommit;
  const commitEntered = new Promise((resolve) => { enteredCommit = resolve; });
  const events = [];

  await boundary.run({ readOnlyHint: false }, async () => {
    const inFlight = commitRuntimeMutationV1(async () => {
      events.push("commit-started");
      enteredCommit();
      await commitBlocked;
      events.push("commit-finished");
    });
    await commitEntered;
    current = health("restart-required");
    releaseCommit();
    await inFlight;
    await assert.rejects(
      commitRuntimeMutationV1(async () => events.push("stale-write")),
      (error) => error.code === "STALE_RUNTIME" && error.phase === "pre-commit",
    );
  });

  assert.deepEqual(events, ["commit-started", "commit-finished"]);
});
