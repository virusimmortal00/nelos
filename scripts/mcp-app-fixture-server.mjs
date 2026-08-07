#!/usr/bin/env node

import cors from "cors";
import {
  registerAppResource,
  registerAppTool,
} from "@modelcontextprotocol/ext-apps/server";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { z } from "zod";

import {
  EXECUTION_MAP_RESOURCE_MIME_TYPE,
  EXECUTION_MAP_RESOURCE_URI,
  EXECUTION_MAP_STATUSES,
  readExecutionMapResourceV1,
} from "../src/execution-map.mjs";

export const MCP_APP_FIXTURE_HOST = "127.0.0.1";
export const MCP_APP_FIXTURE_PORT = 3101;

const MEMBER_SCHEMA = z.object({
  id: z.string(),
  task: z.string(),
  lifecycle: z.enum(["spinoff", "subagent"]),
  model: z.string(),
  reasoning: z.string(),
  status: z.enum(EXECUTION_MAP_STATUSES),
  threadId: z.string().nullable(),
});

const EXECUTION_MAP_FIXTURE_SCHEMA = z.object({
  schemaVersion: z.literal(1),
  view: z.literal("execution-map"),
  phase: z.enum(EXECUTION_MAP_STATUSES),
  task: z.string(),
  summary: z.object({
    total: z.number().int().nonnegative(),
    spinoffs: z.number().int().nonnegative(),
    subagents: z.number().int().nonnegative(),
    created: z.number().int().nonnegative(),
    archived: z.number().int().nonnegative().optional(),
    running: z.number().int().nonnegative(),
    attention: z.number().int().nonnegative(),
    complete: z.number().int().nonnegative(),
    accepted: z.number().int().nonnegative(),
  }),
  members: z.array(MEMBER_SCHEMA),
});

function member({
  id,
  task,
  lifecycle = "subagent",
  model = "gpt-5.6-terra",
  reasoning = "medium",
  status,
  threadId = null,
}) {
  return {
    id,
    task,
    lifecycle,
    model,
    reasoning,
    status,
    threadId,
  };
}

function fixture({
  key,
  title,
  phase,
  task = "Smoke check execution map v7",
  members,
}) {
  return {
    key,
    toolName: `show_execution_map_${key}`,
    title,
    map: {
      schemaVersion: 1,
      view: "execution-map",
      phase,
      task,
      summary: {
        total: members.length,
        spinoffs: members.filter(({ lifecycle }) => lifecycle === "spinoff")
          .length,
        subagents: members.filter(({ lifecycle }) => lifecycle === "subagent")
          .length,
        created: members.filter(({ status }) => status === "created").length,
        running: members.filter(({ status }) => status === "running").length,
        attention: members.filter(({ status }) => status === "attention").length,
        complete: members.filter(({ status }) => status === "complete").length,
        accepted: members.filter(({ status }) => status === "accepted").length,
        archived: members.filter(({ status }) => status === "archived").length,
      },
      members,
    },
  };
}

