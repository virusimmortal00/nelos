import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  collectGeneratedSchemaEvidenceV1,
  collectRuntimeLiveEvidenceV1,
  collectRuntimeTransportEvidenceV1,
  concludeWireCompatibilityV1,
  validateWireCompatibilityEvidenceV1,
} from "../src/wire-compatibility-collector.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const fakeCodex = fileURLToPath(
  new URL("./support/fake-wire-codex.mjs", import.meta.url),
);
const exactIdentity = [{ version: "0.144.6", commitSha: null }];
const clock = () => new Date("2026-07-29T12:00:00.000Z");
const execFileAsync = promisify(execFile);

test.before(async () => {
  await chmod(fakeCodex, 0o755);
});

test("wire collectors are available through the public package subpath", async () => {
  const publicCollector = await import("nelos/wire-compatibility-collector");
  assert.equal(
    publicCollector.collectGeneratedSchemaEvidenceV1,
    collectGeneratedSchemaEvidenceV1,
  );
});

test("checked-in generated-schema artifacts record identities, provenance, digest, and time", async () => {
  const report = await collectGeneratedSchemaEvidenceV1({
    root,
    now: clock,
    declaration: {
      checkId: "schema.app-server-v0144x",
      expectedCodexIdentities: [
        { version: "0.144.5", commitSha: null },
        { version: "0.144.6", commitSha: null },
      ],
      artifact: {
        path: "test/fixtures/mcp-app-server-protocol-v0.144.x.json",
      },
    },
  });

  assert.equal(validateWireCompatibilityEvidenceV1(report), report);
  assert.equal(report.outcome, "passed");
  assert.equal(report.provenance.mode, "artifact");
  assert.match(report.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(report.observedAt, "2026-07-29T12:00:00.000Z");
  assert.deepEqual(
    report.observations.map(({ codexIdentity }) => codexIdentity.version),
    ["0.144.5", "0.144.6"],
  );
});

test("generated-schema command collection executes only declared argv", async () => {
  const calls = [];
  const report = await collectGeneratedSchemaEvidenceV1({
    now: clock,
    runCommand: async (executable, args, options) => {
      calls.push({ executable, args: [...args] });
      return execFileAsync(executable, args, options);
    },
    declaration: {
      checkId: "schema.command",
      expectedCodexIdentities: exactIdentity,
      identityCommand: {
        executable: fakeCodex,
        args: ["--version"],
      },
      command: {
        executable: fakeCodex,
        args: ["app-server", "generate-json-schema", "--experimental"],
      },
    },
  });

  assert.equal(report.outcome, "passed");
  assert.deepEqual(calls, [
    { executable: fakeCodex, args: ["--version"] },
    {
      executable: fakeCodex,
      args: ["app-server", "generate-json-schema", "--experimental"],
    },
  ]);
  assert.deepEqual(report.observedCodexIdentity, exactIdentity[0]);
});

test("a declared commit identity cannot be satisfied by version-only output", async () => {
  const report = await collectGeneratedSchemaEvidenceV1({
    root,
    now: clock,
    declaration: {
      checkId: "schema.commit",
      expectedCodexIdentities: [{
        version: "0.144.6",
        commitSha: "5d1fbf26c43abc65a203928b2e31561cb039e06d",
      }],
      artifact: {
        path: "test/fixtures/mcp-app-server-protocol-v0.144.x.json",
      },
    },
  });

  assert.equal(report.outcome, "infrastructure-failure");
  assert.equal(report.failure.kind, "identity-mismatch");
  assert.equal(report.countsForCompatibility, false);
});

test("runtime transport uses an exact fake executable and declared bounded reads", async () => {
  const report = await collectRuntimeTransportEvidenceV1({
    now: clock,
    declaration: {
      checkId: "runtime.stdio-transport",
      executable: fakeCodex,
      transport: "stdio-jsonl",
      expectedCodexIdentities: exactIdentity,
      operations: [{
        method: "thread/list",
        params: { limit: 1, archived: false },
        readOnly: true,
        validate(result) {
          assert.deepEqual(result, { data: [], nextCursor: null });
        },
      }],
    },
  });

  assert.equal(validateWireCompatibilityEvidenceV1(report), report);
  assert.equal(report.outcome, "passed");
  assert.equal(report.observedCodexIdentity.version, "0.144.6");
  assert.deepEqual(
    report.observations.map(({ operation }) => operation),
    ["initialize", "thread/list"],
  );
  assert.match(report.digest, /^sha256:[a-f0-9]{64}$/u);
});

test("runtime transport CLI emits the same normalized fake-executable report", async () => {
  const script = fileURLToPath(
    new URL("../scripts/collect-runtime-transport.mjs", import.meta.url),
  );
  const { stdout } = await execFileAsync(
    process.execPath,
    [script, "--codex", fakeCodex, "--timeout-ms", "2000"],
    { cwd: root, encoding: "utf8" },
  );
  const report = JSON.parse(stdout);
  assert.equal(validateWireCompatibilityEvidenceV1(report), report);
  assert.equal(report.outcome, "passed");
  assert.equal(report.provenance.executable, fakeCodex);
  assert.deepEqual(
    report.observations.map(({ operation }) => operation),
    ["initialize", "thread/list"],
  );
});

test("runtime transport reports early child stdin closure without an uncaught EPIPE", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nelos-closing-codex-"));
  const closingCodex = join(directory, "closing-codex.mjs");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(
    closingCodex,
    "#!/usr/bin/env node\nprocess.stdin.destroy();\nprocess.exit(0);\n",
  );
  await chmod(closingCodex, 0o755);

  const report = await collectRuntimeTransportEvidenceV1({
    now: clock,
    timeoutMs: 500,
    declaration: {
      checkId: "runtime.closed-stdin",
      executable: closingCodex,
      transport: "stdio-jsonl",
      expectedCodexIdentities: exactIdentity,
      operations: [],
    },
  });
  assert.equal(report.outcome, "infrastructure-failure");
  assert.equal(report.failure.kind, "infrastructure");
  assert.match(report.failure.message, /exited|EPIPE/iu);
});

