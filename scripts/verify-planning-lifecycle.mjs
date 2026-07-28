#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const mcpPath = fileURLToPath(new URL("../bin/nelos-mcp", import.meta.url));
const fakeCodexPath = fileURLToPath(
  new URL("../test/support/fake-codex-stdio.mjs", import.meta.url),
);

function thread(id, name, parentThreadId, status = "active") {
  return {
    id,
    name,
    status:
      status === "active"
        ? { type: "active", activeFlags: [] }
        : status,
    cwd: repositoryRoot,
    parentThreadId,
    createdAt: 1,
    updatedAt: 1,
  };
}

function slice(id, overrides = {}) {
  return {
    id,
    title: `${id} task`,
    objective: `Complete ${id}`,
    deliverable: `${id} deliverable`,
    acceptanceCriteria: [`${id} is verified`],
    dependsOn: [],
    lifecycle: "spinoff",
    workspaceMode: "isolated-write",
    taskShape: "everyday",
    ...overrides,
  };
}

function fencedPlan(bootstrapId, plan) {
  return [
    "```nelos-plan",
    JSON.stringify({
      schemaVersion: 1,
      bootstrapId,
      confidence: "high",
      classificationEvidence: [
        "The dependency boundaries and task shapes are explicit.",
      ],
      plan,
    }),
    "```",
  ].join("\n");
}

async function writeState(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function mutateState(path, callback) {
  const value = JSON.parse(await readFile(path, "utf8"));
  callback(value);
  await writeState(path, value);
}

async function writeRollout(
  codexHome,
  threadId,
  {
    parentThreadId = null,
    agentPath = null,
    turnId,
    model,
    effort,
  },
) {
  const directory = join(codexHome, "sessions", "2026", "07", "24");
  await mkdir(directory, { recursive: true });
  const events = [];
  if (agentPath) {
    events.push({
      type: "session_meta",
      payload: {
        id: threadId,
        parent_thread_id: parentThreadId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: parentThreadId,
              agent_path: agentPath,
            },
          },
        },
      },
    });
  }
  events.push({
    type: "turn_context",
    payload: { turn_id: turnId, model, effort },
  });
  await writeFile(
    join(directory, `rollout-2026-07-24T12-00-00-${threadId}.jsonl`),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
    "utf8",
  );
}

class McpProcess {
  #child;
  #buffer = "";
  #nextId = 1;
  #pending = new Map();
  #stderr = "";

  constructor(child) {
    this.#child = child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.#stderr += chunk;
    });
    child.stdout.on("data", (chunk) => {
      this.#buffer += chunk;
      let newline;
      while ((newline = this.#buffer.indexOf("\n")) !== -1) {
        const line = this.#buffer.slice(0, newline).trim();
        this.#buffer = this.#buffer.slice(newline + 1);
        if (!line) continue;
        let response;
        try {
          response = JSON.parse(line);
        } catch {
          const error = new Error(
            `nelos-mcp emitted malformed JSON: ${
              this.#stderr.trim() || "no diagnostic"
            }`,
          );
          for (const pending of this.#pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
          }
          this.#pending.clear();
          this.#child.kill("SIGKILL");
          return;
        }
        const pending = this.#pending.get(response.id);
        if (!pending) continue;
        this.#pending.delete(response.id);
        clearTimeout(pending.timer);
        if (response.error) pending.reject(new Error(response.error.message));
        else pending.resolve(response.result);
      }
    });
    child.once("exit", (code) => {
      for (const pending of this.#pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(
          new Error(
            `nelos-mcp exited ${code}: ${this.#stderr.trim() || "no diagnostic"}`,
          ),
        );
      }
      this.#pending.clear();
    });
  }

  async initialize() {
    return this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "planning-smoke", version: "1" },
    });
  }

  request(method, params, timeoutMs = 10_000) {
    const id = this.#nextId;
    this.#nextId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
      );
    });
  }

  async tool(name, argumentsValue) {
    const result = await this.request("tools/call", {
      name,
      arguments: argumentsValue,
    });
    const body = JSON.parse(result.content[0].text);
    if (result.isError) throw new Error(body.error);
    return body;
  }

  stop() {
    return new Promise((resolve) => {
      if (this.#child.exitCode !== null) {
        resolve(this.#child.exitCode);
        return;
      }
      const timer = setTimeout(() => {
        this.#child.kill("SIGKILL");
      }, 5_000);
      this.#child.once("exit", (code) => {
        clearTimeout(timer);
        resolve(code);
      });
      this.#child.stdin.end();
    });
  }
}