export const EXECUTION_MAP_FIXTURES = Object.freeze([
  fixture({
    key: "planning_subagent",
    title: "Planning sub-agent",
    phase: "planning",
    members: [
      member({
        id: "planner",
        task: "Plan and classify the work",
        model: "gpt-5.6-sol",
        reasoning: "medium",
        status: "planning",
      }),
    ],
  }),
  fixture({
    key: "authorization_required",
    title: "Authorization required",
    phase: "authorization-required",
    members: [
      member({
        id: "api-contract",
        task: "Define the API contract",
        model: "gpt-5.6-sol",
        reasoning: "high",
        status: "authorization-required",
      }),
      member({
        id: "ui-smoke",
        task: "Smoke check execution map v7",
        model: "gpt-5.6-terra",
        reasoning: "medium",
        status: "authorization-required",
      }),
    ],
  }),
  fixture({
    key: "launch_pending_subagent",
    title: "Launch-pending sub-agent",
    phase: "launch-pending",
    members: [
      member({
        id: "ui-launch",
        task: "Smoke check execution map v7",
        model: "gpt-5.6-terra",
        reasoning: "low",
        status: "launch-pending",
      }),
    ],
  }),
  fixture({
    key: "unknown_subagent",
    title: "Sub-agent awaiting current execution evidence",
    phase: "unknown",
    members: [
      member({
        id: "ui-unknown",
        task: "Await authoritative current-turn evidence",
        model: "gpt-5.6-terra",
        reasoning: "low",
        status: "unknown",
        threadId: "019fb49b-b447-7840-ace3-187079ef4e58",
      }),
    ],
  }),
  fixture({
    key: "running_subagent",
    title: "Running sub-agent",
    phase: "running",
    members: [
      member({
        id: "ui-running",
        task: "Smoke check execution map v7",
        model: "gpt-5.6-terra",
        reasoning: "low",
        status: "running",
        threadId: "019fb49b-b447-7840-ace3-187079ef4e58",
      }),
    ],
  }),
  fixture({
    key: "complete_subagent",
    title: "Completed sub-agent",
    phase: "complete",
    members: [
      member({
        id: "ui-complete",
        task: "Smoke check execution map v7",
        model: "gpt-5.6-terra",
        reasoning: "low",
        status: "complete",
        threadId: "019fb49b-b447-7840-ace3-187079ef4e58",
      }),
    ],
  }),
  fixture({
    key: "accepted_subagent",
    title: "Accepted sub-agent result",
    phase: "accepted",
    members: [
      member({
        id: "ui-accepted",
        task: "Review the completed result",
        model: "gpt-5.6-terra",
        reasoning: "low",
        status: "accepted",
        threadId: "019fb49b-b447-7840-ace3-187079ef4e58",
      }),
    ],
  }),
  fixture({
    key: "created_spinoff",
    title: "Created spin-off",
    phase: "created",
    members: [
      member({
        id: "durable-created",
        task: "Verify the durable execution path",
        lifecycle: "spinoff",
        model: "gpt-5.6-luna",
        reasoning: "low",
        status: "created",
        threadId: "019fb4a1-2642-7bc2-a6ed-42de5c541d7c",
      }),
    ],
  }),
  fixture({
    key: "archiving_spinoff",
    title: "Archiving spin-off",
    phase: "archiving",
    members: [
      member({
        id: "durable-archiving",
        task: "Verify the durable execution path",
        lifecycle: "spinoff",
        model: "gpt-5.6-luna",
        reasoning: "low",
        status: "archiving",
        threadId: "019fb4a1-2642-7bc2-a6ed-42de5c541d7c",
      }),
    ],
  }),
  fixture({
    key: "archived_spinoff",
    title: "Archived spin-off",
    phase: "archived",
    members: [
      member({
        id: "durable-archived",
        task: "Verify the durable execution path",
        lifecycle: "spinoff",
        model: "gpt-5.6-luna",
        reasoning: "low",
        status: "archived",
        threadId: "019fb4a1-2642-7bc2-a6ed-42de5c541d7c",
      }),
    ],
  }),
  fixture({
    key: "mixed_statuses",
    title: "Mixed compact status rollups",
    phase: "attention",
    members: [
      member({
        id: "archived-a",
        task: "Archive the superseded implementation task",
        lifecycle: "spinoff",
        status: "archived",
        threadId: "thread-archived-a",
      }),
      member({
        id: "running-a",
        task: "Exercise the compact worker row with a deliberately long task title",
        status: "running",
        threadId: "019fb49b-b447-7840-ace3-187079ef4e58",
      }),
      member({
        id: "planning",
        task: "Plan the status-grouped execution map",
        model: "gpt-5.6-sol",
        status: "planning",
      }),
      member({
        id: "kept",
        task: "Keep the accepted reusable worker",
        lifecycle: "spinoff",
        status: "kept",
        threadId: "thread-kept",
      }),
      member({
        id: "launch-pending",
        task: "Wait for the native launch receipt",
        status: "launch-pending",
      }),
      member({
        id: "accepted",
        task: "Record the accepted worker result",
        status: "accepted",
        threadId: "thread-accepted",
      }),
      member({
        id: "created",
        task: "Bind the newly created durable worker",
        lifecycle: "spinoff",
        status: "created",
        threadId: "thread-created",
      }),
      member({
        id: "unknown",
        task: "Await authoritative turn evidence",
        status: "unknown",
        threadId: "thread-unknown",
      }),
      member({
        id: "complete",
        task: "Complete the focused implementation",
        status: "complete",
        threadId: "thread-complete",
      }),
      member({
        id: "authorization-required",
        task: "Request launch authorization",
        model: "gpt-5.6-sol",
        status: "authorization-required",
      }),
      member({
        id: "archiving",
        task: "Archive the completed spin-off",
        lifecycle: "spinoff",
        status: "archiving",
        threadId: "thread-archiving",
      }),
      member({
        id: "planned",
        task: "Hold the planned follow-up",
        status: "planned",
      }),
      member({
        id: "attention",
        task: "Review mismatched worker evidence",
        model: "gpt-5.6-sol",
        status: "attention",
        threadId: "thread-attention",
      }),
      member({
        id: "running-b",
        task: "Verify status rollup interaction",
        lifecycle: "spinoff",
        status: "running",
        threadId: "thread-running-b",
      }),
      member({
        id: "archived-b",
        task: "Archive the historical verification task",
        lifecycle: "spinoff",
        status: "archived",
        threadId: "thread-archived-b",
      }),
    ],
  }),
  fixture({
    key: "large_history",
    title: "Large collapsible task-web history",
    phase: "running",
    members: [
      ...Array.from({ length: 5 }, (_, index) =>
        member({
          id: `current-${index + 1}`,
          task: `🕷️B8.${index + 1} · Current worker ${index + 1}`,
          lifecycle: "spinoff",
          status: "running",
          threadId: `thread-current-${index + 1}`,
        })),
      ...Array.from({ length: 5 }, (_, index) =>
        member({
          id: `archived-${index + 1}`,
          task: `🕷️B8.${index + 6} · Archived worker ${index + 1}`,
          lifecycle: "spinoff",
          status: "archived",
          threadId: `thread-archived-${index + 1}`,
        })),
    ],
  }),
  fixture({
    key: "attention_subagent",
    title: "Sub-agent needing attention",
    phase: "attention",
    members: [
      member({
        id: "ui-attention",
        task: "Reconcile unavailable worker evidence",
        model: "gpt-5.6-sol",
        reasoning: "medium",
        status: "attention",
        threadId: "019fb4a9-5cdf-7f7b-8a54-5db52dd4b8e1",
      }),
    ],
  }),
]);

