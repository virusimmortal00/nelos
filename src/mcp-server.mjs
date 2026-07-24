import {
  planWorkSlices,
  SLICE_PLAN_INPUT_SCHEMA,
} from "./slice-planner.mjs";
import { routeIntelligenceProfile } from "./intelligence-profile-router.mjs";
import { verifyRuntimeIntelligenceV1 } from "./runtime-intelligence-verification.mjs";
import { withNextAction } from "./next-action.mjs";
import {
  MCP_ORCHESTRATE_INPUT_SCHEMA,
  McpOrchestrationAdapterV1,
} from "./mcp-orchestration.mjs";
import {
  MCP_OBSERVATION_ADVANCE_INPUT_SCHEMA,
  McpJoinAdapterV1,
} from "./mcp-observation.mjs";
import {
  CodexAppServerBridgeV1,
  MCP_APP_SERVER_MAX_BATCH_THREADS,
  MCP_APP_SERVER_MAX_WAIT_MS,
  MCP_APP_SERVER_MAX_WAIT_THREADS,
} from "./mcp-app-server-bridge.mjs";

// MCP tool surface for the marketplace plugin; scope and trust model are
// specified in docs/mcp-tool-surface.md. Transport is
// newline-delimited JSON-RPC over stdio, the framing the Codex host was
// observed to use (codex-cli 0.144.6). The planner owns one narrowly scoped
// queen-title mutation through a lazy Codex app-server child; inspection is
// bounded and read-only. Orchestration otherwise remains callback-driven.

export const MCP_SERVER_NAME = "nelos";
export const MCP_DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const MAX_MESSAGE_BYTES = 256 * 1024;

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
});

