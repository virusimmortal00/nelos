import {
  planWorkSlices,
  SLICE_PLAN_INPUT_SCHEMA,
} from "./slice-planner.mjs";
import { routeIntelligenceProfile } from "./intelligence-profile-router.mjs";
import { verifyRuntimeIntelligenceV1 } from "./runtime-intelligence-verification.mjs";
import { withNextAction } from "./next-action.mjs";

// Socket-free MCP tool surface for the marketplace plugin; scope and trust
// model are specified in docs/mcp-tool-surface.md. Transport is
// newline-delimited JSON-RPC over stdio, the framing the Codex host was
// observed to use (codex-cli 0.144.6). Every tool is read-only: the planner
// and router are pure, and verification performs bounded local rollout reads.

export const MCP_SERVER_NAME = "nelos";
export const MCP_DEFAULT_PROTOCOL_VERSION = "2025-06-18";
const MAX_MESSAGE_BYTES = 256 * 1024;

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
});

const TOOLS = [
  {
    name: "nelos_plan_slices",
    description:
      "Validate a queen-authored slice-plan JSON object and return " +
      "dependency-safe waves with reviewed per-slice launch options and the " +
      "machine-generated nextAction. Equivalent to `nelos plan slices`.",
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
    async run(args) {
      return withNextAction({
        command: "plan slices",
        plan: planWorkSlices(args.plan),
      });
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
];

export function listNelosMcpTools() {
  return TOOLS.map(({ name, description, inputSchema }) => ({
    name,
    description,
    inputSchema,
    annotations: READ_ONLY_ANNOTATIONS,
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
      result = await tool.run(assertToolArguments(tool, params.arguments));
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
      // Serialize handling so responses keep request order.
      processing = processing.then(() => handle(message));
    }
  });
  input.on("end", () => {
    processing.then(() => onExit(0));
  });
}
