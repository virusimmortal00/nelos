import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  cp,
  readFile,
  readdir,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { readProcessIdentity } from "../src/process-liveness.mjs";
import { formatResultEnvelope } from "../src/work-result.mjs";
import { startMockAppServer } from "./support/mock-app-server.mjs";

const cli = fileURLToPath(new URL("../bin/nelos", import.meta.url));
const titleCli = fileURLToPath(new URL("../bin/nelos-title", import.meta.url));
const skillInstaller = fileURLToPath(
  new URL("../bin/nelos-install-skill", import.meta.url),
);
const expectedProvenance = JSON.parse(
  await readFile(new URL("../distribution-provenance.json", import.meta.url), "utf8"),
);
const permissionProfileProtocol = JSON.parse(
  await readFile(
    new URL("./fixtures/app-server-permissions-v0.144.6.json", import.meta.url),
    "utf8",
  ),
);

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function testEnvironment(overrides = {}) {
  const environment = { ...process.env };
  delete environment.CODEX_THREAD_ID;
  return { ...environment, ...overrides };
}

function run(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    encoding: "utf8",
    env: testEnvironment(),
  });
}

function runAsync(script, args, env = {}, input = null) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: testEnvironment(env),
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    if (input !== null) child.stdin.end(input);
    child.once("error", reject);
    child.once("close", (status, signal) => {
      resolve({ status, signal, stdout, stderr });
    });
  });
}

function mockThread(id, name) {
  return {
    id,
    sessionId: `session-${id}`,
    name,
    preview: "",
    status: { type: "idle" },
    cwd: process.cwd(),
    source: "appServer",
    threadSource: "nelos-cli",
    createdAt: 1,
    updatedAt: 2,
  };
}

test("main CLI help includes persistent-task lifecycle commands", () => {
  const result = run(cli, ["--help"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nelos start/);
  assert.match(result.stdout, /nelos spinoff/);
  assert.match(result.stdout, /--queen-thread-id/);
  assert.match(result.stdout, /nelos web collect/);
  assert.match(result.stdout, /nelos send/);
  assert.match(result.stdout, /nelos watch/);
  assert.match(result.stdout, /nelos archive/);
  assert.match(result.stdout, /nelos plan slices/);
  assert.match(result.stdout, /nelos worktree provision/);
  assert.match(result.stdout, /--spec-file/);
  assert.match(result.stdout, /nelos intelligence route/);
  assert.match(result.stdout, /nelos intelligence verify/);
  assert.match(result.stdout, /nelos doctor/);
  assert.match(result.stdout, /use - for standard input/);
});

test("worktree provision creates an isolated writer checkout without an app-server connection", async (t) => {
  const root = await mkdtemp(join(process.cwd(), ".nelos-cli-worktree-"));
  const source = join(root, "source");
  const worktree = join(root, "member-worktree");
  const stateHome = join(root, "state");
  const runGit = (args, cwd = source) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(source);
  runGit(["init", "--initial-branch=main"]);
  runGit(["config", "user.email", "tests@example.invalid"]);
  runGit(["config", "user.name", "Nelos Tests"]);
  await writeFile(join(source, "README.md"), "base\n");
  runGit(["add", "README.md"]);
  runGit(["commit", "-m", "base"]);

  const result = await runAsync(
    cli,
    [
      "worktree",
      "provision",
      "--action-id", "launch-api-1",
      "--work-unit-id", "api",
      "--owner-task-id", "queen-thread",
      "--source", source,
      "--worktree-path", worktree,
      "--branch", "nelos/api",
      "--base", "HEAD",
    ],
    { XDG_STATE_HOME: stateHome },
  );

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.command, "worktree provision");
  assert.equal(output.reused, false);
  assert.equal(output.receipt.state, "provisioned");
  assert.equal(runGit(["branch", "--show-current"], worktree), "nelos/api");
});