test("identity mismatch, malformed output, and timeout remain non-evidence", async () => {
  const mismatch = await collectRuntimeTransportEvidenceV1({
    now: clock,
    declaration: {
      checkId: "runtime.identity",
      transport: "stdio-jsonl",
      expectedCodexIdentities: [{ version: "0.144.5" }],
      operations: [],
    },
    transportFactory: async () => ({
      request: async () => ({ userAgent: "codex-cli/0.144.6" }),
      close: async () => {},
    }),
  });
  assert.equal(mismatch.outcome, "infrastructure-failure");
  assert.equal(mismatch.failure.kind, "identity-mismatch");
  assert.equal(mismatch.countsForCompatibility, false);

  const malformed = await collectRuntimeTransportEvidenceV1({
    now: clock,
    declaration: {
      checkId: "runtime.malformed",
      transport: "stdio-jsonl",
      expectedCodexIdentities: exactIdentity,
      operations: [],
    },
    transportFactory: async () => ({
      request: async () => ({ userAgent: "not-versioned" }),
      close: async () => {},
    }),
  });
  assert.equal(malformed.outcome, "infrastructure-failure");
  assert.equal(malformed.failure.kind, "malformed-output");

  const timeout = await collectRuntimeTransportEvidenceV1({
    now: clock,
    declaration: {
      checkId: "runtime.timeout",
      transport: "stdio-jsonl",
      expectedCodexIdentities: exactIdentity,
      operations: [],
    },
    transportFactory: async () => ({
      request: async () => {
        const error = new Error("initialize timed out");
        error.code = "ETIMEDOUT";
        throw error;
      },
      close: async () => {},
    }),
  });
  assert.equal(timeout.outcome, "infrastructure-failure");
  assert.equal(timeout.failure.kind, "timeout");
});

test("runtime-live is inert until explicitly enabled and accepts read-only mock probes", async () => {
  let factories = 0;
  const declaration = {
    checkId: "runtime.live-app-server",
    transport: "stdio-jsonl",
    expectedCodexIdentities: exactIdentity,
    operations: [{
      method: "thread/read",
      params: { threadId: "thread-safe", includeTurns: false },
      readOnly: true,
    }],
  };
  const disabled = await collectRuntimeLiveEvidenceV1({
    declaration,
    now: clock,
    transportFactory: async () => {
      factories += 1;
      throw new Error("must not run");
    },
  });
  assert.equal(disabled.outcome, "unavailable");
  assert.equal(factories, 0);

  const methods = [];
  const enabled = await collectRuntimeLiveEvidenceV1({
    declaration,
    enabled: true,
    now: clock,
    transportFactory: async () => ({
      async request(method) {
        methods.push(method);
        return method === "initialize"
          ? { userAgent: "codex-cli/0.144.6" }
          : { thread: { id: "thread-safe" } };
      },
      async close() {},
    }),
  });
  assert.equal(enabled.outcome, "passed");
  assert.deepEqual(methods, ["initialize", "thread/read"]);
});

test("runtime collectors reject mutation, oversized batches, and unbounded reads before transport", async () => {
  let factories = 0;
  for (const operations of [
    [{
      method: "thread/archive",
      params: { threadId: "thread-safe" },
      readOnly: false,
    }],
    Array.from({ length: 9 }, () => ({
      method: "thread/list",
      params: { limit: 1 },
      readOnly: true,
    })),
    [{
      method: "thread/turns/list",
      params: { threadId: "thread-safe", limit: 101 },
      readOnly: true,
    }],
  ]) {
    const report = await collectRuntimeTransportEvidenceV1({
      declaration: {
        checkId: "runtime.bounds",
        transport: "stdio-jsonl",
        expectedCodexIdentities: exactIdentity,
        operations,
      },
      now: clock,
      transportFactory: async () => {
        factories += 1;
        throw new Error("must not open");
      },
    });
    assert.equal(report.outcome, "infrastructure-failure");
    assert.equal(report.countsForCompatibility, false);
  }
  assert.equal(factories, 0);
});

test("implementation-source observations remain advisory to wire conclusions", () => {
  const passed = {
    outcome: "passed",
    evidenceKind: "generated-schema",
  };
  const conclusion = concludeWireCompatibilityV1({
    generatedSchema: [passed],
    implementationSource: [{ outcome: "failed", path: "upstream/source.rs" }],
  });
  assert.equal(conclusion.status, "compatible");
  assert.equal(
    conclusion.advisoryImplementationSource[0].countsForCompatibility,
    false,
  );
  assert.equal(
    conclusion.advisoryImplementationSource[0].authority,
    "advisory-only",
  );
});
