import assert from "node:assert/strict";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { finalizeVerifierCleanup } from "../scripts/verify-app-server.mjs";

test("verifier finalization stops the server and removes artifacts after discovery fails", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "verifier-cleanup-test-"));
  const calls = [];
  const discoveryError = new Error("registered task directory is unreadable");

  try {
    const cleanupError = await finalizeVerifierCleanup({
      cleanupLiveTasks: async () => {
        calls.push("discover");
        throw discoveryError;
      },
      removeTemporary: async () => {
        calls.push("remove");
        await rm(temporary, { force: true, recursive: true });
      },
      stopServer: async () => {
        calls.push("stop");
      },
      temporary,
    });

    assert.deepEqual(calls, ["discover", "stop", "remove"]);
    assert.equal(cleanupError, discoveryError);
    await assert.rejects(access(temporary), { code: "ENOENT" });
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
});

test("verifier finalization aggregates discovery and artifact-removal failures", async () => {
  const discoveryError = new Error("registered task directory is unreadable");
  const removalError = new Error("permission denied");

  const cleanupError = await finalizeVerifierCleanup({
    cleanupLiveTasks: async () => {
      throw discoveryError;
    },
    removeTemporary: async () => {
      throw removalError;
    },
    stopServer: async () => {},
    temporary: "/tmp/verifier-regression",
  });

  assert.ok(cleanupError instanceof AggregateError);
  assert.equal(cleanupError.errors[0], discoveryError);
  assert.equal(cleanupError.errors[1].cause, removalError);
  assert.match(cleanupError.message, /registered task directory is unreadable/);
  assert.match(
    cleanupError.message,
    /could not remove verifier artifacts at \/tmp\/verifier-regression: permission denied/,
  );
});