const STATEFUL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const TOOLS = [
  {
    name: "nelos_plan_slices",
    description:
      "Validate a queen-authored slice-plan JSON object and return " +
      "dependency-safe waves with reviewed per-slice launch options and the " +
      "machine-generated nextAction. Plans containing spinoffs first " +
      "synchronize and verify the current queen title through Codex.",
    inputSchema: {
      type: "object",
      properties: {
        plan: {
          description:
            "Slice plan with schemaVersion, objective, optional maxParallel, " +
            "and slices (id, title, objective, deliverable, " +
            "acceptanceCriteria, dependsOn, lifecycle, workspaceMode, " +
            "taskShape).",
          ...SLICE_PLAN_INPUT_SCHEMA,
        },
      },
      required: ["plan"],
      additionalProperties: false,
    },
    annotations: STATEFUL_ANNOTATIONS,
    async run(args, { appServerBridge }) {
      const plan = planWorkSlices(args.plan);
      const queenTitleSync =
        plan.summary.spinoffs > 0
          ? await appServerBridge.synchronizeQueenTitle()
          : null;
      return {
        ...withNextAction({
          command: "plan slices",
          plan,
        }),
        ...(queenTitleSync ? { queenTitleSync } : {}),
      };
    },
  },
  {
    name: "nelos_thread_inspect",
    description:
      "Read bounded metadata for one Codex task through the MCP-owned " +
      "app-server bridge. Returns no prompts, previews, turns, or transcripts.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          description: "Task/thread ID; defaults to the current Codex task",
        },
      },
      additionalProperties: false,
    },
    async run(args, { appServerBridge }) {
      return {
        command: "thread inspect",
        thread: await appServerBridge.inspect({
          threadId: args.threadId ?? undefined,
        }),
      };
    },
  },
  {
    name: "nelos_thread_inventory",
    description:
      "Inspect up to 16 explicit Codex tasks concurrently and optionally " +
      "project authoritative direct parent edges. Partial read failures are " +
      "bounded per task; no turns, prompts, previews, or transcripts are returned.",
    inputSchema: {
      type: "object",
      properties: {
        threadIds: {
          type: "array",
          minItems: 1,
          maxItems: MCP_APP_SERVER_MAX_BATCH_THREADS,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 512 },
          description: "Unique task/thread IDs in desired output order",
        },
        includeTopology: {
          type: "boolean",
          description: "Include direct parent edges among successful tasks",
        },
      },
      required: ["threadIds"],
      additionalProperties: false,
    },
    async run(args, { appServerBridge }) {
      return {
        command: "thread inventory",
        inventory: await appServerBridge.inspectMany({
          threadIds: args.threadIds,
          includeTopology: args.includeTopology ?? true,
        }),
      };
    },
  },
  {
    name: "nelos_thread_wait",
    description:
      "Perform bounded current-state polling for up to eight Codex tasks. " +
      "Nelos snapshot cursors suppress unchanged snapshots; they are not " +
      "native event cursors and do not prove completion or result provenance.",
    inputSchema: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          minItems: 1,
          maxItems: MCP_APP_SERVER_MAX_WAIT_THREADS,
          items: {
            type: "object",
            properties: {
              threadId: {
                type: "string",
                minLength: 1,
                maxLength: 512,
              },
              afterCursor: {
                type: ["string", "null"],
                minLength: 1,
                maxLength: 512,
              },
            },
            required: ["threadId"],
            additionalProperties: false,
          },
        },
        timeoutMs: {
          type: "integer",
          minimum: 0,
          maximum: MCP_APP_SERVER_MAX_WAIT_MS,
        },
        pollIntervalMs: {
          type: "integer",
          minimum: 50,
          maximum: 5_000,
        },
      },
      required: ["targets"],
      additionalProperties: false,
    },
    async run(args, { appServerBridge }) {
      return {
        command: "thread wait",
        wait: await appServerBridge.waitForThreads({
          targets: args.targets,
          timeoutMs: args.timeoutMs ?? 0,
          pollIntervalMs: args.pollIntervalMs ?? 250,
        }),
      };
    },
  },
  {
    name: "nelos_app_server_health",
    description:
      "Report bounded, content-free compatibility and connection telemetry " +
      "for Nelos's Codex app-server bridge. An optional probe performs only " +
      "the initialization handshake.",
    inputSchema: {
      type: "object",
      properties: {
        probe: {
          type: "boolean",
          description: "Initialize the bridge before reporting health",
        },
      },
      additionalProperties: false,
    },
    async run(args, { appServerBridge }) {
      return {
        command: "app-server health",
        health: await appServerBridge.health({ probe: args.probe === true }),
      };
    },
  },
  {
    name: "nelos_intelligence_route",
    description:
      "Route a task shape to a reviewed model-and-reasoning profile, with " +
      "optional explicit overrides. Equivalent to `nelos intelligence route`.",
    inputSchema: {
      type: "object",
      properties: {
        taskShape: {
          type: "string",
          description:
            "complex/open-ended, everyday, or clear/repeatable",
        },
        profile: { type: "string", description: "Explicit profile override" },
        model: { type: "string", description: "Explicit catalog model override" },
        effort: {
          type: "string",
          description: "Explicit supported reasoning-effort override",
        },
        allowNativeFanout: {
          type: "boolean",
          description: "Permit an explicit Ultra effort override",
        },
      },
      additionalProperties: false,
    },
    async run(args) {
      const input = {};
      if (args.taskShape !== undefined) input.taskShape = args.taskShape;
      if (args.profile !== undefined) {
        input.profileOverride = String(args.profile).toLowerCase();
      }
      if (args.model !== undefined) input.modelOverride = args.model;
      if (args.effort !== undefined) input.effortOverride = args.effort;
      if (args.allowNativeFanout === true) input.nativeFanoutAllowed = true;
      return withNextAction({
        command: "intelligence route",
        route: routeIntelligenceProfile(input),
      });
    },
  },
  {
    name: "nelos_intelligence_verify",
    description:
      "Verify from bounded local turn-context metadata that a launched task " +
      "runs the exact expected model and reasoning effort. Fails closed on " +
      "any mismatch. Equivalent to `nelos intelligence verify`.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Launched task/thread ID" },
        model: { type: "string", description: "Expected model" },
        effort: { type: "string", description: "Expected reasoning effort" },
        turnId: {
          type: "string",
          description: "Restrict verification to one turn, when known",
        },
      },
      required: ["threadId", "model", "effort"],
      additionalProperties: false,
    },
    async run(args) {
      const verification = await verifyRuntimeIntelligenceV1({
        threadId: args.threadId,
        turnId: args.turnId ?? null,
        model: args.model,
        effort: args.effort,
      });
      const output = withNextAction({
        command: "intelligence verify",
        ...verification,
      });
      return {
        ...output,
        // Mirrors the CLI, which exits nonzero for an unverified route.
        isError: verification.verified !== true,
      };
    },
  },
  {
    name: "nelos_orchestrate_create",
    description:
      "Durably advance one spinoff or joined-subagent work unit to " +
      "launch-pending and return one lifecycle-specific native-create effect, " +
      "or validate a host create receipt and bind its member thread ID. This " +
      "tool never contacts the app server.",
    inputSchema: MCP_ORCHESTRATE_INPUT_SCHEMA,
    annotations: STATEFUL_ANNOTATIONS,
    async run(args, { orchestrationAdapter }) {
      return orchestrationAdapter.orchestrate(args);
    },
  },
  {
    name: "nelos_orchestrate_advance",
    description:
      "Advance the durable callback-only title/wait/result join checkpoint. " +
      "Returns typed host-owned effects and never starts or discovers an app server.",
    inputSchema: MCP_OBSERVATION_ADVANCE_INPUT_SCHEMA,
    annotations: STATEFUL_ANNOTATIONS,
    async run(args, { joinAdapter }) {
      return joinAdapter.advance(args);
    },
  },
];