test("worktree launch binds a durable work unit and reports integration readiness", async (t) => {
  const root = await mkdtemp(join(process.cwd(), ".nelos-worktree-launch-"));
  const source = join(root, "source");
  const writers = join(root, "writers");
  const stateHome = join(root, "state");
  const socketRoot = await mkdtemp(join(tmpdir(), "nelos-worktree-socket-"));
  const socketPath = join(socketRoot, "app.sock");
  const specPath = join(root, "work-unit.json");
  const runGit = (args, cwd = source) => {
    const result = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const queen = mockThread("queen-thread", "Release queen");
  const member = mockThread("member-thread", "Implement API");
  let finalResult = null;
  let threadStarts = 0;
  const server = await startMockAppServer(socketPath, async ({ method, params }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") {
      return { thread: params.threadId === queen.id ? queen : member };
    }
    if (method === "thread/name/set") {
      if (params.threadId === queen.id) queen.name = params.name;
      if (params.threadId === member.id) member.name = params.name;
      return {};
    }
    if (method === "thread/start") {
      threadStarts += 1;
      return { thread: member };
    }
    if (method === "turn/start") {
      return { turn: { id: "member-turn", status: "inProgress" } };
    }
    if (method === "thread/turns/list") {
      return {
        data: [
          {
            id: "member-turn",
            status: "completed",
            items: finalResult === null
              ? []
              : [{ type: "agentMessage", phase: "finalAnswer", text: finalResult }],
          },
        ],
      };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
    await rm(socketRoot, { recursive: true, force: true });
  });
  await mkdir(source);
  await mkdir(writers);
  runGit(["init", "--initial-branch=main"]);
  runGit(["config", "user.email", "tests@example.invalid"]);
  runGit(["config", "user.name", "Nelos Tests"]);
  await writeFile(join(source, "README.md"), "base\n");
  runGit(["add", "README.md"]);
  runGit(["commit", "-m", "base"]);
  await writeFile(
    specPath,
    `${JSON.stringify({
      webId: "A1",
      queenThreadId: queen.id,
      workUnitId: "api",
      specRevision: 1,
      attempt: 1,
      memberKind: "spinoff",
      capabilities: ["observe", "read-result", "follow-up", "archive"],
      title: "Implement API",
      objectiveSummary: "Implement the isolated API change.",
      deliverable: "A committed API patch.",
      acceptanceCriteria: ["Focused tests pass"],
      dependencies: [],
      required: true,
      policy: { maxAttempts: 2, onBlocked: "queen-review", onFailure: "queen-review" },
    }, null, 2)}\n`,
  );

  const launch = await runAsync(
    cli,
    [
      "worktree",
      "launch",
      "--work-unit-spec", specPath,
      "--prompt", "Implement the API change in your assigned worktree.",
      "--source", source,
      "--worktree-root", writers,
      "--base", "HEAD",
      "--socket", socketPath,
    ],
    { XDG_STATE_HOME: stateHome },
  );

  assert.equal(launch.status, 0, launch.stderr);
  const launched = JSON.parse(launch.stdout);
  assert.equal(launched.command, "worktree launch");
  assert.equal(launched.binding.state, "bound");
  assert.equal(launched.binding.memberThreadId, member.id);
  assert.equal(runGit(["branch", "--show-current"], launched.worktree.worktreePath), launched.worktree.branch);
  const replay = await runAsync(
    cli,
    [
      "worktree",
      "launch",
      "--work-unit-spec", specPath,
      "--prompt", "Implement the API change in your assigned worktree.",
      "--source", source,
      "--worktree-root", writers,
      "--base", "HEAD",
      "--socket", socketPath,
    ],
    { XDG_STATE_HOME: stateHome },
  );
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal(JSON.parse(replay.stdout).reused, true);
  assert.equal(threadStarts, 1, "a bound launch action must not start another task");
  await writeFile(join(launched.worktree.worktreePath, "change.md"), "implemented\n");
  runGit(["add", "change.md"], launched.worktree.worktreePath);
  runGit(["commit", "-m", "implement api"], launched.worktree.worktreePath);
  finalResult = formatResultEnvelope({
    schemaVersion: 1,
    workUnitId: "api",
    specRevision: 1,
    attempt: 1,
    outcome: "succeeded",
    summary: "API change is committed.",
    artifacts: ["change.md"],
    verification: ["Focused tests pass"],
    blockers: [],
    recoveryHint: null,
  });

  const integration = await runAsync(
    cli,
    [
      "worktree",
      "integration",
      "--queen-thread-id", queen.id,
      "--socket", socketPath,
    ],
    { XDG_STATE_HOME: stateHome },
  );

  assert.equal(integration.status, 0, integration.stderr);
  const queue = JSON.parse(integration.stdout);
  assert.equal(queue.command, "worktree integration");
  assert.equal(queue.readyCount, 1);
  assert.equal(queue.entries[0].ready, true);
  assert.deepEqual(queue.entries[0].artifacts.artifacts, [{ path: "change.md", kind: "file" }]);
});

test("packaged launcher plans dependency waves and per-slice routes offline", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-plan-package-"));
  const installedRoot = join(root, "installed-release");
  const unrelatedCwd = join(root, "unrelated-workspace");
  const spec = {
    schemaVersion: 1,
    objective: "Research then implement",
    maxParallel: 2,
    slices: [
      {
        id: "research",
        title: "Research",
        objective: "Resolve the design question",
        deliverable: "A decision with evidence",
        acceptanceCriteria: ["The tradeoff is explicit"],
        dependsOn: [],
        lifecycle: "subagent",
        workspaceMode: "shared-read-only",
        taskShape: "complex/open-ended",
      },
      {
        id: "implement",
        title: "Implement",
        objective: "Build the selected design",
        deliverable: "A verified patch",
        acceptanceCriteria: ["Focused tests pass"],
        dependsOn: ["research"],
        lifecycle: "spinoff",
        workspaceMode: "isolated-write",
        taskShape: "everyday",
      },
    ],
  };
  try {
    await mkdir(installedRoot);
    await mkdir(unrelatedCwd);
    for (const entry of ["bin", "src", "package.json", "distribution-provenance.json"]) {
      await cp(join(fileURLToPath(new URL("..", import.meta.url)), entry), join(installedRoot, entry), {
        recursive: true,
      });
    }
    const result = await new Promise((resolvePromise, rejectPromise) => {
      const child = spawn(
        process.execPath,
        [join(installedRoot, "bin", "nelos"), "plan", "slices", "--spec-file", "-"],
        {
          cwd: unrelatedCwd,
          env: { ...testEnvironment(), CODEX_THREAD_ID: "queen-plan-test" },
        },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.once("error", rejectPromise);
      child.once("close", (status) => resolvePromise({ status, stdout, stderr }));
      child.stdin.end(JSON.stringify(spec));
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.command, "plan slices");
    assert.deepEqual(
      output.plan.waves.map((wave) => wave.slices.map((slice) => slice.id)),
      [["research"], ["implement"]],
    );
    assert.deepEqual(output.plan.waves[0].slices[0].route.launch.nativeTask, {
      model: "gpt-5.6-sol",
      thinking: "medium",
    });
    assert.deepEqual(output.plan.waves[1].slices[0].route.launch.nativeTask, {
      model: "gpt-5.6-terra",
      thinking: "low",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("plan slices rejects malformed input before app-server access", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-plan-invalid-"));
  try {
    const invalidJson = await runAsync(
      cli,
      ["plan", "slices", "--spec-file", "-", "--socket", join(root, "missing.sock")],
      {},
      "{",
    );
    assert.equal(invalidJson.status, 1);
    assert.match(invalidJson.stderr, /plan slices does not accept --socket/);

    const invalidSpec = await runAsync(
      cli,
      ["plan", "slices", "--spec-file", "-"],
      {},
      JSON.stringify({ schemaVersion: 1, objective: "No slices", slices: [] }),
    );
    assert.equal(invalidSpec.status, 1);
    assert.match(invalidSpec.stderr, /slices must contain between 1 and 32 entries/);

    const missingQueen = await runAsync(
      cli,
      ["plan", "slices", "--spec-file", "-"],
      {},
      JSON.stringify({
        schemaVersion: 1,
        objective: "One valid slice",
        slices: [{
          id: "one",
          title: "One",
          objective: "Do one bounded task",
          deliverable: "One result",
          acceptanceCriteria: ["The result is verified"],
          dependsOn: [],
          lifecycle: "subagent",
          workspaceMode: "shared-read-only",
          taskShape: "everyday",
        }],
      }),
    );
    assert.equal(missingQueen.status, 1);
    assert.match(missingQueen.stderr, /requires CODEX_THREAD_ID/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("start reads an exact multiline prompt from standard input", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-stdin-prompt-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const prompt = "First line\n```nelos-result\n{\"summary\":\"A_RESULT\"}\n```\n";
  let receivedPrompt = null;
  const thread = mockThread("stdin-thread", "Stdin prompt");
  const server = await startMockAppServer(socketPath, async ({ method, params }) => {
    if (method === "initialize") return {};
    if (method === "thread/start") return { thread };
    if (method === "turn/start") {
      receivedPrompt = params.input[0].text;
      return { turn: { id: "stdin-turn", status: "inProgress" } };
    }
    if (method === "thread/name/set") {
      thread.name = params.name;
      return {};
    }
    if (method === "thread/read") return { thread };
    if (method === "thread/turns/list") {
      return { data: [{ id: "stdin-turn", status: "interrupted" }] };
    }
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const result = await runAsync(
      cli,
      [
        "start",
        "--title",
        "Stdin prompt",
        "--prompt-file",
        "-",
        "--cwd",
        root,
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      { XDG_STATE_HOME: stateHome },
      prompt,
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.status, { type: "active", activeFlags: [] });
    assert.equal(output.latestTurn.id, "stdin-turn");
    assert.equal(output.latestTurn.status, "inProgress");
    assert.equal(receivedPrompt, prompt);
    assert.equal(
      server.requests.some(({ method }) => method === "thread/turns/list"),
      false,
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged launcher routes intelligence from an unrelated working directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-intelligence-package-"));
  const installedRoot = join(root, "installed-release");
  const unrelatedCwd = join(root, "unrelated-workspace");
  try {
    await mkdir(installedRoot);
    await mkdir(unrelatedCwd);
    for (const entry of ["bin", "src", "package.json", "distribution-provenance.json"]) {
      await cp(join(fileURLToPath(new URL("..", import.meta.url)), entry), join(installedRoot, entry), {
        recursive: true,
      });
    }
    const result = spawnSync(
      process.execPath,
      [
        join(installedRoot, "bin", "nelos"),
        "intelligence",
        "route",
        "--task-shape",
        "clear/repeatable",
        "--effort",
        "max",
      ],
      { cwd: unrelatedCwd, encoding: "utf8", env: testEnvironment() },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      command: "intelligence route",
      route: {
        schemaVersion: 2,
        policyVersion: 3,
        catalogVersion: "openai-2026-07-21",
        taskShape: "clear/repeatable",
        profile: "luna",
        requestedModel: "gpt-5.6-luna",
        requestedEffort: "max",
        modelSelection: "recommended",
        effortSelection: "override",
        launch: {
          nativeTask: { model: "gpt-5.6-luna", thinking: "max" },
          standaloneTask: { model: "gpt-5.6-luna", effort: "max" },
        },
        rationale:
          "Explicit validated model or reasoning choices take precedence over the Luna recommendation; any unselected dimension uses that recommendation.",
        nativeFanoutAllowed: false,
      },
      nextAction: {
        schemaVersion: 1,
        kind: "attach-native-task-options",
        nativeTask: { model: "gpt-5.6-luna", thinking: "max" },
        routeEnforcement: {
          mode: "exact",
          onUnavailable: "stop",
          verifyAfterLaunch: true,
        },
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("intelligence routing emits directly consumable independent native launch options", () => {
  const modelOnly = run(cli, [
    "intelligence",
    "route",
    "--model",
    "gpt-5.6-sol",
  ]);
  assert.equal(modelOnly.status, 0, modelOnly.stderr);
  assert.deepEqual(JSON.parse(modelOnly.stdout).route.launch.nativeTask, {
    model: "gpt-5.6-sol",
  });

  const effortOnly = run(cli, ["intelligence", "route", "--effort", "high"]);
  assert.equal(effortOnly.status, 0, effortOnly.stderr);
  assert.deepEqual(JSON.parse(effortOnly.stdout).route.launch.nativeTask, {
    thinking: "high",
  });
});

test("intelligence routing omission preserves host defaults without app-server access", () => {
  const result = run(cli, ["intelligence", "route"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    command: "intelligence route",
    route: null,
    nextAction: {
      schemaVersion: 1,
      kind: "decide",
      operation: "author-slice-plan",
    },
  });
});

test("intelligence verification exits nonzero on an effective route mismatch", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-route-verify-"));
  const sessions = join(root, "sessions", "2026", "07", "21");
  const threadId = "thread-route-1";
  try {
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, `rollout-2026-07-21T18-29-33-${threadId}.jsonl`),
      `${JSON.stringify({
        type: "turn_context",
        payload: {
          turn_id: "turn-1",
          model: "gpt-5.6-sol",
          effort: "xhigh",
          summary: "private",
        },
      })}\n`,
    );
    const result = spawnSync(
      process.execPath,
      [
        cli,
        "intelligence",
        "verify",
        "--thread-id",
        threadId,
        "--model",
        "gpt-5.6-terra",
        "--effort",
        "low",
      ],
      {
        encoding: "utf8",
        env: testEnvironment({ CODEX_HOME: root }),
      },
    );
    assert.equal(result.status, 1, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.verified, false);
    assert.deepEqual(output.nextAction, {
      schemaVersion: 1,
      kind: "attention",
      reason: "exact-native-route-mismatch",
      threadId,
      expected: { model: "gpt-5.6-terra", effort: "low" },
      observed: [
        {
          turnId: "turn-1",
          model: "gpt-5.6-sol",
          effort: "xhigh",
          matches: false,
        },
      ],
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("main CLI reports its bundled distribution provenance", () => {
  const result = run(cli, ["--distribution-provenance"]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), expectedProvenance);
});

test("web collect rejects ignored and ambiguous options before reading tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-collect-options-"));
  const socketPath = join(root, "app.sock");
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    throw new Error(`unexpected method: ${method}`);
  });
  const environment = {
    CODEX_THREAD_ID: "queen-thread",
    XDG_STATE_HOME: join(root, "state"),
  };
  try {
    const ignored = await runAsync(
      cli,
      [
        "web",
        "collect",
        "--model",
        "example-model",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      environment,
    );
    assert.equal(ignored.status, 1);
    assert.match(ignored.stderr, /web collect does not accept --model/);

    const ambiguous = await runAsync(
      cli,
      [
        "web",
        "collect",
        "--queen-thread-id",
        "queen-thread",
        "--thread-id",
        "other-thread",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      environment,
    );
    assert.equal(ambiguous.status, 1);
    assert.match(ambiguous.stderr, /not both/);

    const pollingWithoutWait = await runAsync(
      cli,
      [
        "web",
        "collect",
        "--poll-ms",
        "5",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      environment,
    );
    assert.equal(pollingWithoutWait.status, 1);
    assert.match(pollingWithoutWait.stderr, /does not accept --poll-ms/);
    assert.equal(
      server.requests.some(({ method }) =>
        ["thread/read", "thread/turns/list"].includes(method),
      ),
      false,
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("web collect --wait polls read-only state until every member is terminal", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-collect-wait-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const webDirectory = join(stateHome, "nelos", "webs");
  await mkdir(webDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      join(webDirectory, "queen-thread.json"),
      `${JSON.stringify({
        threadId: "queen-thread",
        baseTitle: "Queen",
        outboundWebId: "A1",
        archivedAt: null,
      })}\n`,
    ),
    writeFile(
      join(webDirectory, "member-thread.json"),
      `${JSON.stringify({
        threadId: "member-thread",
        baseTitle: "Member",
        inboundWebId: "A1",
        outboundWebId: null,
        queenThreadId: "queen-thread",
        archivedAt: null,
      })}\n`,
    ),
  ]);
  const resultEnvelope = formatResultEnvelope({
    schemaVersion: 1,
    workUnitId: "wait-member",
    specRevision: 1,
    attempt: 1,
    outcome: "succeeded",
    summary: "WAIT_RESULT",
    artifacts: [],
    verification: [],
    blockers: [],
    recoveryHint: null,
  });
  let turnReads = 0;
  let neverSettle = false;
  const server = await startMockAppServer(socketPath, async ({ method, params }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") {
      assert.equal(params.includeTurns, false);
      return { thread: mockThread(params.threadId, "Member") };
    }
    if (method === "thread/turns/list") {
      turnReads += 1;
      return {
        data: [
          neverSettle || turnReads < 3
            ? { id: "member-turn", status: "inProgress", items: [] }
            : {
                id: "member-turn",
                status: "completed",
                items: [
                  {
                    type: "agentMessage",
                    phase: "final_answer",
                    text: resultEnvelope,
                  },
                ],
              },
        ],
      };
    }
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const collected = await runAsync(
      cli,
      [
        "web",
        "collect",
        "--id",
        "A1",
        "--wait",
        "--poll-ms",
        "5",
        "--max-wait-ms",
        "1000",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      { XDG_STATE_HOME: stateHome },
    );
    assert.equal(collected.status, 0, collected.stderr);
    const output = JSON.parse(collected.stdout);
    assert.equal(output.command, "web collect");
    assert.equal(output.allSucceeded, true);
    assert.equal(output.members[0].transportStatus, "completed");
    assert.equal(output.members[0].result.summary, "WAIT_RESULT");
    assert.equal(Object.hasOwn(output, "waited"), false);
    assert.equal(turnReads, 3);
    assert.ok(
      server.requests.every(({ method }) =>
        ["initialize", "initialized", "thread/read", "thread/turns/list"].includes(method),
      ),
    );

    neverSettle = true;
    turnReads = 0;
    const timeoutRequestStart = server.requests.length;
    const timedOut = await runAsync(
      cli,
      [
        "web",
        "collect",
        "--id",
        "A1",
        "--wait",
        "--poll-ms",
        "5",
        "--max-wait-ms",
        "75",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      { XDG_STATE_HOME: stateHome },
    );
    assert.equal(timedOut.status, 0, timedOut.stderr);
    assert.equal(timedOut.stderr, "");
    const timeoutOutput = JSON.parse(timedOut.stdout);
    assert.equal(timeoutOutput.command, "web collect");
    assert.equal(timeoutOutput.allSucceeded, false);
    assert.equal(timeoutOutput.members[0].transportStatus, "running");
    assert.equal(timeoutOutput.members[0].workOutcome, "unknown");
    assert.equal(timeoutOutput.wait.status, "timed_out");
    assert.equal(timeoutOutput.wait.settled, false);
    assert.equal(timeoutOutput.wait.maxWaitMs, 75);
    assert.ok(timeoutOutput.wait.elapsedMs >= 75);
    assert.equal(timeoutOutput.wait.mayStillBeRunning, true);
    assert.equal(timeoutOutput.wait.nonterminalCount, 1);
    assert.deepEqual(timeoutOutput.wait.nonterminalMembers, [
      {
        threadId: "member-thread",
        workUnitId: null,
        transportStatus: "running",
        workOutcome: "unknown",
        latestTurnId: "member-turn",
        sourceTurnId: null,
      },
    ]);
    assert.ok(
      server.requests.slice(timeoutRequestStart).every(({ method }) =>
        ["initialize", "initialized", "thread/read", "thread/turns/list"].includes(method),
      ),
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("web collect --wait bounds hung member reads by the collection deadline", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-collect-deadline-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const webDirectory = join(stateHome, "nelos", "webs");
  const memberThreadIds = Array.from(
    { length: 9 },
    (_, index) => `hung-member-${index + 1}`,
  );
  await mkdir(webDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      join(webDirectory, "queen-thread.json"),
      `${JSON.stringify({
        threadId: "queen-thread",
        baseTitle: "Queen",
        outboundWebId: "A1",
        archivedAt: null,
      })}\n`,
    ),
    ...memberThreadIds.map((threadId) =>
      writeFile(
        join(webDirectory, `${threadId}.json`),
        `${JSON.stringify({
          threadId,
          baseTitle: threadId,
          inboundWebId: "A1",
          outboundWebId: null,
          queenThreadId: "queen-thread",
          archivedAt: null,
        })}\n`,
      ),
    ),
  ]);

  let firstHangingRequestAt = null;
  const requestedMemberIds = new Set();
  const server = await startMockAppServer(socketPath, async ({ method, params }) => {
    if (method === "initialize") return {};
    if (["thread/read", "thread/turns/list"].includes(method)) {
      firstHangingRequestAt ??= Date.now();
      requestedMemberIds.add(params.threadId);
      return new Promise(() => {});
    }
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const timedOut = await runAsync(
      cli,
      [
        "web",
        "collect",
        "--id",
        "A1",
        "--wait",
        "--poll-ms",
        "5",
        "--max-wait-ms",
        "50",
        "--socket",
        socketPath,
        "--timeout-ms",
        "3000",
      ],
      { XDG_STATE_HOME: stateHome },
    );
    const elapsedAfterFirstRead = Date.now() - firstHangingRequestAt;

    assert.equal(timedOut.status, 0, timedOut.stderr);
    const output = JSON.parse(timedOut.stdout);
    assert.equal(output.wait.status, "timed_out");
    assert.equal(output.wait.maxWaitMs, 50);
    assert.ok(output.wait.elapsedMs >= 50);
    assert.equal(output.wait.mayStillBeRunning, true);
    assert.equal(output.wait.nonterminalCount, memberThreadIds.length);
    assert.deepEqual(
      output.wait.nonterminalMembers.map(({ threadId }) => threadId),
      memberThreadIds,
    );
    assert.ok(
      output.wait.nonterminalMembers.every(
        ({ workUnitId, transportStatus, workOutcome }) =>
          workUnitId === null &&
          transportStatus === "unavailable" &&
          workOutcome === "unknown",
      ),
    );
    assert.deepEqual([...requestedMemberIds].sort(), memberThreadIds.slice(0, 8));
    assert.ok(
      elapsedAfterFirstRead < 1500,
      `hung member collection took ${elapsedAfterFirstRead} ms`,
    );
    assert.ok(
      server.requests.every(({ method }) =>
        ["initialize", "initialized", "thread/read", "thread/turns/list"].includes(
          method,
        ),
      ),
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("nonterminal and unknown turn lifecycles stay active-safe for send and watch", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-unknown-turn-"));
  const socketPath = join(root, "app.sock");
  const thread = mockThread("queued-thread", "Queued task");
  let turnStarts = 0;
  let currentStatus = "queued";
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") return { thread };
    if (method === "thread/turns/list") {
      return { data: [{ id: "queued-turn", status: currentStatus, items: [] }] };
    }
    if (method === "turn/start") {
      turnStarts += 1;
      return { turn: { id: "unexpected-turn", status: "inProgress" } };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const common = ["--socket", socketPath, "--timeout-ms", "1000"];
  const environment = { XDG_STATE_HOME: join(root, "state") };
  try {
    for (const lifecycle of [
      { label: "queued", status: "queued" },
      { label: "pending", status: "pending" },
      { label: "object inProgress", status: { type: "inProgress" } },
      { label: "unknown future status", status: "pausedByServer" },
    ]) {
      currentStatus = lifecycle.status;
      const sent = await runAsync(
        cli,
        ["send", "queued-thread", "--prompt", "Continue", ...common],
        environment,
      );
      assert.equal(sent.status, 1, `${lifecycle.label}: ${sent.stderr}`);
      assert.match(sent.stderr, /does not have a terminal latest turn/);

      const watched = await runAsync(
        cli,
        [
          "watch",
          "queued-thread",
          "--poll-ms",
          "5",
          "--max-wait-ms",
          "25",
          ...common,
        ],
        environment,
      );
      assert.equal(watched.status, 1, `${lifecycle.label}: ${watched.stderr}`);
      assert.match(watched.stderr, /may still be running/);
      assert.equal(turnStarts, 0);
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("send rejects non-idle thread states even with empty or terminal turn data", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-thread-status-"));
  const socketPath = join(root, "app.sock");
  const thread = mockThread("active-thread", "Active task");
  let threadStatus = { type: "active" };
  let turns = [];
  let turnStarts = 0;
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") {
      return { thread: { ...thread, status: threadStatus } };
    }
    if (method === "thread/turns/list") return { data: turns };
    if (method === "turn/start") {
      turnStarts += 1;
      return { turn: { id: "unexpected-turn", status: "inProgress" } };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  const common = ["--socket", socketPath, "--timeout-ms", "1000"];
  const environment = { XDG_STATE_HOME: join(root, "state") };
  try {
    for (const scenario of [
      { label: "active with no turns", status: { type: "active" }, data: [] },
      {
        label: "system error with terminal turn",
        status: { type: "systemError" },
        data: [{ id: "old-turn", status: "completed" }],
      },
      { label: "unknown state with no turns", status: "future_state", data: [] },
    ]) {
      threadStatus = scenario.status;
      turns = scenario.data;
      const sent = await runAsync(
        cli,
        ["send", "active-thread", "--prompt", "Continue", ...common],
        environment,
      );
      assert.equal(sent.status, 1, `${scenario.label}: ${sent.stderr}`);
      assert.match(sent.stderr, /is not idle/);
    }
    assert.equal(turnStarts, 0);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("send fails closed when turn list and full-history fallback are not arrays", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-turn-array-"));
  const socketPath = join(root, "app.sock");
  let turnStarts = 0;
  const server = await startMockAppServer(socketPath, async ({ method, params }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") {
      return {
        thread: {
          ...mockThread("idle-thread", "Idle task"),
          ...(params.includeTurns ? { turns: null } : {}),
        },
      };
    }
    if (method === "thread/turns/list") return { data: null };
    if (method === "turn/start") {
      turnStarts += 1;
      return { turn: { id: "unexpected-turn", status: "inProgress" } };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  try {
    const sent = await runAsync(
      cli,
      [
        "send",
        "idle-thread",
        "--prompt",
        "Continue",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      { XDG_STATE_HOME: join(root, "state") },
    );
    assert.equal(sent.status, 1);
    assert.match(sent.stderr, /thread\/read returned no turn array/);
    assert.equal(turnStarts, 0);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("web collect fails closed without fetching full thread history", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-collect-fallback-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const webDirectory = join(stateHome, "nelos", "webs");
  await mkdir(webDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      join(webDirectory, "queen-thread.json"),
      `${JSON.stringify({
        threadId: "queen-thread",
        baseTitle: "Queen",
        outboundWebId: "A1",
        archivedAt: null,
      })}\n`,
    ),
    writeFile(
      join(webDirectory, "member-thread.json"),
      `${JSON.stringify({
        threadId: "member-thread",
        baseTitle: "Member",
        inboundWebId: "A1",
        outboundWebId: null,
        queenThreadId: "queen-thread",
        archivedAt: null,
      })}\n`,
    ),
  ]);
  const server = await startMockAppServer(socketPath, async ({ method, params }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") {
      if (params.includeTurns) throw new Error("full history must not be requested");
      return { thread: mockThread(params.threadId, "Member") };
    }
    if (method === "thread/turns/list") {
      throw new Error("bounded turn listing unsupported");
    }
    throw new Error(`unexpected method: ${method}`);
  });
  try {
    const collected = await runAsync(
      cli,
      [
        "web",
        "collect",
        "--id",
        "A1",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      { XDG_STATE_HOME: stateHome },
    );
    assert.equal(collected.status, 0, collected.stderr);
    const output = JSON.parse(collected.stdout);
    assert.equal(output.members[0].transportStatus, "unavailable");
    assert.equal(output.members[0].workOutcome, "unknown");
    assert.equal(
      server.requests.some(
        ({ method, params }) => method === "thread/read" && params.includeTurns === true,
      ),
      false,
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("web collect uses a bounded two-turn page and separates lifecycle from result source", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-collect-recovery-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const webDirectory = join(stateHome, "nelos", "webs");
  await mkdir(webDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      join(webDirectory, "queen-thread.json"),
      `${JSON.stringify({
        threadId: "queen-thread",
        baseTitle: "Queen",
        outboundWebId: "A1",
        archivedAt: null,
      })}\n`,
    ),
    writeFile(
      join(webDirectory, "member-thread.json"),
      `${JSON.stringify({
        threadId: "member-thread",
        baseTitle: "Member",
        inboundWebId: "A1",
        outboundWebId: null,
        queenThreadId: "queen-thread",
        archivedAt: null,
      })}\n`,
    ),
  ]);
  const blockedEnvelope = formatResultEnvelope({
    schemaVersion: 1,
    workUnitId: "member-work",
    specRevision: 1,
    attempt: 1,
    outcome: "blocked",
    summary: "WAITING_FOR_FIXTURE",
    artifacts: [],
    verification: [],
    blockers: ["fixture missing"],
    recoveryHint: "supply the fixture",
  });
  const server = await startMockAppServer(socketPath, async ({ method, params }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") {
      assert.equal(params.includeTurns, false);
      return { thread: mockThread(params.threadId, "Member") };
    }
    if (method === "thread/turns/list") {
      assert.deepEqual(params, {
        threadId: "member-thread",
        limit: 2,
        sortDirection: "desc",
        itemsView: "full",
      });
      return {
        data: [
          {
            id: "turn-b2",
            status: { type: "inProgress" },
            items: [
              {
                type: "agentMessage",
                phase: "commentary",
                text: "PRIVATE_RUNNING_COMMENTARY",
              },
            ],
          },
          {
            id: "turn-b1",
            status: "completed",
            items: [
              {
                type: "userMessage",
                content: [{ type: "text", text: "PRIVATE_ORIGINAL_PROMPT" }],
              },
              {
                type: "agentMessage",
                phase: "final_answer",
                text: blockedEnvelope,
              },
            ],
          },
        ],
      };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  try {
    const collected = await runAsync(
      cli,
      [
        "web",
        "collect",
        "--id",
        "A1",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      { XDG_STATE_HOME: stateHome },
    );
    assert.equal(collected.status, 0, collected.stderr);
    const output = JSON.parse(collected.stdout);
    const [member] = output.members;
    assert.equal(member.latestTurnId, "turn-b2");
    assert.equal(member.sourceTurnId, "turn-b1");
    assert.equal(member.transportStatus, "running");
    assert.equal(member.workOutcome, "blocked");
    assert.equal(member.resultState, "valid");
    assert.equal(member.result.summary, "WAITING_FOR_FIXTURE");
    assert.equal(member.attentionRequired, false);
    assert.equal(member.attentionReason, null);
    assert.deepEqual(output.summary, {
      total: 1,
      unknown: 0,
      succeeded: 0,
      blocked: 1,
      failed: 0,
      attention: 0,
    });
    assert.equal(output.allSucceeded, false);
    assert.doesNotMatch(
      JSON.stringify(output),
      /PRIVATE_RUNNING_COMMENTARY|PRIVATE_ORIGINAL_PROMPT/,
    );
    assert.equal(
      server.requests.some(
        ({ method, params: requestParams }) =>
          method === "thread/read" && requestParams.includeTurns === true,
      ),
      false,
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("title compatibility CLI remains available", () => {
  const result = run(titleCli, ["--help"]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nelos-title set TITLE/);
  assert.match(result.stdout, /nelos-title get/);
});

test("skill installer requires force for any existing content drift", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-skill-install-"));
  const target = join(root, "skills", "manage-nelos-tasks", "SKILL.md");
  try {
    const installed = await runAsync(skillInstaller, [], { CODEX_HOME: root });
    assert.equal(installed.status, 0, installed.stderr);
    const installedSkill = await readFile(target, "utf8");
    assert.match(installedSkill, /name: manage-nelos-tasks/);
    assert.deepEqual(
      JSON.parse(
        await readFile(
          join(root, "skills", "manage-nelos-tasks", "distribution-provenance.json"),
          "utf8",
        ),
      ),
      {
        ...expectedProvenance,
        skillIntegrity: `sha256:${createHash("sha256").update(installedSkill).digest("hex")}`,
      },
    );

    await writeFile(
      join(root, "skills", "manage-nelos-tasks", "distribution-provenance.json"),
      '{"schemaVersion":1,"distribution":"foreign","revision":"local"}\n',
    );
    const protectedForeignMetadata = await runAsync(skillInstaller, [], {
      CODEX_HOME: root,
    });
    assert.equal(protectedForeignMetadata.status, 1);
    assert.match(protectedForeignMetadata.stderr, /rerun with --force/);
    const repairedProvenance = await runAsync(skillInstaller, ["--force"], {
      CODEX_HOME: root,
    });
    assert.equal(repairedProvenance.status, 0, repairedProvenance.stderr);

    const oldManagedSkill = "older managed skill\n";
    await writeFile(target, oldManagedSkill);
    await writeFile(
      join(root, "skills", "manage-nelos-tasks", "distribution-provenance.json"),
      `${JSON.stringify({
        ...expectedProvenance,
        revision: "0.1.0",
        skillIntegrity: `sha256:${createHash("sha256").update(oldManagedSkill).digest("hex")}`,
      })}\n`,
    );
    const upgradedManaged = await runAsync(skillInstaller, [], { CODEX_HOME: root });
    assert.equal(upgradedManaged.status, 1);
    assert.match(upgradedManaged.stderr, /rerun with --force/);
    const forcedManagedUpgrade = await runAsync(skillInstaller, ["--force"], {
      CODEX_HOME: root,
    });
    assert.equal(forcedManagedUpgrade.status, 0, forcedManagedUpgrade.stderr);
    await writeFile(target, "hand-edited managed skill\n");
    const protectedResult = await runAsync(skillInstaller, [], { CODEX_HOME: root });
    assert.equal(protectedResult.status, 1);
    assert.match(protectedResult.stderr, /rerun with --force/);

    const replaced = await runAsync(skillInstaller, ["--force"], {
      CODEX_HOME: root,
    });
    assert.equal(replaced.status, 0, replaced.stderr);
    assert.match(await readFile(target, "utf8"), /name: manage-nelos-tasks/);
    assert.deepEqual(
      await readdir(join(root, "skills", "manage-nelos-tasks")),
      ["SKILL.md", "distribution-provenance.json"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill installer requires force when matching skill bytes lack managed provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-skill-provenance-"));
  const targetDirectory = join(root, "skills", "manage-nelos-tasks");
  try {
    const installed = await runAsync(skillInstaller, [], { CODEX_HOME: root });
    assert.equal(installed.status, 0, installed.stderr);
    await rm(join(targetDirectory, "distribution-provenance.json"));
    const protectedResult = await runAsync(skillInstaller, [], {
      CODEX_HOME: root,
    });
    assert.equal(protectedResult.status, 1);
    assert.match(protectedResult.stderr, /rerun with --force/);
    assert.match(
      await readFile(join(targetDirectory, "SKILL.md"), "utf8"),
      /name: manage-nelos-tasks/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill installer rejects symlinked ancestry without writing outside CODEX_HOME", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-skill-symlink-"));
  const codexHome = join(root, "codex-home");
  const outside = join(root, "outside");
  try {
    await mkdir(codexHome);
    await mkdir(outside);
    await writeFile(join(outside, "sentinel"), "preserve\n");
    await symlink(outside, join(codexHome, "skills"));
    const result = await runAsync(skillInstaller, ["--force"], { CODEX_HOME: codexHome });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /skill root contains a symlinked path component/);
    assert.equal(await readFile(join(outside, "sentinel"), "utf8"), "preserve\n");
    await assert.rejects(readFile(join(outside, "manage-nelos-tasks", "SKILL.md")), {
      code: "ENOENT",
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill installer recovers a crash after moving the previous directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-skill-recovery-"));
  const skillRoot = join(root, "skills");
  const targetDirectory = join(skillRoot, "manage-nelos-tasks");
  const transactionId = "recovery-fixture";
  const temporary = `${targetDirectory}.${transactionId}.tmp`;
  const backup = `${targetDirectory}.${transactionId}.backup`;
  const transactionPath = join(
    skillRoot,
    ".manage-nelos-tasks-install-transaction.json",
  );
  try {
    await mkdir(backup, { recursive: true });
    await mkdir(temporary);
    await writeFile(join(backup, "SKILL.md"), "foreign skill to restore\n");
    await writeFile(
      join(backup, "distribution-provenance.json"),
      '{"schemaVersion":1,"distribution":"foreign","revision":"local"}\n',
    );
    await writeFile(join(temporary, "SKILL.md"), "incomplete candidate\n");
    await writeFile(
      transactionPath,
      `${JSON.stringify({
        schemaVersion: 1,
        id: transactionId,
        pid: process.pid,
        startedAt: new Date(0).toISOString(),
        files: {
          "SKILL.md": sha256("incomplete candidate\n"),
          "distribution-provenance.json": sha256("missing candidate provenance\n"),
        },
        target: targetDirectory,
        temporary,
        backup,
      })}\n`,
    );
    const result = await runAsync(skillInstaller, [], { CODEX_HOME: root });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rerun with --force/);
    assert.equal(await readFile(join(targetDirectory, "SKILL.md"), "utf8"), "foreign skill to restore\n");
    await assert.rejects(readFile(transactionPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill installer does not recover another live installer transaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-skill-concurrent-"));
  const skillRoot = join(root, "skills");
  const targetDirectory = join(skillRoot, "manage-nelos-tasks");
  const transactionId = "live-fixture";
  const temporary = `${targetDirectory}.${transactionId}.tmp`;
  const backup = `${targetDirectory}.${transactionId}.backup`;
  const transactionPath = join(
    skillRoot,
    ".manage-nelos-tasks-install-transaction.json",
  );
  try {
    await mkdir(temporary, { recursive: true });
    await writeFile(join(temporary, "sentinel"), "preserve\n");
    await writeFile(
      transactionPath,
      `${JSON.stringify({
        schemaVersion: 1,
        id: transactionId,
        pid: process.pid,
        processIdentity: { "pid-only": String(process.pid) },
        startedAt: new Date(0).toISOString(),
        files: {
          "SKILL.md": sha256("live candidate\n"),
          "distribution-provenance.json": sha256("live provenance\n"),
        },
        target: targetDirectory,
        temporary,
        backup,
      })}\n`,
    );
    const result = await runAsync(skillInstaller, [], { CODEX_HOME: root });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /another manage-nelos-tasks skill installation is active/);
    assert.equal(await readFile(join(temporary, "sentinel"), "utf8"), "preserve\n");
    assert.equal(JSON.parse(await readFile(transactionPath, "utf8")).pid, process.pid);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("strong process identity prevents reclaim after the heartbeat lease", async (t) => {
  const activeIdentity = await readProcessIdentity(process.pid);
  if (
    !Object.keys(activeIdentity ?? {}).some((kind) => kind !== "pid-only")
  ) {
    t.skip("this platform exposes no strong process identity");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "nelos-skill-strong-owner-"));
  const skillRoot = join(root, "skills");
  const targetDirectory = join(skillRoot, "manage-nelos-tasks");
  const transactionId = "strong-owner-fixture";
  const temporary = `${targetDirectory}.${transactionId}.tmp`;
  const backup = `${targetDirectory}.${transactionId}.backup`;
  const transactionPath = join(
    skillRoot,
    ".manage-nelos-tasks-install-transaction.json",
  );
  try {
    await mkdir(temporary, { recursive: true });
    await writeFile(join(temporary, "sentinel"), "preserve\n");
    await writeFile(
      transactionPath,
      `${JSON.stringify({
        schemaVersion: 1,
        id: transactionId,
        pid: process.pid,
        processIdentity: activeIdentity,
        startedAt: new Date(0).toISOString(),
        files: {
          "SKILL.md": sha256("live candidate\n"),
          "distribution-provenance.json": sha256("live provenance\n"),
        },
        target: targetDirectory,
        temporary,
        backup,
      })}\n`,
    );
    await utimes(transactionPath, new Date(0), new Date(0));

    const result = await runAsync(skillInstaller, [], { CODEX_HOME: root });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /another manage-nelos-tasks skill installation is active/);
    assert.equal(await readFile(join(temporary, "sentinel"), "utf8"), "preserve\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill installer distinguishes PID reuse within the active window", async (t) => {
  const activeIdentity = await readProcessIdentity(process.pid);
  const recordedIdentity = Object.fromEntries(
    Object.entries(activeIdentity ?? {})
      .filter(([kind]) => kind !== "pid-only")
      .map(([kind, value]) => [kind, `reused:${value}`]),
  );
  if (Object.keys(recordedIdentity).length === 0) {
    t.skip("this platform exposes no strong process identity");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "nelos-skill-pid-reuse-"));
  const skillRoot = join(root, "skills");
  const targetDirectory = join(skillRoot, "manage-nelos-tasks");
  const transactionId = "pid-reuse-fixture";
  const temporary = `${targetDirectory}.${transactionId}.tmp`;
  const backup = `${targetDirectory}.${transactionId}.backup`;
  const transactionPath = join(
    skillRoot,
    ".manage-nelos-tasks-install-transaction.json",
  );
  try {
    await mkdir(backup, { recursive: true });
    await mkdir(temporary);
    await writeFile(join(backup, "SKILL.md"), "foreign skill to restore\n");
    await writeFile(
      join(backup, "distribution-provenance.json"),
      '{"schemaVersion":1,"distribution":"foreign","revision":"local"}\n',
    );
    await writeFile(
      transactionPath,
      `${JSON.stringify({
        schemaVersion: 1,
        id: transactionId,
        pid: process.pid,
        processIdentity: recordedIdentity,
        startedAt: new Date().toISOString(),
        files: {
          "SKILL.md": sha256("incomplete candidate\n"),
          "distribution-provenance.json": sha256("incomplete provenance\n"),
        },
        target: targetDirectory,
        temporary,
        backup,
      })}\n`,
    );
    const result = await runAsync(skillInstaller, [], { CODEX_HOME: root });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rerun with --force/);
    assert.equal(
      await readFile(join(targetDirectory, "SKILL.md"), "utf8"),
      "foreign skill to restore\n",
    );
    await assert.rejects(readFile(transactionPath), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("skill recovery preserves the crashed transaction candidate across package upgrades", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-skill-intent-"));
  const skillRoot = join(root, "skills");
  const targetDirectory = join(skillRoot, "manage-nelos-tasks");
  const transactionId = "intent-fixture";
  const temporary = `${targetDirectory}.${transactionId}.tmp`;
  const backup = `${targetDirectory}.${transactionId}.backup`;
  const transactionPath = join(
    skillRoot,
    ".manage-nelos-tasks-install-transaction.json",
  );
  const candidateSkill = "completed older candidate\n";
  const candidateProvenance =
    '{"schemaVersion":1,"distribution":"nelos","revision":"older"}\n';
  try {
    await mkdir(targetDirectory, { recursive: true });
    await mkdir(backup);
    await writeFile(join(targetDirectory, "SKILL.md"), candidateSkill);
    await writeFile(
      join(targetDirectory, "distribution-provenance.json"),
      candidateProvenance,
    );
    await writeFile(join(backup, "SKILL.md"), "stale backup\n");
    await writeFile(
      join(backup, "distribution-provenance.json"),
      "stale backup provenance\n",
    );
    await writeFile(
      transactionPath,
      `${JSON.stringify({
        schemaVersion: 1,
        id: transactionId,
        pid: 999_999_999,
        startedAt: new Date(0).toISOString(),
        files: {
          "SKILL.md": sha256(candidateSkill),
          "distribution-provenance.json": sha256(candidateProvenance),
        },
        target: targetDirectory,
        temporary,
        backup,
      })}\n`,
    );
    const result = await runAsync(skillInstaller, [], { CODEX_HOME: root });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /rerun with --force/);
    assert.equal(
      await readFile(join(targetDirectory, "SKILL.md"), "utf8"),
      candidateSkill,
    );
    await assert.rejects(readFile(join(backup, "SKILL.md")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("unknown commands fail before connecting to app-server", () => {
  const result = run(cli, ["not-a-command"]);

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown command: not-a-command/);
});

test("start sends a current app-server named permission profile and validates it first", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-permissions-"));
  const socketPath = join(root, "app.sock");
  const thread = mockThread("permission-thread", "Permission task");
  const server = await startMockAppServer(socketPath, async ({ method, params }) => {
    if (method === "initialize") {
      assert.equal(
        params.capabilities.experimentalApi,
        permissionProfileProtocol.initializeCapabilities.experimentalApi,
      );
      return {};
    }
    if (method === permissionProfileProtocol.profileList.method) {
      assert.equal(params.cwd, root);
      return permissionProfileProtocol.profileList.result;
    }
    if (method === "thread/start") return { thread };
    if (method === "thread/name/set") return {};
    if (method === "thread/read") return { thread };
    if (method === "turn/start") {
      return { turn: { id: "permission-turn", status: "inProgress" } };
    }
    if (method === "thread/turns/list") {
      return { data: [{ id: "permission-turn", status: "inProgress" }] };
    }
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const result = await runAsync(
      cli,
      [
        "start",
        "--title",
        "Permission task",
        "--prompt",
        "Do the work",
        "--cwd",
        root,
        "--permissions",
        permissionProfileProtocol.profileId,
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      { XDG_STATE_HOME: join(root, "state") },
    );

    assert.equal(result.status, 0, result.stderr);
    const profileList = server.requests.find(
      ({ method }) => method === permissionProfileProtocol.profileList.method,
    );
    const threadStart = server.requests.find(({ method }) => method === "thread/start");
    const turnStart = server.requests.find(({ method }) => method === "turn/start");
    assert.ok(profileList);
    assert.ok(threadStart);
    assert.ok(turnStart);
    assert.ok(server.requests.indexOf(profileList) < server.requests.indexOf(threadStart));
    for (const [request, fixture] of [
      [threadStart, permissionProfileProtocol.threadStart],
      [turnStart, permissionProfileProtocol.turnStart],
    ]) {
      assert.equal(
        request.params[fixture.permissionsField],
        permissionProfileProtocol.profileId,
      );
      assert.equal(
        typeof request.params[fixture.permissionsField],
        fixture.permissionsType,
      );
      assert.equal(Object.hasOwn(request.params, fixture.forbiddenField), false);
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("spinoff permission profile rejection happens before any task or web mutation", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-permissions-rejected-"));
  const socketPath = join(root, "app.sock");
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    if (method === permissionProfileProtocol.profileList.method) return { data: [] };
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const result = await runAsync(
      cli,
      [
        "spinoff",
        "--title",
        "Permission task",
        "--prompt",
        "Do the work",
        "--cwd",
        root,
        "--permissions",
        permissionProfileProtocol.profileId,
        "--queen-thread-id",
        "queen-thread",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      { XDG_STATE_HOME: join(root, "state") },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /named permission profile is unavailable: task-orchestrator/);
    assert.equal(server.requests.some(({ method }) => method === "thread/start"), false);
    assert.equal(server.requests.some(({ method }) => method === "thread/name/set"), false);
    assert.equal(server.requests.some(({ method }) => method === "thread/read"), false);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("start rejects conflicting named permissions and sandbox before creating a task", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-permissions-conflict-"));
  const socketPath = join(root, "app.sock");
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const result = await runAsync(
      cli,
      [
        "start",
        "--title",
        "Permission task",
        "--prompt",
        "Do the work",
        "--cwd",
        root,
        "--permissions",
        permissionProfileProtocol.profileId,
        "--sandbox",
        "read-only",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      { XDG_STATE_HOME: join(root, "state") },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /--permissions cannot be combined with --sandbox/);
    assert.equal(server.requests.some(({ method }) => method === "thread/start"), false);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("start sends a bare text input item and surfaces the initialize identity fields", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-identity-"));
  const socketPath = join(root, "app.sock");
  const thread = mockThread("identity-thread", "Identity task");
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") {
      return {
        userAgent: "codex-cli/0.144.6",
        platformFamily: "darwin",
        platformOs: "macos",
      };
    }
    if (method === "thread/start") return { thread };
    if (method === "thread/name/set") return {};
    if (method === "thread/read") return { thread };
    if (method === "turn/start") {
      return { turn: { id: "identity-turn", status: "inProgress" } };
    }
    if (method === "thread/turns/list") {
      return { data: [{ id: "identity-turn", status: "inProgress" }] };
    }
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const result = await runAsync(
      cli,
      [
        "start",
        "--title",
        "Identity task",
        "--prompt",
        "Do the work",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      { XDG_STATE_HOME: join(root, "state") },
    );

    assert.equal(result.status, 0, result.stderr);
    const turnStart = server.requests.find(({ method }) => method === "turn/start");
    assert.deepEqual(turnStart.params.input, [{ type: "text", text: "Do the work" }]);

    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.serverIdentity, {
      userAgent: "codex-cli/0.144.6",
      platformFamily: "darwin",
      platformOs: "macos",
    });
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("start archives a new thread when the initial turn fails", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-cleanup-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const thread = mockThread("orphan-thread", "Cleanup task");
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    if (method === "thread/start") return { thread };
    if (method === "thread/name/set") return {};
    if (method === "thread/read") return { thread };
    if (method === "turn/start") throw new Error("turn start failed");
    if (method === "thread/archive") return {};
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const result = await runAsync(
      cli,
      [
        "start",
        "--title",
        "Cleanup task",
        "--prompt",
        "Do the work",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      { XDG_STATE_HOME: stateHome },
    );

    assert.equal(result.status, 1);
    assert.match(result.stderr, /turn start failed/);
    assert.ok(server.requests.some(({ method }) => method === "thread/archive"));
    const record = JSON.parse(
      await readFile(
        join(stateHome, "nelos", "tasks", "orphan-thread.json"),
        "utf8",
      ),
    );
    assert.equal(record.threadId, "orphan-thread");
    assert.equal(typeof record.archivedAt, "string");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("web begin and join render nested queen relationships", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-web-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const threads = new Map([
    ["queen-thread", mockThread("queen-thread", "👑 · Release planning")],
    ["member-thread", mockThread("member-thread", "👑 · API changes")],
  ]);
  const server = await startMockAppServer(socketPath, async ({ method, params }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") return { thread: threads.get(params.threadId) };
    if (method === "thread/name/set") {
      threads.get(params.threadId).name = params.name;
      return {};
    }
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const common = {
      XDG_STATE_HOME: stateHome,
      CODEX_THREAD_ID: "queen-thread",
    };
    const queenResult = await runAsync(
      cli,
      ["web", "begin", "--socket", socketPath, "--timeout-ms", "1000"],
      common,
    );
    assert.equal(queenResult.status, 0, queenResult.stderr);
    const queenOutput = JSON.parse(queenResult.stdout);
    assert.equal(queenOutput.webId, "A1");
    assert.equal(queenOutput.webMemberTitlePrefix, "🕷️ A1 ·");
    assert.match(
      queenOutput.joinCommand,
      /--queen-thread-id queen-thread$/,
    );
    assert.equal(
      threads.get("queen-thread").name,
      "👑 A1 · Release planning",
    );
    const queenWebRecord = JSON.parse(
      await readFile(
        join(stateHome, "nelos", "webs", "queen-thread.json"),
        "utf8",
      ),
    );
    assert.equal(queenWebRecord.baseTitle, "Release planning");
    assert.equal(queenWebRecord.queenMarked, true);

    const joinResult = await runAsync(
      cli,
      [
        "web",
        "join",
        "--id",
        "A1",
        "--title",
        "API changes",
        "--queen-thread-id",
        "queen-thread",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      {
        XDG_STATE_HOME: stateHome,
        CODEX_THREAD_ID: "member-thread",
      },
    );
    assert.equal(joinResult.status, 0, joinResult.stderr);
    assert.equal(JSON.parse(joinResult.stdout).queenThreadId, "queen-thread");
    assert.equal(
      threads.get("member-thread").name,
      "👑 🕷️ A1 · API changes",
    );
    const joinedWebRecord = JSON.parse(
      await readFile(
        join(stateHome, "nelos", "webs", "member-thread.json"),
        "utf8",
      ),
    );
    assert.equal(joinedWebRecord.baseTitle, "API changes");
    assert.equal(joinedWebRecord.queenMarked, true);

    const nestedResult = await runAsync(
      cli,
      ["web", "begin", "--socket", socketPath, "--timeout-ms", "1000"],
      {
        XDG_STATE_HOME: stateHome,
        CODEX_THREAD_ID: "member-thread",
      },
    );
    assert.equal(nestedResult.status, 0, nestedResult.stderr);
    assert.equal(JSON.parse(nestedResult.stdout).webId, "A1.1");
    assert.equal(
      threads.get("member-thread").name,
      "👑 A1.1 🕷️ A1 · API changes",
    );
    const nestedRecordPath = join(
      stateHome,
      "nelos",
      "webs",
      "member-thread.json",
    );
    const nestedRecord = JSON.parse(
      await readFile(nestedRecordPath, "utf8"),
    );
    await writeFile(
      nestedRecordPath,
      `${JSON.stringify({ ...nestedRecord, queenMarked: false })}\n`,
    );
    threads.get("member-thread").name =
      "🕸️ A1 🕷️ A1.1 · API changes";

    const titleResult = await runAsync(
      cli,
      [
        "title",
        "set",
        "API implementation",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      {
        XDG_STATE_HOME: stateHome,
        CODEX_THREAD_ID: "member-thread",
      },
    );
    assert.equal(titleResult.status, 0, titleResult.stderr);
    assert.equal(
      threads.get("member-thread").name,
      "👑 A1.1 🕷️ A1 · API implementation",
    );
    const mainTitleRecord = JSON.parse(
      await readFile(
        join(stateHome, "nelos", "webs", "member-thread.json"),
        "utf8",
      ),
    );
    assert.equal(mainTitleRecord.baseTitle, "API implementation");
    assert.equal(mainTitleRecord.queenMarked, true);

    const compatibilityTitleResult = await runAsync(
      titleCli,
      [
        "set",
        "API delivery",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      {
        XDG_STATE_HOME: stateHome,
        CODEX_THREAD_ID: "member-thread",
      },
    );
    assert.equal(
      compatibilityTitleResult.status,
      0,
      compatibilityTitleResult.stderr,
    );
    assert.equal(
      threads.get("member-thread").name,
      "👑 A1.1 🕷️ A1 · API delivery",
    );
    const compatibilityTitleRecord = JSON.parse(
      await readFile(
        join(stateHome, "nelos", "webs", "member-thread.json"),
        "utf8",
      ),
    );
    assert.equal(compatibilityTitleRecord.baseTitle, "API delivery");
    assert.equal(compatibilityTitleRecord.queenMarked, true);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("both title CLIs preserve a live MCP crown without a web record", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-title-live-crown-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const threads = new Map([
    ["main-crown", mockThread("main-crown", "👑 · MCP queen")],
    ["compat-crown", mockThread("compat-crown", "👑 · Compatibility queen")],
    ["revived-plain", mockThread("revived-plain", "Previously archived")],
  ]);
  const server = await startMockAppServer(socketPath, async ({ method, params }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") return { thread: threads.get(params.threadId) };
    if (method === "thread/name/set") {
      threads.get(params.threadId).name = params.name;
      return {};
    }
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const archivedWebDirectory = join(stateHome, "nelos", "webs");
    await mkdir(archivedWebDirectory, { recursive: true });
    await writeFile(
      join(archivedWebDirectory, "revived-plain.json"),
      `${JSON.stringify({
        threadId: "revived-plain",
        baseTitle: "Old queen",
        inboundWebId: null,
        outboundWebId: "A9",
        queenMarked: true,
        queenThreadId: null,
        renderedTitle: "🕷️ A9 👑 · Old queen",
        createdAt: "2026-07-24T00:00:00.000Z",
        updatedAt: "2026-07-24T00:00:00.000Z",
        archivedAt: "2026-07-24T01:00:00.000Z",
      })}\n`,
    );

    const main = await runAsync(
      cli,
      [
        "title",
        "set",
        "Renamed main queen",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      {
        XDG_STATE_HOME: stateHome,
        CODEX_THREAD_ID: "main-crown",
      },
    );
    assert.equal(main.status, 0, main.stderr);
    assert.equal(threads.get("main-crown").name, "👑 · Renamed main queen");
    assert.equal(JSON.parse(main.stdout).liveTitle, "👑 · Renamed main queen");

    const compatibility = await runAsync(
      titleCli,
      [
        "set",
        "Renamed compatibility queen",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      {
        XDG_STATE_HOME: stateHome,
        CODEX_THREAD_ID: "compat-crown",
      },
    );
    assert.equal(compatibility.status, 0, compatibility.stderr);
    assert.equal(
      threads.get("compat-crown").name,
      "👑 · Renamed compatibility queen",
    );
    assert.equal(
      JSON.parse(compatibility.stdout).liveTitle,
      "👑 · Renamed compatibility queen",
    );

    const revived = await runAsync(
      cli,
      [
        "title",
        "set",
        "Revived plain task",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      {
        XDG_STATE_HOME: stateHome,
        CODEX_THREAD_ID: "revived-plain",
      },
    );
    assert.equal(revived.status, 0, revived.stderr);
    assert.equal(threads.get("revived-plain").name, "Revived plain task");
    const retainedArchivedWeb = JSON.parse(
      await readFile(
        join(archivedWebDirectory, "revived-plain.json"),
        "utf8",
      ),
    );
    assert.equal(retainedArchivedWeb.archivedAt, "2026-07-24T01:00:00.000Z");
    assert.equal(retainedArchivedWeb.renderedTitle, "🕷️ A9 👑 · Old queen");

    for (const threadId of [
      "main-crown",
      "compat-crown",
      "revived-plain",
    ]) {
      const methods = server.requests
        .filter(({ params }) => params?.threadId === threadId)
        .map(({ method }) => method);
      assert.deepEqual(methods, [
        "thread/read",
        "thread/name/set",
        "thread/read",
      ]);
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("both title CLIs reject archived tasks before sending a rename", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-title-archived-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const mainThread = {
    ...mockThread("archived-main", "Original main title"),
    status: { type: "archived" },
  };
  const compatibilityThread = {
    ...mockThread("archived-compatibility", "Original compatibility title"),
    archived: true,
  };
  const threads = new Map([
    [mainThread.id, mainThread],
    [compatibilityThread.id, compatibilityThread],
  ]);
  const server = await startMockAppServer(socketPath, async ({ method, params }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") return { thread: threads.get(params.threadId) };
    if (method === "thread/name/set") {
      threads.get(params.threadId).name = params.name;
      return {};
    }
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const main = await runAsync(
      cli,
      [
        "title",
        "set",
        "Mutated main title",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      {
        XDG_STATE_HOME: stateHome,
        CODEX_THREAD_ID: mainThread.id,
      },
    );
    assert.equal(main.status, 1);
    assert.match(main.stderr, /archived and cannot be renamed/);

    const compatibility = await runAsync(
      titleCli,
      [
        "set",
        "Mutated compatibility title",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      {
        XDG_STATE_HOME: stateHome,
        CODEX_THREAD_ID: compatibilityThread.id,
      },
    );
    assert.equal(compatibility.status, 1);
    assert.match(compatibility.stderr, /archived and cannot be renamed/);

    assert.equal(mainThread.name, "Original main title");
    assert.equal(compatibilityThread.name, "Original compatibility title");
    assert.equal(
      server.requests.some(({ method }) => method === "thread/name/set"),
      false,
    );
    for (const threadId of [mainThread.id, compatibilityThread.id]) {
      assert.deepEqual(
        server.requests
          .filter(({ params }) => params?.threadId === threadId)
          .map(({ method }) => method),
        ["thread/read"],
      );
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("registry-only web setup supports desktop-native task creation without a socket", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-native-web-"));
  const stateHome = join(root, "state");

  try {
    const queenResult = await runAsync(
      cli,
      ["web", "begin", "--title", "Desktop queen", "--registry-only"],
      {
        XDG_STATE_HOME: stateHome,
        CODEX_HOME: join(root, "codex-home-without-a-socket"),
        CODEX_THREAD_ID: "native-queen",
      },
    );
    assert.equal(queenResult.status, 0, queenResult.stderr);
    const queen = JSON.parse(queenResult.stdout);
    assert.equal(queen.webId, "A1");
    assert.equal(queen.renderedTitle, "👑 A1 · Desktop queen");
    assert.equal(queen.baseTitle, "Desktop queen");
    assert.equal(queen.queenMarked, true);
    assert.equal(queen.titleVerified, false);
    assert.equal(queen.requiresNativeTitleSync, true);
    assert.match(queen.joinCommand, /--registry-only$/);

    const memberResult = await runAsync(
      cli,
      [
        "web",
        "join",
        "--id",
        "A1",
        "--title",
        "Desktop member",
        "--queen-thread-id",
        "native-queen",
        "--thread-id",
        "native-member",
        "--registry-only",
      ],
      {
        XDG_STATE_HOME: stateHome,
        CODEX_HOME: join(root, "codex-home-without-a-socket"),
      },
    );
    assert.equal(memberResult.status, 0, memberResult.stderr);
    const member = JSON.parse(memberResult.stdout);
    assert.equal(member.renderedTitle, "🕷️ A1 · Desktop member");
    assert.equal(member.queenThreadId, "native-queen");
    assert.equal(member.titleVerified, false);

    const stored = JSON.parse(
      await readFile(
        join(stateHome, "nelos", "webs", "native-member.json"),
        "utf8",
      ),
    );
    assert.equal(stored.inboundWebId, "A1");
    assert.equal(stored.queenThreadId, "native-queen");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a live read reconciles stale archival cache with the app server", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-live-reconcile-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const taskDirectory = join(stateHome, "nelos", "tasks");
  const webDirectory = join(stateHome, "nelos", "webs");
  await mkdir(taskDirectory, { recursive: true });
  await mkdir(webDirectory, { recursive: true });
  await writeFile(
    join(taskDirectory, "member.json"),
    JSON.stringify({
      threadId: "member",
      title: "Cached member",
      archivedAt: "2026-07-01T00:00:00.000Z",
    }),
  );
  await writeFile(
    join(webDirectory, "member.json"),
    JSON.stringify({
      threadId: "member",
      baseTitle: "Cached member",
      inboundWebId: "A1",
      outboundWebId: null,
      archivedAt: "2026-07-01T00:00:00.000Z",
    }),
  );
  const thread = mockThread("member", "Live member");
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") return { thread };
    if (method === "thread/turns/list") return { data: [] };
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const result = await runAsync(
      cli,
      ["status", "member", "--socket", socketPath, "--timeout-ms", "1000"],
      { XDG_STATE_HOME: stateHome },
    );
    assert.equal(result.status, 0, result.stderr);

    const taskRecord = JSON.parse(
      await readFile(join(taskDirectory, "member.json"), "utf8"),
    );
    const webRecord = JSON.parse(
      await readFile(join(webDirectory, "member.json"), "utf8"),
    );
    for (const record of [taskRecord, webRecord]) {
      assert.equal(record.archivedAt, null);
      assert.equal(record.lifecycleObservation.source, "app-server");
      assert.equal(record.lifecycleObservation.disposition, "active");
      assert.ok(record.lifecycleObservation.freshUntil > record.lifecycleObservation.observedAt);
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a live archived observation becomes the local cache's archival state", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-archive-reconcile-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const webDirectory = join(stateHome, "nelos", "webs");
  await mkdir(webDirectory, { recursive: true });
  await writeFile(
    join(webDirectory, "member.json"),
    JSON.stringify({
      threadId: "member",
      baseTitle: "Member",
      inboundWebId: "A1",
      outboundWebId: null,
      archivedAt: null,
    }),
  );
  const thread = {
    ...mockThread("member", "Archived member"),
    status: { type: "archived" },
  };
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") return { thread };
    if (method === "thread/turns/list") return { data: [] };
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const result = await runAsync(
      cli,
      ["status", "member", "--socket", socketPath, "--timeout-ms", "1000"],
      { XDG_STATE_HOME: stateHome },
    );
    assert.equal(result.status, 0, result.stderr);

    const record = JSON.parse(
      await readFile(join(webDirectory, "member.json"), "utf8"),
    );
    assert.equal(record.lifecycleObservation.disposition, "archived");
    assert.equal(record.archivedAt, record.lifecycleObservation.observedAt);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("an unavailable read expires cache freshness without inventing lifecycle state", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-unavailable-reconcile-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const webDirectory = join(stateHome, "nelos", "webs");
  await mkdir(webDirectory, { recursive: true });
  await writeFile(
    join(webDirectory, "member.json"),
    JSON.stringify({
      threadId: "member",
      baseTitle: "Member",
      inboundWebId: "A1",
      archivedAt: null,
      lifecycleObservation: {
        schemaVersion: 1,
        source: "app-server",
        disposition: "active",
        observedAt: "2026-07-20T00:00:00.000Z",
        freshUntil: "2030-07-20T00:00:00.000Z",
        threadStatus: "idle",
      },
    }),
  );
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") throw new Error("server unavailable");
    if (method === "thread/turns/list") return { data: [] };
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const result = await runAsync(
      cli,
      ["status", "member", "--socket", socketPath, "--timeout-ms", "1000"],
      { XDG_STATE_HOME: stateHome },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /server unavailable/);

    const record = JSON.parse(
      await readFile(join(webDirectory, "member.json"), "utf8"),
    );
    assert.equal(record.lifecycleObservation.disposition, "active");
    assert.equal(record.lifecycleObservation.observedAt, "2026-07-20T00:00:00.000Z");
    assert.equal(record.lifecycleObservation.freshUntil, record.lifecycleObservation.lastUnavailableAt);
    assert.equal(record.archivedAt, null);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a read that started before archive cannot regress the confirmed archive cache", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-archive-fence-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const webDirectory = join(stateHome, "nelos", "webs");
  await mkdir(webDirectory, { recursive: true });
  await writeFile(
    join(webDirectory, "member.json"),
    JSON.stringify({
      threadId: "member",
      baseTitle: "Member",
      inboundWebId: "A1",
      archivedAt: null,
    }),
  );
  let threadReads = 0;
  let releaseFirstRead;
  const firstReadStarted = new Promise((resolvePromise) => {
    releaseFirstRead = resolvePromise;
  });
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") {
      threadReads += 1;
      if (threadReads === 1) {
        releaseFirstRead();
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
      }
      return { thread: mockThread("member", "Member") };
    }
    if (method === "thread/turns/list") return { data: [] };
    if (method === "thread/archive") return {};
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const delayedStatus = runAsync(
      cli,
      ["status", "member", "--socket", socketPath, "--timeout-ms", "1000"],
      { XDG_STATE_HOME: stateHome },
    );
    await firstReadStarted;
    const archive = await runAsync(
      cli,
      ["archive", "member", "--socket", socketPath, "--timeout-ms", "1000"],
      { XDG_STATE_HOME: stateHome },
    );
    assert.equal(archive.status, 0, archive.stderr);
    const status = await delayedStatus;
    assert.equal(status.status, 0, status.stderr);

    const record = JSON.parse(
      await readFile(join(webDirectory, "member.json"), "utf8"),
    );
    assert.equal(record.lifecycleObservation.disposition, "archived");
    assert.equal(record.archivedAt, record.lifecycleObservation.observedAt);
    assert.equal(record.lifecycleObservation.sourceEffectAt, record.archivedAt);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("archive rejects retired registry-only lifecycle writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-registry-archive-socket-"));
  const stateHome = join(root, "state");

  try {
    const result = await runAsync(
      cli,
      ["archive", "some-thread", "--registry-only"],
      {
        XDG_STATE_HOME: stateHome,
        CODEX_HOME: join(root, "codex-home-without-a-socket"),
      },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /archive --registry-only was retired/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a revived archived task allocates a fresh web ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-web-revive-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const threads = new Map([
    ["old-thread", mockThread("old-thread", "Old queen")],
    ["new-thread", mockThread("new-thread", "New queen")],
  ]);
  const server = await startMockAppServer(socketPath, async ({ method, params }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") return { thread: threads.get(params.threadId) };
    if (method === "thread/name/set") {
      threads.get(params.threadId).name = params.name;
      return {};
    }
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const begin = (threadId) =>
      runAsync(
        cli,
        ["web", "begin", "--socket", socketPath, "--timeout-ms", "1000"],
        { XDG_STATE_HOME: stateHome, CODEX_THREAD_ID: threadId },
      );
    const first = await begin("old-thread");
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).webId, "A1");

    const oldRecordPath = join(
      stateHome,
      "nelos",
      "webs",
      "old-thread.json",
    );
    const oldRecord = JSON.parse(await readFile(oldRecordPath, "utf8"));
    await writeFile(
      oldRecordPath,
      `${JSON.stringify({ ...oldRecord, archivedAt: new Date().toISOString() })}\n`,
    );

    const replacement = await begin("new-thread");
    assert.equal(replacement.status, 0, replacement.stderr);
    assert.equal(JSON.parse(replacement.stdout).webId, "A1");

    const revived = await begin("old-thread");
    assert.equal(revived.status, 0, revived.stderr);
    assert.equal(JSON.parse(revived.stdout).webId, "A2");
    assert.equal(threads.get("old-thread").name, "👑 A2 · Old queen");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("spinoff marks the queen and reuses its web for durable tasks", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-spinoff-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const threads = new Map([
    ["queen-thread", mockThread("queen-thread", "Release planning")],
  ]);
  let spinoffNumber = 0;
  const server = await startMockAppServer(socketPath, async ({ method, params }) => {
    if (method === "initialize") return {};
    if (method === "thread/start") {
      spinoffNumber += 1;
      const thread = mockThread(`spinoff-${spinoffNumber}`, null);
      threads.set(thread.id, thread);
      return { thread };
    }
    if (method === "thread/read") return { thread: threads.get(params.threadId) };
    if (method === "thread/name/set") {
      threads.get(params.threadId).name = params.name;
      return {};
    }
    if (method === "turn/start") {
      return { turn: { id: `turn-${params.threadId}`, status: "inProgress" } };
    }
    if (method === "thread/turns/list") {
      return {
        data: [{ id: `turn-${params.threadId}`, status: "interrupted" }],
      };
    }
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const launch = (title) =>
      runAsync(
        cli,
        [
          "spinoff",
          "--title",
          title,
          "--prompt",
          "Do the work",
          "--socket",
          socketPath,
          "--timeout-ms",
          "1000",
        ],
        {
          XDG_STATE_HOME: stateHome,
          CODEX_THREAD_ID: "queen-thread",
        },
      );

    const [first, second] = await Promise.all([
      launch("API changes"),
      launch("Documentation"),
    ]);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(
      threads.get("queen-thread").name,
      "👑 A1 · Release planning",
    );
    assert.deepEqual(
      [threads.get("spinoff-1").name, threads.get("spinoff-2").name].sort(),
      ["🕷️ A1 · API changes", "🕷️ A1 · Documentation"].sort(),
    );

    const output = JSON.parse(first.stdout);
    assert.equal(output.command, "spinoff");
    assert.equal(output.spinoff.webId, "A1");
    assert.equal(output.latestTurn.id, output.turnId);
    assert.equal(output.latestTurn.status, "inProgress");
    assert.deepEqual(output.status, { type: "active", activeFlags: [] });
    assert.equal(
      server.requests.some(({ method }) => method === "thread/turns/list"),
      false,
    );
    const record = JSON.parse(
      await readFile(
        join(stateHome, "nelos", "tasks", `${output.threadId}.json`),
        "utf8",
      ),
    );
    assert.equal(record.baseTitle, "API changes");
    assert.deepEqual(record.web, {
      queenThreadId: "queen-thread",
      inboundWebId: "A1",
      outboundWebId: null,
    });
    const queenRecord = JSON.parse(
      await readFile(
        join(stateHome, "nelos", "webs", "queen-thread.json"),
        "utf8",
      ),
    );
    assert.equal(queenRecord.baseTitle, "Release planning");
    assert.equal(queenRecord.queenMarked, true);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a spinoff can become queen of a nested web", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-nested-spinoff-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const threads = new Map([
    ["queen-thread", mockThread("queen-thread", "Release planning")],
  ]);
  let spinoffNumber = 0;
  const server = await startMockAppServer(socketPath, async ({ method, params }) => {
    if (method === "initialize") return {};
    if (method === "thread/start") {
      spinoffNumber += 1;
      const thread = mockThread(`spinoff-${spinoffNumber}`, null);
      threads.set(thread.id, thread);
      return { thread };
    }
    if (method === "thread/read") return { thread: threads.get(params.threadId) };
    if (method === "thread/name/set") {
      threads.get(params.threadId).name = params.name;
      return {};
    }
    if (method === "turn/start") {
      return { turn: { id: `turn-${params.threadId}`, status: "inProgress" } };
    }
    if (method === "thread/turns/list") {
      return {
        data: [{ id: `turn-${params.threadId}`, status: "inProgress" }],
      };
    }
    throw new Error(`unexpected method: ${method}`);
  });

  const launch = (queenThreadId, title) =>
    runAsync(
      cli,
      [
        "spinoff",
        "--title",
        title,
        "--prompt",
        "Do the work",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      { XDG_STATE_HOME: stateHome, CODEX_THREAD_ID: queenThreadId },
    );

  try {
    const first = await launch("queen-thread", "API changes");
    assert.equal(first.status, 0, first.stderr);

    const nested = await launch("spinoff-1", "Contract tests");
    assert.equal(nested.status, 0, nested.stderr);
    assert.equal(
      threads.get("queen-thread").name,
      "👑 A1 · Release planning",
    );
    assert.equal(
      threads.get("spinoff-1").name,
      "👑 A1.1 🕷️ A1 · API changes",
    );
    assert.equal(threads.get("spinoff-2").name, "🕷️ A1.1 · Contract tests");

    const output = JSON.parse(nested.stdout);
    assert.deepEqual(output.spinoff, {
      queenThreadId: "spinoff-1",
      queenTitle: "👑 A1.1 🕷️ A1 · API changes",
      webId: "A1.1",
    });
    const nestedQueenWeb = JSON.parse(
      await readFile(
        join(stateHome, "nelos", "webs", "spinoff-1.json"),
        "utf8",
      ),
    );
    const nestedQueenTask = JSON.parse(
      await readFile(
        join(stateHome, "nelos", "tasks", "spinoff-1.json"),
        "utf8",
      ),
    );
    const expectedNestedQueenWeb = {
      queenThreadId: "queen-thread",
      inboundWebId: "A1",
      outboundWebId: "A1.1",
    };
    assert.deepEqual(
      {
        queenThreadId: nestedQueenWeb.queenThreadId,
        inboundWebId: nestedQueenWeb.inboundWebId,
        outboundWebId: nestedQueenWeb.outboundWebId,
      },
      expectedNestedQueenWeb,
    );
    assert.deepEqual(nestedQueenTask.web, expectedNestedQueenWeb);
    const record = JSON.parse(
      await readFile(
        join(stateHome, "nelos", "webs", "spinoff-2.json"),
        "utf8",
      ),
    );
    assert.equal(record.queenThreadId, "spinoff-1");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("spinoff rollback restores plain and crowned non-web queen state", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-spinoff-failure-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const queens = new Map([
    ["plain-queen", mockThread("plain-queen", "Release planning")],
    ["crowned-queen", mockThread("crowned-queen", "👑 · Crowned release")],
  ]);
  const server = await startMockAppServer(socketPath, async ({ method, params }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") {
      return { thread: queens.get(params.threadId) };
    }
    if (method === "thread/name/set") {
      queens.get(params.threadId).name = params.name;
      return {};
    }
    if (method === "thread/start") throw new Error("creation failed");
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    for (const {
      threadId,
      originalTitle,
      baseTitle,
      queenMarked,
    } of [
      {
        threadId: "plain-queen",
        originalTitle: "Release planning",
        baseTitle: "Release planning",
        queenMarked: false,
      },
      {
        threadId: "crowned-queen",
        originalTitle: "👑 · Crowned release",
        baseTitle: "Crowned release",
        queenMarked: true,
      },
    ]) {
      const result = await runAsync(
        cli,
        [
          "spinoff",
          "--title",
          "API changes",
          "--prompt",
          "Do the work",
          "--socket",
          socketPath,
          "--timeout-ms",
          "1000",
        ],
        {
          XDG_STATE_HOME: stateHome,
          CODEX_THREAD_ID: threadId,
        },
      );

      assert.equal(result.status, 1);
      assert.match(result.stderr, /creation failed/);
      assert.equal(queens.get(threadId).name, originalTitle);
      const webRecord = JSON.parse(
        await readFile(
          join(stateHome, "nelos", "webs", `${threadId}.json`),
          "utf8",
        ),
      );
      assert.equal(webRecord.baseTitle, baseTitle);
      assert.equal(webRecord.outboundWebId, null);
      assert.equal(webRecord.queenMarked, queenMarked);
      assert.equal(webRecord.renderedTitle, originalTitle);
    }
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a waiting spinoff does not block another spinoff launch", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-spinoff-wait-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const threads = new Map([
    ["queen-thread", mockThread("queen-thread", "Queen")],
  ]);
  let spinoffNumber = 0;
  let secondStarted = false;
  const server = await startMockAppServer(socketPath, async ({ method, params }) => {
    if (method === "initialize") return {};
    if (method === "thread/start") {
      spinoffNumber += 1;
      const thread = mockThread(`spinoff-${spinoffNumber}`, null);
      threads.set(thread.id, thread);
      return { thread };
    }
    if (method === "thread/read") return { thread: threads.get(params.threadId) };
    if (method === "thread/name/set") {
      threads.get(params.threadId).name = params.name;
      return {};
    }
    if (method === "turn/start") {
      if (params.threadId === "spinoff-2") secondStarted = true;
      return { turn: { id: `turn-${params.threadId}`, status: "inProgress" } };
    }
    if (method === "thread/turns/list") {
      const completed = params.threadId === "spinoff-1" && secondStarted;
      return {
        data: [
          {
            id: `turn-${params.threadId}`,
            status: completed ? "completed" : "inProgress",
            items: [],
          },
        ],
      };
    }
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const baseArgs = [
      "spinoff",
      "--prompt",
      "Do the work",
      "--socket",
      socketPath,
      "--timeout-ms",
      "1000",
    ];
    const environment = {
      XDG_STATE_HOME: stateHome,
      CODEX_THREAD_ID: "queen-thread",
    };
    const waiting = runAsync(
      cli,
      [
        ...baseArgs,
        "--title",
        "First",
        "--wait",
        "--poll-ms",
        "10",
        "--max-wait-ms",
        "2000",
      ],
      environment,
    );

    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (
        server.requests.some(
          ({ method, params }) =>
            method === "turn/start" && params.threadId === "spinoff-1",
        )
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const second = await runAsync(
      cli,
      [...baseArgs, "--title", "Second"],
      environment,
    );
    const first = await waiting;

    assert.equal(second.status, 0, second.stderr);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).detached, false);
    assert.equal(secondStarted, true);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("send resumes an unloaded thread before starting a follow-up turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-resume-"));
  const socketPath = join(root, "app.sock");
  const threadId = "unloaded-thread";
  const unloadedThread = {
    ...mockThread(threadId, "Unloaded task"),
    status: { type: "notLoaded" },
  };
  const loadedThread = {
    ...unloadedThread,
    status: { type: "idle" },
  };
  let resumed = false;
  let turnStarted = false;
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") {
      return { thread: resumed ? loadedThread : unloadedThread };
    }
    if (method === "thread/turns/list") {
      return {
        data: turnStarted
          ? [{ id: "follow-up-turn", status: "inProgress" }]
          : [{ id: "previous-turn", status: "completed" }],
      };
    }
    if (method === "thread/resume") {
      resumed = true;
      return { thread: loadedThread };
    }
    if (method === "turn/start") {
      assert.equal(resumed, true, "thread must be resumed before turn/start");
      turnStarted = true;
      return { turn: { id: "follow-up-turn", status: "inProgress" } };
    }
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const result = await runAsync(
      cli,
      [
        "send",
        threadId,
        "--prompt",
        "Continue the work",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      { XDG_STATE_HOME: join(root, "state") },
    );

    assert.equal(result.status, 0, result.stderr);
    const resumeIndex = server.requests.findIndex(
      ({ method }) => method === "thread/resume",
    );
    const turnStartIndex = server.requests.findIndex(
      ({ method }) => method === "turn/start",
    );
    assert.ok(resumeIndex >= 0);
    assert.ok(resumeIndex < turnStartIndex);
    assert.deepEqual(server.requests[resumeIndex].params, {
      threadId,
      excludeTurns: true,
    });
    const output = JSON.parse(result.stdout);
    assert.deepEqual(output.status, { type: "active", activeFlags: [] });
    assert.equal(output.latestTurn.id, "follow-up-turn");
    assert.equal(output.latestTurn.status, "inProgress");
    assert.equal(
      server.requests.filter(({ method }) => method === "thread/turns/list").length,
      1,
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("send does not start a turn when resume returns a non-idle thread", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-resume-active-"));
  const socketPath = join(root, "app.sock");
  const threadId = "unloaded-thread";
  const unloadedThread = {
    ...mockThread(threadId, "Unloaded task"),
    status: { type: "notLoaded" },
  };
  let turnStarts = 0;
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") return { thread: unloadedThread };
    if (method === "thread/turns/list") {
      return { data: [{ id: "previous-turn", status: "completed" }] };
    }
    if (method === "thread/resume") {
      return {
        thread: { ...unloadedThread, status: { type: "active" } },
      };
    }
    if (method === "turn/start") {
      turnStarts += 1;
      return { turn: { id: "unexpected-turn", status: "inProgress" } };
    }
    throw new Error(`unexpected method: ${method}`);
  });
  try {
    const result = await runAsync(
      cli,
      [
        "send",
        threadId,
        "--prompt",
        "Continue the work",
        "--socket",
        socketPath,
        "--timeout-ms",
        "1000",
      ],
      { XDG_STATE_HOME: join(root, "state") },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /did not become idle after resume/);
    assert.equal(
      server.requests.filter(({ method }) => method === "thread/resume").length,
      1,
    );
    assert.equal(turnStarts, 0);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("list tolerates registry records without createdAt", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-registry-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const registry = join(stateHome, "nelos", "tasks");
  await mkdir(registry, { recursive: true });
  await writeFile(
    join(registry, "legacy-one.json"),
    JSON.stringify({ threadId: "legacy-one", title: "Legacy one" }),
  );
  await writeFile(
    join(registry, "legacy-two.json"),
    JSON.stringify({ threadId: "legacy-two", title: "Legacy two" }),
  );

  const server = await startMockAppServer(socketPath, async ({ method, params }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") {
      return { thread: mockThread(params.threadId, params.threadId) };
    }
    if (method === "thread/turns/list") return { data: [] };
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const result = await runAsync(
      cli,
      ["list", "--socket", socketPath, "--timeout-ms", "1000"],
      { XDG_STATE_HOME: stateHome },
    );

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.scope, "local-registry");
    assert.equal(output.count, 2);
    assert.deepEqual(
      output.tasks.map(({ threadId }) => threadId),
      ["legacy-one", "legacy-two"],
    );
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("list --all requests the supported updated_at sort key", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-list-all-"));
  const socketPath = join(root, "app.sock");
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    if (method === "thread/list") return { data: [] };
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const result = await runAsync(cli, [
      "list",
      "--all",
      "--socket",
      socketPath,
      "--timeout-ms",
      "1000",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const request = server.requests.find(({ method }) => method === "thread/list");
    assert.equal(request.params.sortKey, "updated_at");
    assert.equal(JSON.parse(result.stdout).scope, "all-sources");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("missing rollouts and unavailable app-server tasks leave local archive records unchanged", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-archive-failure-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const taskDirectory = join(stateHome, "nelos", "tasks");
  const webDirectory = join(stateHome, "nelos", "webs");
  await mkdir(taskDirectory, { recursive: true });
  await mkdir(webDirectory, { recursive: true });
  await writeFile(
    join(taskDirectory, "active-thread.json"),
    JSON.stringify({ threadId: "active-thread", title: "🕷️ A1 · Active" }),
  );
  await writeFile(
    join(webDirectory, "active-thread.json"),
    JSON.stringify({
      threadId: "active-thread",
      baseTitle: "Active",
      outboundWebId: "A1",
      inboundWebId: null,
      archivedAt: null,
    }),
  );
  const readFailures = [
    "no rollout found for thread id active-thread",
    "task is unavailable on this app server",
  ];
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") throw new Error(readFailures.shift());
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    for (const expectedFailure of [
      /no rollout found for thread id active-thread/,
      /task is unavailable on this app server/,
    ]) {
      const result = await runAsync(
        cli,
        [
          "archive",
          "active-thread",
          "--socket",
          socketPath,
          "--timeout-ms",
          "1000",
        ],
        { XDG_STATE_HOME: stateHome },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, expectedFailure);
      assert.match(result.stderr, /no local records were changed/);
    }

    const taskRecord = JSON.parse(
      await readFile(join(taskDirectory, "active-thread.json"), "utf8"),
    );
    const webRecord = JSON.parse(
      await readFile(join(webDirectory, "active-thread.json"), "utf8"),
    );
    assert.equal(taskRecord.archivedAt, undefined);
    assert.equal(webRecord.archivedAt, null);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("archive --detach hides unavailable local records with an audit trail and can restore them", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-archive-detach-"));
  const stateHome = join(root, "state");
  const taskDirectory = join(stateHome, "nelos", "tasks");
  const webDirectory = join(stateHome, "nelos", "webs");
  await mkdir(taskDirectory, { recursive: true });
  await mkdir(webDirectory, { recursive: true });
  await writeFile(
    join(taskDirectory, "unavailable-member.json"),
    JSON.stringify({
      threadId: "unavailable-member",
      title: "🕸️ A1 · Unavailable Member",
      web: { queenThreadId: "historical-queen", inboundWebId: "A1" },
    }),
  );
  await writeFile(
    join(webDirectory, "unavailable-member.json"),
    JSON.stringify({
      threadId: "unavailable-member",
      baseTitle: "Unavailable Member",
      inboundWebId: "A1",
      outboundWebId: "A2",
      queenThreadId: "historical-queen",
      archivedAt: null,
    }),
  );

  try {
    const detached = await runAsync(
      cli,
      ["archive", "unavailable-member", "--detach"],
      {
        XDG_STATE_HOME: stateHome,
        CODEX_HOME: join(root, "codex-home-without-a-socket"),
      },
    );
    assert.equal(detached.status, 0, detached.stderr);
    const detachOutput = JSON.parse(detached.stdout);
    assert.equal(detachOutput.localOnly, true);
    assert.equal(detachOutput.localArchiveState, "detached");
    assert.equal(detachOutput.serverArchived, false);
    assert.equal(detachOutput.serverArchiveState, "not-attempted");

    const detachedTask = JSON.parse(
      await readFile(join(taskDirectory, "unavailable-member.json"), "utf8"),
    );
    const detachedWeb = JSON.parse(
      await readFile(join(webDirectory, "unavailable-member.json"), "utf8"),
    );
    assert.equal(detachedTask.archivedAt, detachedWeb.archivedAt);
    assert.equal(detachedTask.web.queenThreadId, "historical-queen");
    assert.equal(detachedWeb.queenThreadId, "historical-queen");
    assert.deepEqual(detachedTask.archiveHistory, [
      {
        action: "local-detach",
        at: detachedTask.archivedAt,
        upstreamArchive: "not-attempted",
      },
    ]);
    assert.deepEqual(detachedWeb.archiveHistory, detachedTask.archiveHistory);

    const restored = await runAsync(
      cli,
      ["archive", "unavailable-member", "--restore-detached"],
      {
        XDG_STATE_HOME: stateHome,
        CODEX_HOME: join(root, "codex-home-without-a-socket"),
      },
    );
    assert.equal(restored.status, 0, restored.stderr);
    const restoreOutput = JSON.parse(restored.stdout);
    assert.equal(restoreOutput.localOnly, true);
    assert.equal(restoreOutput.localArchiveState, "restored");
    assert.equal(restoreOutput.serverArchiveState, "not-attempted");

    const restoredTask = JSON.parse(
      await readFile(join(taskDirectory, "unavailable-member.json"), "utf8"),
    );
    const restoredWeb = JSON.parse(
      await readFile(join(webDirectory, "unavailable-member.json"), "utf8"),
    );
    assert.equal(restoredTask.archivedAt, null);
    assert.equal(restoredWeb.archivedAt, null);
    assert.equal(restoredTask.archiveHistory.at(-1).action, "local-restore");
    assert.equal(restoredWeb.archiveHistory.at(-1).action, "local-restore");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive retries only after a confirmed app-server archive", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-archive-retry-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const taskDirectory = join(stateHome, "nelos", "tasks");
  const webDirectory = join(stateHome, "nelos", "webs");
  await mkdir(taskDirectory, { recursive: true });
  await mkdir(webDirectory, { recursive: true });
  await writeFile(
    join(taskDirectory, "retry-thread.json"),
    JSON.stringify({ threadId: "retry-thread", title: "🕸️ A1 · Retry" }),
  );
  await writeFile(
    join(webDirectory, "retry-thread.json"),
    JSON.stringify({ threadId: "retry-thread", inboundWebId: "A1", archivedAt: null }),
  );
  let archiveAttempts = 0;
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") return { thread: mockThread("retry-thread", "🕸️ A1 · Retry") };
    if (method === "thread/archive") {
      archiveAttempts += 1;
      if (archiveAttempts === 1) throw new Error("temporary app-server failure");
      return {};
    }
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const first = await runAsync(
      cli,
      ["archive", "retry-thread", "--socket", socketPath, "--timeout-ms", "1000"],
      { XDG_STATE_HOME: stateHome },
    );
    assert.equal(first.status, 1);
    assert.match(first.stderr, /temporary app-server failure/);
    assert.equal(
      JSON.parse(await readFile(join(webDirectory, "retry-thread.json"), "utf8")).archivedAt,
      null,
    );

    const second = await runAsync(
      cli,
      ["archive", "retry-thread", "--socket", socketPath, "--timeout-ms", "1000"],
      { XDG_STATE_HOME: stateHome },
    );
    assert.equal(second.status, 0, second.stderr);
    const output = JSON.parse(second.stdout);
    assert.equal(output.serverArchived, true);
    assert.equal(output.serverArchiveState, "archived");
    assert.equal(archiveAttempts, 2);
    const taskRecord = JSON.parse(
      await readFile(join(taskDirectory, "retry-thread.json"), "utf8"),
    );
    const webRecord = JSON.parse(
      await readFile(join(webDirectory, "retry-thread.json"), "utf8"),
    );
    assert.equal(taskRecord.archivedAt, webRecord.archivedAt);
    assert.equal(typeof taskRecord.archivedAt, "string");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("archive confirms an already archived task without issuing a second archive request", async () => {
  const root = await mkdtemp(join(tmpdir(), "nelos-archive-already-archived-"));
  const socketPath = join(root, "app.sock");
  const stateHome = join(root, "state");
  const webDirectory = join(stateHome, "nelos", "webs");
  await mkdir(webDirectory, { recursive: true });
  await writeFile(
    join(webDirectory, "archived-thread.json"),
    JSON.stringify({ threadId: "archived-thread", inboundWebId: "A1", archivedAt: null }),
  );
  const server = await startMockAppServer(socketPath, async ({ method }) => {
    if (method === "initialize") return {};
    if (method === "thread/read") {
      return {
        thread: {
          ...mockThread("archived-thread", "🕸️ A1 · Archived"),
          status: { type: "archived" },
        },
      };
    }
    if (method === "thread/archive") throw new Error("should not archive twice");
    throw new Error(`unexpected method: ${method}`);
  });

  try {
    const result = await runAsync(
      cli,
      ["archive", "archived-thread", "--socket", socketPath, "--timeout-ms", "1000"],
      { XDG_STATE_HOME: stateHome },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.serverArchived, true);
    assert.equal(output.serverArchiveState, "already-archived");
    assert.equal(output.alreadyArchived, true);
    assert.equal(server.requests.some(({ method }) => method === "thread/archive"), false);
    const webRecord = JSON.parse(
      await readFile(join(webDirectory, "archived-thread.json"), "utf8"),
    );
    assert.equal(typeof webRecord.archivedAt, "string");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
