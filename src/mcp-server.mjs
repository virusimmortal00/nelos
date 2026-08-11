import { planWorkSlices } from "./slice-planner.mjs";
import { routeIntelligenceProfile } from "./intelligence-profile-router.mjs";
import { verifyRuntimeIntelligenceV1 } from "./runtime-intelligence-verification.mjs";

// Socket-free MCP tool surface for the marketplace plugin; scope and trust
// model are specified in docs/mcp-tool-surface.md. Transport is
// newline-delimited JSON-RPC over stdio, the framing the Codex host was
// observed to use (codex-cli 0.144.6). Every tool is read-only: the planner
// and router are pure, and verification performs bounded local rollout reads.

export const MCP_SERVER_NAME = "nelos";
export const MCP_DEFAULT_PROTOCOL_VERSION = "2025-06-18";
// Wire-compatible revisions we honor when a client negotiates. The default
// (latest) must appear first; anything else the client asks for falls back to
// the default per the initialize negotiation rule. structuredContent is a
// 2025-06-18 feature, but it rides in a result field older clients ignore
// while the mirrored text block keeps them working.
export const SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  "2025-06-18",
  "2025-03-26",
]);
const MCP_INSTRUCTIONS =
  "Read-only planning and model-routing tools backed by the nelos CLI. " +
  "Every tool is a pure function of its input or performs bounded local " +
  "reads; none mutate state, spawn processes, or open sockets.";
const MAX_MESSAGE_BYTES = 256 * 1024;

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
});

// Output schemas describe the JSON envelope each tool returns as
// structuredContent. They are intentionally permissive at nested levels
// (no additionalProperties:false, nullable dimensions allowed) so a strict
// client validator accepts every reachable result without pinning the full
// planner/router contract, which evolves behind its own schemaVersion fields.
const ROUTE_OUTPUT_SCHEMA = Object.freeze({
  type: ["object", "null"],
  description:
    "Reviewed launch metadata, or null when no routing dimension was given " +
    "and host defaults should stand.",
  properties: {
    schemaVersion: { type: "integer" },
    policyVersion: {},
    catalogVersion: {},
    taskShape: { type: ["string", "null"] },
    profile: { type: ["string", "null"] },
    requestedModel: { type: ["string", "null"] },
    requestedEffort: { type: ["string", "null"] },
    modelSelection: { type: "string" },
    effortSelection: { type: "string" },
    launch: { type: "object" },
    rationale: { type: "string" },
    nativeFanoutAllowed: { type: "boolean" },
  },
});

const PLAN_SLICES_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    command: { type: "string" },
    plan: {
      type: "object",
      properties: {
        schemaVersion: { type: "integer" },
        objective: { type: "string" },
        maxParallel: { type: "integer" },
        catalogVersion: {},
        summary: {
          type: "object",
          properties: {
            slices: { type: "integer" },
            waves: { type: "integer" },
            spinoffs: { type: "integer" },
            subagents: { type: "integer" },
            models: { type: "object" },
            efforts: { type: "object" },
          },
        },
        waves: {
          type: "array",
          items: {
            type: "object",
            properties: {
              index: { type: "integer" },
              parallel: { type: "boolean" },
              slices: { type: "array", items: { type: "object" } },
            },
          },
        },
      },
      required: ["schemaVersion", "objective", "summary", "waves"],
    },
  },
  required: ["command", "plan"],
});

const ROUTE_ENVELOPE_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    command: { type: "string" },
    route: ROUTE_OUTPUT_SCHEMA,
  },
  required: ["command", "route"],
});

const VERIFY_OUTPUT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    command: { type: "string" },
    schemaVersion: { type: "integer" },
    threadId: { type: "string" },
    turnId: { type: ["string", "null"] },
    expected: { type: "object" },
    observed: {
      type: "array",
      items: {
        type: "object",
        properties: {
          turnId: { type: "string" },
          model: { type: "string" },
          effort: { type: "string" },
          matches: { type: "boolean" },
        },
      },
    },
    verified: { type: "boolean" },
  },
  required: ["command", "verified"],
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
          type: "object",
          description:
            "Slice plan with schemaVersion, objective, optional maxParallel, " +
            "and slices (id, title, objective, deliverable, " +
            "acceptanceCriteria, dependsOn, lifecycle, workspaceMode, " +
            "taskShape).",
        },
      },
      required: ["plan"],
      additionalProperties: false,
    },
    outputSchema: PLAN_SLICES_OUTPUT_SCHEMA,
    async run(args) {
      return { command: "plan slices", plan: planWorkSlices(args.plan) };
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
    outputSchema: ROUTE_ENVELOPE_OUTPUT_SCHEMA,
    async run(args) {
      const input = {};
      if (args.taskShape !== undefined) input.taskShape = args.taskShape;
      if (args.profile !== undefined) {
        input.profileOverride = String(args.profile).toLowerCase();
      }
      if (args.model !== undefined) input.modelOverride = args.model;
      if (args.effort !== undefined) input.effortOverride = args.effort;
      if (args.allowNativeFanout === true) input.nativeFanoutAllowed = true;
      return {
        command: "intelligence route",
        route: routeIntelligenceProfile(input),
      };
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
    outputSchema: VERIFY_OUTPUT_SCHEMA,
    async run(args) {
      const verification = await verifyRuntimeIntelligenceV1({
        threadId: args.threadId,
        turnId: args.turnId ?? null,
        model: args.model,
        effort: args.effort,
      });
      return {
        command: "intelligence verify",
        ...verification,
        // Mirrors the CLI, which exits nonzero for an unverified route.
        isError: verification.verified !== true,
      };
    },
  },
];

export function listNelosMcpTools() {
  return TOOLS.map(({ name, description, inputSchema, outputSchema }) => ({
    name,
    description,
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
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
    const response = {
      // The serialized text block is retained for clients that predate
      // structuredContent or negotiated an older protocol revision.
      content: [{ type: "text", text: JSON.stringify(body) }],
      isError,
    };
    // A tool that declares an outputSchema MUST return matching
    // structuredContent; the run() envelope is that structured value.
    if (tool.outputSchema) response.structuredContent = body;
    return response;
  }

  async function handle(message) {
    const { id, method, params } = message;
    const isRequest = id !== undefined && id !== null;
    if (method === "initialize") {
      // Negotiation rule: honor the client's version only when we support it;
      // otherwise answer with our latest and let the client decide.
      const requested = params?.protocolVersion;
      const protocolVersion =
        typeof requested === "string" &&
        SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
          ? requested
          : MCP_DEFAULT_PROTOCOL_VERSION;
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: serverVersion },
          instructions: MCP_INSTRUCTIONS,
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