export function listNelosMcpTools() {
  return TOOLS.map(({ name, description, inputSchema, annotations }) => ({
    name,
    description,
    inputSchema,
    annotations: annotations ?? READ_ONLY_ANNOTATIONS,
  }));
}

function assertToolArguments(tool, value) {
  const args = value ?? {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`${tool.name} arguments must be an object`);
  }
  const allowed = new Set(Object.keys(tool.inputSchema.properties));
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      throw new Error(`${tool.name} does not accept argument ${key}`);
    }
  }
  for (const key of tool.inputSchema.required ?? []) {
    if (args[key] === undefined) {
      throw new Error(`${tool.name} requires argument ${key}`);
    }
  }
  return args;
}

export function startNelosMcpServer({
  input = process.stdin,
  output = process.stdout,
  serverVersion = "0.0.0-dev",
  onExit = (code) => process.exit(code),
  orchestrationAdapter = new McpOrchestrationAdapterV1(),
  joinAdapter = new McpJoinAdapterV1(),
  appServerBridge = new CodexAppServerBridgeV1(),
} = {}) {
  function send(payload) {
    output.write(JSON.stringify(payload) + "\n");
  }

  async function callTool(params) {
    const tool = TOOLS.find((candidate) => candidate.name === params?.name);
    if (!tool) {
      const error = new Error(`unknown tool: ${params?.name}`);
      error.jsonRpcCode = -32602;
      throw error;
    }
    let result;
    try {
      result = await tool.run(assertToolArguments(tool, params.arguments), {
        appServerBridge,
        orchestrationAdapter,
        joinAdapter,
      });
    } catch (error) {
      return {
        content: [
          { type: "text", text: JSON.stringify({ error: error.message }) },
        ],
        isError: true,
      };
    }
    const { isError = false, ...body } = result;
    return {
      content: [{ type: "text", text: JSON.stringify(body) }],
      isError,
    };
  }

  async function handle(message) {
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null;
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion:
            typeof params?.protocolVersion === "string"
              ? params.protocolVersion
              : MCP_DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: serverVersion },
        },
      });
      return;
    }
    if (!isRequest) return; // notifications require no response
    if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: listNelosMcpTools() } });
      return;
    }
    if (method === "tools/call") {
      try {
        send({ jsonrpc: "2.0", id, result: await callTool(params) });
      } catch (error) {
        send({
          jsonrpc: "2.0",
          id,
          error: {
            code: error.jsonRpcCode ?? -32603,
            message: error.message,
          },
        });
      }
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `method not found: ${method}` },
    });
  }

  let buffer = "";
  let processing = Promise.resolve();
  let waitProcessing = Promise.resolve();
  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer, "utf8") > MAX_MESSAGE_BYTES) {
      process.stderr.write(
        `nelos-mcp: message exceeds ${MAX_MESSAGE_BYTES} bytes; terminating\n`,
      );
      onExit(1);
      return;
    }
    let newline;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.stderr.write("nelos-mcp: ignored unparseable message\n");
        continue;
      }
      if (
        message.method === "tools/call" &&
        message.params?.name === "nelos_thread_wait"
      ) {
        // A bounded wait may run beside later requests. JSON-RPC permits
        // out-of-order responses, while stateful non-wait operations retain
        // their existing serialized ordering. Waits serialize with each other
        // so their per-call read bounds cannot multiply without limit.
        const waitPrerequisites = Promise.all([processing, waitProcessing]);
        waitProcessing = waitPrerequisites
          .then(
            () => handle(message),
            () => {
              if (message.id !== undefined && message.id !== null) {
                send({
                  jsonrpc: "2.0",
                  id: message.id,
                  error: {
                    code: -32603,
                    message: "internal wait scheduling failure",
                  },
                });
              }
            },
          )
          .catch(() => {
            process.stderr.write(
              "nelos-mcp: wait request failed unexpectedly\n",
            );
          });
      } else {
        processing = processing
          .then(() => handle(message))
          .catch(() => {
            process.stderr.write("nelos-mcp: request failed unexpectedly\n");
          });
      }
    }
  });
  input.on("end", () => {
    Promise.allSettled([processing, waitProcessing])
      .then(() => appServerBridge.close?.())
      .then(() => onExit(0));
  });
}
