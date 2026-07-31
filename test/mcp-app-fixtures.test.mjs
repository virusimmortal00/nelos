import assert from "node:assert/strict";
import { win32 } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  EXECUTION_MAP_FIXTURES,
  startMcpAppFixtureServer,
} from "../scripts/mcp-app-fixture-server.mjs";
import { isPathWithin } from "../scripts/dev-mcp-app-ui.mjs";
import {
  EXECUTION_MAP_RESOURCE_MIME_TYPE,
  EXECUTION_MAP_RESOURCE_URI,
} from "../src/execution-map.mjs";

test("execution-map visual fixtures cover the meaningful lifecycle states", () => {
  const keys = EXECUTION_MAP_FIXTURES.map(({ key }) => key);
  assert.deepEqual(keys, [
    "planning_subagent",
    "authorization_required",
    "launch_pending_subagent",
    "unknown_subagent",
    "running_subagent",
    "complete_subagent",
    "accepted_subagent",
    "created_spinoff",
    "archiving_spinoff",
    "archived_spinoff",
    "attention_subagent",
  ]);
  assert.equal(new Set(keys).size, keys.length);
  assert.equal(
    new Set(EXECUTION_MAP_FIXTURES.map(({ toolName }) => toolName)).size,
    EXECUTION_MAP_FIXTURES.length,
  );

  for (const current of EXECUTION_MAP_FIXTURES) {
    assert.equal(current.map.view, "execution-map");
    assert.equal(current.map.summary.total, current.map.members.length);
    assert.equal(
      current.map.summary.spinoffs + current.map.summary.subagents,
      current.map.summary.total,
    );
    assert.equal(
      current.map.summary.archived,
      current.map.members.filter(({ status }) => status === "archived").length,
    );
  }
});

test("reference-host cache containment is platform-aware", () => {
  assert.equal(
    isPathWithin(
      String.raw`C:\nelos-cache`,
      String.raw`C:\nelos-cache\reviewed-commit`,
      win32,
    ),
    true,
  );
  assert.equal(
    isPathWithin(
      String.raw`C:\nelos-cache`,
      String.raw`C:\nelos-cache-sibling\reviewed-commit`,
      win32,
    ),
    false,
  );
  assert.equal(
    isPathWithin(
      String.raw`C:\nelos-cache`,
      String.raw`D:\nelos-cache\reviewed-commit`,
      win32,
    ),
    false,
  );
});

test("official MCP SDK reaches every fixture and the production UI resource", async () => {
  const running = await startMcpAppFixtureServer({ port: 0 });
  const client = new Client({
    name: "nelos-mcp-app-fixture-test",
    version: "1.0.0",
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(running.url)),
    );
    const listed = await client.listTools();
    assert.deepEqual(
      listed.tools.map(({ name }) => name).sort(),
      EXECUTION_MAP_FIXTURES.map(({ toolName }) => toolName).sort(),
    );
    for (const current of EXECUTION_MAP_FIXTURES) {
      const descriptor = listed.tools.find(
        ({ name }) => name === current.toolName,
      );
      assert.equal(
        descriptor?._meta?.ui?.resourceUri,
        EXECUTION_MAP_RESOURCE_URI,
      );
      const result = await client.callTool({
        name: current.toolName,
        arguments: {},
      });
      assert.equal(result.isError, undefined);
      assert.deepEqual(result.structuredContent, current.map);
    }

    const resource = await client.readResource({
      uri: EXECUTION_MAP_RESOURCE_URI,
    });
    assert.equal(resource.contents[0]?.uri, EXECUTION_MAP_RESOURCE_URI);
    assert.equal(
      resource.contents[0]?.mimeType,
      EXECUTION_MAP_RESOURCE_MIME_TYPE,
    );
    assert.match(resource.contents[0]?.text ?? "", /member-heading/u);
    assert.match(
      resource.contents[0]?._meta?.["openai/widgetDescription"] ?? "",
      /model, reasoning level, lifecycle, and current status/u,
    );
  } finally {
    await client.close();
    await running.close();
  }
});