export function createMcpAppFixtureServer() {
  const server = new McpServer({
    name: "Nelos execution map fixtures",
    version: "1.0.0",
  });

  for (const current of EXECUTION_MAP_FIXTURES) {
    registerAppTool(
      server,
      current.toolName,
      {
        title: current.title,
        description:
          `Use this when visually testing the ${current.title.toLowerCase()} execution-map state.`,
        inputSchema: {},
        outputSchema: EXECUTION_MAP_FIXTURE_SCHEMA,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: false,
          idempotentHint: true,
        },
        _meta: {
          ui: { resourceUri: EXECUTION_MAP_RESOURCE_URI },
          "openai/outputTemplate": EXECUTION_MAP_RESOURCE_URI,
        },
      },
      async () => ({
        structuredContent: structuredClone(current.map),
        content: [{
          type: "text",
          text: `Showing deterministic fixture: ${current.title}.`,
        }],
        _meta: { fixture: current.key },
      }),
    );
  }

  registerAppResource(
    server,
    "nelos-execution-map",
    EXECUTION_MAP_RESOURCE_URI,
    { mimeType: EXECUTION_MAP_RESOURCE_MIME_TYPE },
    async () => readExecutionMapResourceV1(EXECUTION_MAP_RESOURCE_URI),
  );

  return server;
}

export async function startMcpAppFixtureServer({
  host = MCP_APP_FIXTURE_HOST,
  port = MCP_APP_FIXTURE_PORT,
} = {}) {
  const app = createMcpExpressApp({ host });
  app.use(cors());
  app.get("/healthz", (_request, response) => {
    response.json({
      ok: true,
      fixtures: EXECUTION_MAP_FIXTURES.map(({ key }) => key),
    });
  });
  app.all("/mcp", async (request, response) => {
    const server = createMcpAppFixtureServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    response.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(request, response, request.body);
    } catch (error) {
      if (!response.headersSent) {
        response.status(500).json({
          jsonrpc: "2.0",
          error: {
            code: -32603,
            message: "Fixture server request failed",
          },
          id: null,
        });
      }
      process.stderr.write(
        `nelos-mcp-app-fixtures: ${error.message}\n`,
      );
    }
  });

  const httpServer = await new Promise((resolveServer, reject) => {
    const candidate = app.listen(port, host, () => resolveServer(candidate));
    candidate.once("error", reject);
  });
  const address = httpServer.address();
  const boundPort =
    address && typeof address === "object" ? address.port : port;

  return {
    host,
    port: boundPort,
    url: `http://${host}:${boundPort}/mcp`,
    close: () =>
      new Promise((resolveClose, reject) => {
        httpServer.close((error) => {
          if (error) reject(error);
          else resolveClose();
        });
      }),
  };
}

const entryPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (entryPath && fileURLToPath(import.meta.url) === entryPath) {
  const port = Number.parseInt(
    process.env.NELOS_MCP_APP_FIXTURE_PORT ??
      String(MCP_APP_FIXTURE_PORT),
    10,
  );
  const running = await startMcpAppFixtureServer({ port });
  process.stdout.write(`Fixture MCP server: ${running.url}\n`);

  const shutdown = async () => {
    await running.close();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
