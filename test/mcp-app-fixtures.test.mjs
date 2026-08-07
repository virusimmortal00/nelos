import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { win32 } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  EXECUTION_MAP_FIXTURES,
  startMcpAppFixtureServer,
} from "../scripts/mcp-app-fixture-server.mjs";
import {
  MCP_APPS_SANDBOX_PORT,
  isPathWithin,
  resolveSandboxPort,
} from "../scripts/dev-mcp-app-ui.mjs";
import {
  EXECUTION_MAP_RESOURCE_MIME_TYPE,
  EXECUTION_MAP_RESOURCE_URI,
  EXECUTION_MAP_STATUSES,
} from "../src/execution-map.mjs";

test("execution-map visual fixtures cover the meaningful lifecycle states", () => {
  assert.deepEqual(EXECUTION_MAP_STATUSES, [
    "planning",
    "planned",
    "authorization-required",
    "launch-pending",
    "created",
    "unknown",
    "running",
    "attention",
    "complete",
    "accepted",
    "archiving",
    "archived",
    "kept",
  ]);
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
    "mixed_statuses",
    "large_history",
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

  const mixedStatuses = EXECUTION_MAP_FIXTURES.find(
    ({ key }) => key === "mixed_statuses",
  ).map.members.map(({ status }) => status);
  assert.deepEqual(
    [...new Set(mixedStatuses)].sort(),
    [...EXECUTION_MAP_STATUSES].sort(),
  );
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

test("the pinned reference host rejects an unreachable sandbox override", () => {
  assert.equal(MCP_APPS_SANDBOX_PORT, 8081);
  assert.equal(resolveSandboxPort(undefined), MCP_APPS_SANDBOX_PORT);
  assert.equal(resolveSandboxPort("8081"), MCP_APPS_SANDBOX_PORT);
  assert.throws(
    () => resolveSandboxPort("8181"),
    /pinned basic-host requires sandbox port 8081/u,
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

test("the production widget renders valid state from both MCP Apps and OpenAI bridges", async () => {
  const running = await startMcpAppFixtureServer({ port: 0 });
  const client = new Client({
    name: "nelos-widget-render-test",
    version: "1.0.0",
  });
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(running.url)),
    );
    const resource = await client.readResource({
      uri: EXECUTION_MAP_RESOURCE_URI,
    });
    const html = resource.contents[0]?.text ?? "";
    const source = html.match(
      /<script type="module">([\s\S]*?)<\/script>/u,
    )?.[1];
    assert.ok(source, "execution-map module script was not found");

    const listeners = new Map();
    const makeElement = (tagName) => ({
      tagName,
      className: "",
      textContent: "",
      title: "",
      dataset: {},
      attributes: {},
      children: [],
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = [...children]; },
      setAttribute(name, value) { this.attributes[name] = value; },
    });
    const membersElement = makeElement("ol");
    const parent = { postMessage() {} };
    const window = {
      parent,
      openai: undefined,
      addEventListener(type, listener) { listeners.set(type, listener); },
    };
    const document = {
      querySelector(selector) {
        assert.equal(selector, "#members");
        return membersElement;
      },
      createElement: makeElement,
    };
    const testableSource = source.slice(0, source.lastIndexOf("      try {"));
    runInNewContext(testableSource, {
      document,
      window,
      Map,
      Promise,
      String,
    });
    assert.equal(membersElement.children[0]?.textContent, "Waiting for task state…");

    const runningMap = EXECUTION_MAP_FIXTURES.find(
      ({ key }) => key === "running_subagent",
    ).map;
    listeners.get("message")({
      source: parent,
      data: {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { structuredContent: runningMap },
      },
    });
    assert.equal(membersElement.children.length, 1);
    assert.equal(membersElement.children[0].className, "member-group");
    assert.equal(membersElement.children[0].open, false);
    assert.equal(membersElement.children[0].dataset.status, "running");
    assert.equal(
      membersElement.children[0].children[0].textContent,
      "Running (1)",
    );
    assert.equal(
      membersElement.children[0].children[1].children[0].dataset.status,
      "running",
    );

    const acceptedMap = EXECUTION_MAP_FIXTURES.find(
      ({ key }) => key === "accepted_subagent",
    ).map;
    listeners.get("openai:set_globals")({
      detail: { globals: { toolOutput: acceptedMap } },
    });
    assert.equal(membersElement.children.length, 1);
    assert.equal(membersElement.children[0].open, false);
    assert.equal(
      membersElement.children[0].children[0].textContent,
      "Accepted (1)",
    );
    assert.equal(
      membersElement.children[0].children[1].children[0].dataset.status,
      "accepted",
    );

    const archivedMap = EXECUTION_MAP_FIXTURES.find(
      ({ key }) => key === "archived_spinoff",
    ).map;
    listeners.get("openai:set_globals")({
      detail: { globals: { toolOutput: archivedMap } },
    });
    assert.equal(membersElement.children[0].open, false);
    assert.equal(
      membersElement.children[0].children[0].textContent,
      "Archive (1)",
    );

    const mixedMap = EXECUTION_MAP_FIXTURES.find(
      ({ key }) => key === "mixed_statuses",
    ).map;
    listeners.get("openai:set_globals")({
      detail: { globals: { toolOutput: mixedMap } },
    });
    const expectedGroups = [
      ["planning", "Planning (1)"],
      ["planned", "Planned (1)"],
      ["authorization-required", "Authorization required (1)"],
      ["launch-pending", "Launch pending (1)"],
      ["created", "Created (1)"],
      ["unknown", "Unknown (1)"],
      ["running", "Running (2)"],
      ["attention", "Attention (1)"],
      ["complete", "Complete (1)"],
      ["accepted", "Accepted (1)"],
      ["archiving", "Archiving (1)"],
      ["archived", "Archive (2)"],
      ["kept", "Kept (1)"],
    ];
    assert.equal(membersElement.children.length, expectedGroups.length);
    for (const [index, [status, summary]] of expectedGroups.entries()) {
      const group = membersElement.children[index];
      assert.equal(group.tagName, "details");
      assert.equal(group.className, "member-group");
      assert.equal(group.dataset.status, status);
      assert.equal(group.open, false);
      assert.equal(group.children[0].tagName, "summary");
      assert.equal(group.children[0].textContent, summary);
      assert.equal(
        group.children[1].attributes["aria-label"],
        `${summary.replace(/ \(\d+\)$/u, "")} tasks`,
      );
      assert.ok(
        group.children[1].children.every(
          ({ dataset }) => dataset.status === status,
        ),
      );
    }
    const runningGroup = membersElement.children.find(
      ({ dataset }) => dataset.status === "running",
    );
    assert.deepEqual(
      runningGroup.children[1].children.map(
        ({ children }) => children[1].children[0].children[0].textContent,
      ),
      [
        "Exercise the compact worker row with a deliberately long task title",
        "Verify status rollup interaction",
      ],
    );
    const firstRunningRow = runningGroup.children[1].children[0];
    const firstRunningContent = firstRunningRow.children[1];
    const firstRunningMeta = firstRunningContent.children[1];
    assert.equal(firstRunningMeta.children.length, 4);
    assert.ok(
      firstRunningMeta.children.every(
        ({ className }) => className !== "tag status",
      ),
    );
    const taskIdTag = firstRunningMeta.children[3];
    const fullTaskId = "019fb49b-b447-7840-ace3-187079ef4e58";
    assert.equal(taskIdTag.className, "tag task-id");
    assert.equal(taskIdTag.textContent, `Task ${fullTaskId}`);
    assert.equal(taskIdTag.dataset.threadId, fullTaskId);
    assert.equal(
      taskIdTag.title,
      `Native Codex task identifier: ${fullTaskId}`,
    );
    assert.equal(
      taskIdTag.attributes["aria-label"],
      `Native Codex task identifier ${fullTaskId}`,
    );
    const archiveGroup = membersElement.children.find(
      ({ dataset }) => dataset.status === "archived",
    );
    assert.deepEqual(
      archiveGroup.children[1].children.map(
        ({ children }) => children[1].children[0].children[0].textContent,
      ),
      [
        "Archive the superseded implementation task",
        "Archive the historical verification task",
      ],
    );
    runningGroup.open = true;
    assert.equal(runningGroup.open, true);
    assert.equal(archiveGroup.open, false);

    const largeHistoryMap = EXECUTION_MAP_FIXTURES.find(
      ({ key }) => key === "large_history",
    ).map;
    listeners.get("openai:set_globals")({
      detail: { globals: { toolOutput: largeHistoryMap } },
    });
    assert.equal(membersElement.children.length, 2);
    assert.equal(membersElement.children[0].open, false);
    assert.equal(membersElement.children[1].open, false);
    assert.equal(
      membersElement.children[0].children[0].textContent,
      "Running (5)",
    );
    assert.equal(
      membersElement.children[1].children[0].textContent,
      "Archive (5)",
    );
  } finally {
    await client.close();
    await running.close();
  }
});