function startMcp(environment) {
  return new McpProcess(
    spawn(process.execPath, [mcpPath], {
      cwd: repositoryRoot,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    }),
  );
}

export async function runPlanningLifecycleScenario() {
  const root = await mkdtemp(join(tmpdir(), "nelos-planning-smoke-"));
  const stateHome = join(root, "state");
  const codexHome = join(root, "codex-home");
  const binDirectory = join(root, "bin");
  const appStatePath = join(root, "app-state.json");
  const wrapperPath = join(binDirectory, "codex");
  let mcp = null;
  try {
    await mkdir(binDirectory, { recursive: true });
    await writeFile(
      wrapperPath,
      [
        "#!/usr/bin/env node",
        `import(${JSON.stringify(pathToFileURL(fakeCodexPath).href)});`,
        "",
      ].join("\n"),
      "utf8",
    );
    await chmod(wrapperPath, 0o700);
    await writeState(appStatePath, {
      threads: {
        "queen-1": thread("queen-1", "Planning smoke", null, "active"),
      },
    });
    const environment = {
      ...process.env,
      PATH: `${binDirectory}${delimiter}${process.env.PATH}`,
      CODEX_HOME: codexHome,
      CODEX_THREAD_ID: "queen-1",
      XDG_STATE_HOME: stateHome,
      NELOS_FAKE_APP_STATE: appStatePath,
    };

    mcp = startMcp(environment);
    await mcp.initialize();
    const lifecycleRequest = {
      schemaVersion: 1,
      idempotencyKey: "planning-smoke",
      queenThreadId: "queen-1",
      objective: "Plan and ship a mixed task wave",
      maxParallel: 2,
      receipt: null,
    };
    const prepared = await mcp.tool(
      "nelos_plan_lifecycle",
      lifecycleRequest,
    );
    assert.equal(prepared.nextAction.kind, "launch-planner");
    assert.deepEqual(prepared.nextAction.member.nativeTask, {
      model: "gpt-5.6-sol",
      thinking: "medium",
    });
    const bootstrapId = prepared.lifecycle.bootstrapId;
    const plannerAgentPath = "/root/nelos_planner_smoke";
    await writeRollout(codexHome, "planner-1", {
      parentThreadId: "queen-1",
      agentPath: plannerAgentPath,
      turnId: "planner-turn",
      model: "gpt-5.6-sol",
      effort: "medium",
    });
    await mutateState(appStatePath, (value) => {
      value.threads["planner-1"] = thread(
        "planner-1",
        null,
        "queen-1",
        "notLoaded",
      );
      value.threads["planner-1"].turns = [
        { id: "planner-turn", status: "inProgress", items: [] },
      ];
    });
    const launchReceipt = {
      schemaVersion: 1,
      type: "native-planner-created",
      actionId: prepared.nextAction.member.actionId,
      bootstrapId,
      parentThreadId: "queen-1",
      agentPath: plannerAgentPath,
    };
    const waiting = await mcp.tool("nelos_plan_lifecycle", {
      ...lifecycleRequest,
      bootstrapId,
      receipt: launchReceipt,
    });
    assert.equal(waiting.nextAction.kind, "native-wait-subagent");
    await mcp.stop();
    mcp = startMcp(environment);
    await mcp.initialize();
    const resumed = await mcp.tool("nelos_plan_lifecycle", {
      ...lifecycleRequest,
      bootstrapId,
      receipt: launchReceipt,
    });
    assert.equal(resumed.nextAction.kind, "native-wait-subagent");
    await mutateState(appStatePath, (value) => {
      value.threads["planner-1"].updatedAt += 1;
      value.threads["planner-1"].turns[0].status = "completed";
    });
    const readable = await mcp.tool("nelos_plan_lifecycle", {
      ...lifecycleRequest,
      bootstrapId,
      receipt: launchReceipt,
    });
    assert.equal(readable.nextAction.kind, "native-read-subagent-result");

    const initialSuffix = bootstrapId.slice(5, 17);
    const researchSliceId = `research-${initialSuffix}`;
    const implementationSliceId = `implementation-${initialSuffix}`;
    const followupSliceId = `followup-${initialSuffix}`;
    const plannedSlices = [
      slice(researchSliceId, {
        lifecycle: "subagent",
        workspaceMode: "shared-read-only",
        taskShape: "clear/repeatable",
      }),
      slice(implementationSliceId),
      slice(followupSliceId, { dependsOn: [implementationSliceId] }),
    ];
    const rawPlan = {
      schemaVersion: 1,
      objective: "Ship the mixed task wave",
      maxParallel: 2,
      slices: plannedSlices,
    };
    const completedPlanningRequest = {
      ...lifecycleRequest,
      bootstrapId,
      receipt: {
        schemaVersion: 1,
        type: "native-planner-result",
        actionId: readable.nextAction.actionId,
        bootstrapId,
        threadId: "planner-1",
        turnId: "planner-turn",
        response: fencedPlan(bootstrapId, rawPlan),
      },
    };
    let planned = await mcp.tool(
      "nelos_plan_lifecycle",
      completedPlanningRequest,
    );
    if (planned.nextAction.kind === "native-set-title") {
      await mutateState(appStatePath, (value) => {
        value.threads[planned.nextAction.threadId].name =
          planned.nextAction.title;
        value.threads[planned.nextAction.threadId].updatedAt += 1;
      });
      planned = await mcp.tool(
        "nelos_plan_lifecycle",
        completedPlanningRequest,
      );
    }
    assert.equal(planned.nextAction.kind, "launch-wave");
    assert.equal(planned.nextAction.members.length, 2);
    const stateAfterPlan = JSON.parse(await readFile(appStatePath, "utf8"));
    assert.equal(
      stateAfterPlan.threads["queen-1"].name,
      planned.planRun.webIdentity.queenTitle,
    );

    await Promise.all([
      writeRollout(codexHome, "research-1", {
        parentThreadId: "queen-1",
        agentPath: "/root/research",
        turnId: "research-turn",
        model: "gpt-5.6-terra",
        effort: "low",
      }),
      writeRollout(codexHome, "implementation-1", {
        turnId: "implementation-turn",
        model: "gpt-5.6-terra",
        effort: "low",
      }),
    ]);
    await mutateState(appStatePath, (value) => {
      value.threads["research-1"] = thread(
        "research-1",
        null,
        "queen-1",
        "notLoaded",
      );
      value.threads["implementation-1"] = thread(
        "implementation-1",
        "implementation task",
        null,
      );
    });
    const batchRequest = {
      planRunId: planned.nextAction.verification.planRunId,
      waveIndex: planned.nextAction.verification.waveIndex,
      waveDigest: planned.nextAction.verification.waveDigest,
      parentThreadId: "queen-1",
      members: [
        {
          sliceId: researchSliceId,
          lifecycle: "subagent",
          agentPath: "/root/research",
          turnId: "research-turn",
        },
        {
          sliceId: implementationSliceId,
          lifecycle: "spinoff",
          actionId: planned.nextAction.members.find(
            ({ sliceId }) => sliceId === implementationSliceId,
          ).actionId,
          threadId: "implementation-1",
          turnId: "implementation-turn",
        },
      ],
    };
    let batch = await mcp.tool("nelos_launch_verify_batch", batchRequest);
    assert.equal(batch.nextAction.kind, "native-set-title");
    await mutateState(appStatePath, (value) => {
      value.threads[batch.nextAction.threadId].name = batch.nextAction.title;
      value.threads[batch.nextAction.threadId].updatedAt += 1;
    });
    batch = await mcp.tool("nelos_launch_verify_batch", batchRequest);
    assert.equal(batch.verification.allVerified, true);
    assert.equal(batch.nextAction.kind, "native-wait-wave");
    assert.deepEqual(
      batch.nextAction.targets.map(
        ({ sliceId, lifecycle, memberKind, controlSurface, primaryId }) => ({
          sliceId,
          lifecycle,
          memberKind,
          controlSurface,
          primaryId,
        }),
      ),
      [
        {
          sliceId: researchSliceId,
          lifecycle: "subagent",
          memberKind: "joined-subagent",
          controlSurface: "collaboration",
          primaryId: "agentPath",
        },
        {
          sliceId: implementationSliceId,
          lifecycle: "spinoff",
          memberKind: "spinoff",
          controlSurface: "codex-task",
          primaryId: "threadId",
        },
      ],
    );

    const replanRequest = {
      schemaVersion: 1,
      idempotencyKey: "planning-smoke-failure",
      queenThreadId: "queen-1",
      basePlanRunId: planned.planRun.planRunId,
      basePlanDigest: planned.planRun.planDigest,
      basePlan: rawPlan,
      trigger: {
        type: "execution-failed",
        eventId: "implementation-failed",
        summary: "The implementation failed its required verification",
        affectedSliceIds: [implementationSliceId],
        completedSliceIds: [researchSliceId],
        evidence: ["The current terminal result reports a failed outcome."],
      },
      generation: 1,
      receipt: null,
    };
    const replanPrepared = await mcp.tool("nelos_plan_replan", replanRequest);
    assert.equal(replanPrepared.nextAction.kind, "launch-planner");
    const replanBootstrapId = replanPrepared.lifecycle.bootstrapId;
    await writeRollout(codexHome, "replanner-1", {
      parentThreadId: "queen-1",
      agentPath: "/root/replanner",
      turnId: "replanner-turn",
      model: "gpt-5.6-sol",
      effort: "medium",
    });
    await mutateState(appStatePath, (value) => {
      value.threads["replanner-1"] = thread(
        "replanner-1",
        null,
        "queen-1",
        "notLoaded",
      );
      value.threads["replanner-1"].turns = [
        { id: "replanner-turn", status: "completed", items: [] },
      ];
    });
    const replanLaunchReceipt = {
      schemaVersion: 1,
      type: "native-planner-created",
      actionId: replanPrepared.nextAction.member.actionId,
      bootstrapId: replanBootstrapId,
      parentThreadId: "queen-1",
      agentPath: "/root/replanner",
    };
    const replanReadable = await mcp.tool("nelos_plan_replan", {
      ...replanRequest,
      bootstrapId: replanBootstrapId,
      receipt: replanLaunchReceipt,
    });
    assert.equal(
      replanReadable.nextAction.kind,
      "native-read-subagent-result",
    );
    const replanSuffix = replanBootstrapId.slice(5, 17);
    const replacementSliceId = `replacement-${replanSuffix}`;
    const revisedFollowupSliceId = `followup-${replanSuffix}`;
    const revisedPlan = {
      schemaVersion: 1,
      objective: "Ship the revised mixed task wave",
      maxParallel: 2,
      slices: [
        plannedSlices[0],
        slice(replacementSliceId),
        slice(revisedFollowupSliceId, { dependsOn: [replacementSliceId] }),
      ],
    };
    const replanned = await mcp.tool("nelos_plan_replan", {
      ...replanRequest,
      bootstrapId: replanBootstrapId,
      receipt: {
        schemaVersion: 1,
        type: "native-planner-result",
        actionId: replanReadable.nextAction.actionId,
        bootstrapId: replanBootstrapId,
        threadId: "replanner-1",
        turnId: "replanner-turn",
        response: fencedPlan(replanBootstrapId, revisedPlan),
      },
    });
    assert.equal(replanned.nextAction.kind, "launch-wave");
    assert.deepEqual(
      replanned.nextAction.members.map(({ sliceId }) => sliceId),
      [replacementSliceId],
    );
    assert.deepEqual(
      replanned.replanning.completedSliceIds,
      [researchSliceId],
    );

    const report = {
      schemaVersion: 1,
      receiptResume: true,
      batchAtomic: batch.verification.allVerified,
      exceptionReplanned: true,
      completedSlicesPreserved: true,
      modelTurns: 0,
      cleanedUp: true,
    };
    return report;
  } finally {
    if (mcp) await mcp.stop().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runPlanningLifecycleScenario()
    .then((report) => process.stdout.write(`${JSON.stringify(report, null, 2)}\n`))
    .catch((error) => {
      process.stderr.write(`planning lifecycle smoke failed: ${error.message}\n`);
      process.exitCode = 1;
    });
}
