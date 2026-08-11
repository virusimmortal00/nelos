#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_ACTION_SCHEMA_V1 } from "../src/protocol-contract/index.mjs";
import {
  ACTION_RECEIPT_RESOURCE_URI,
  ACTION_RECEIPT_TOOL_NAMES,
  EXECUTION_MAP_RESOURCE_MIME_TYPE,
  EXECUTION_MAP_RESOURCE_URI,
  EXECUTION_MAP_TOOL_NAMES,
  PLAN_SUMMARY_RESOURCE_URI,
  PLAN_SUMMARY_TOOL_NAMES,
} from "../src/execution-map.mjs";

const INSPECTOR_PACKAGE = "@modelcontextprotocol/inspector@2.0.0";
const PROTOCOL_TOOLS = new Set([
  "nelos_plan_lifecycle",
  "nelos_launch_authorize",
  "nelos_launch_verify_batch",
  "nelos_orchestrate_create",
  "nelos_orchestrate_advance",
  "nelos_queen_decide",
  "nelos_spinoff_complete",
  "nelos_spinoff_cleanup",
]);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";

function assertInspectorRuntime() {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error(
      "MCP Inspector 2.0.0 requires Node.js 22.19.0 or newer; " +
        `current runtime is ${process.versions.node}`,
    );
  }
}

function inspectorArguments(...args) {
  return [
    "--yes",
    INSPECTOR_PACKAGE,
    "--cli",
    process.execPath,
    "bin/nelos-mcp",
    ...args,
  ];
}

function runInspector(args, { expectedStatus = 0 } = {}) {
  const result = spawnSync(npxCommand, inspectorArguments(...args), {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      npm_config_loglevel: "error",
    },
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    expectedStatus,
    [
      `Inspector exited ${result.status}; expected ${expectedStatus}.`,
      result.stdout.trim(),
      result.stderr.trim(),
    ]
      .filter(Boolean)
      .join("\n"),
  );
  return {
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} was not valid JSON: ${error.message}`);
  }
}

function verifyInitialize() {
  const { stdout } = runInspector([
    "--method",
    "initialize",
    "--format",
    "json",
  ]);
  const { result } = parseJson(stdout, "initialize result");
  assert.equal(result.serverInfo?.name, "nelos");
  assert.ok(result.capabilities?.tools);
  assert.ok(result.capabilities?.resources);
  console.log("✓ initialize negotiated tools and resources");
}

function verifyAppBindings() {
  const { stdout } = runInspector([
    "--method",
    "tools/list",
    "--app-info",
  ]);
  const records = stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => parseJson(line, "app-info record"));
  const byTool = new Map(records.map((record) => [record.toolName, record]));

  for (const toolName of EXECUTION_MAP_TOOL_NAMES) {
    const record = byTool.get(toolName);
    assert.ok(record, `Inspector omitted app-info for ${toolName}`);
    assert.equal(record.hasApp, true, `${toolName} did not advertise an app`);
    const expectedUri = PLAN_SUMMARY_TOOL_NAMES.has(toolName)
      ? PLAN_SUMMARY_RESOURCE_URI
      : ACTION_RECEIPT_TOOL_NAMES.has(toolName)
        ? ACTION_RECEIPT_RESOURCE_URI
        : EXECUTION_MAP_RESOURCE_URI;
    assert.equal(record.resourceUri, expectedUri);
    assert.equal(record.resourceMimeType, EXECUTION_MAP_RESOURCE_MIME_TYPE);
    assert.equal(record.prefersBorder, true);
    assert.deepEqual(record.csp, {
      connectDomains: [],
      resourceDomains: [],
    });
  }
  console.log(`✓ ${EXECUTION_MAP_TOOL_NAMES.size} tool-to-app bindings resolved`);
}

function verifyOutputSchemas() {
  const { stdout } = runInspector([
    "--method",
    "tools/list",
    "--format",
    "json",
  ]);
  const tools = parseJson(stdout, "tools/list result").result?.tools ?? [];
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  for (const toolName of PROTOCOL_TOOLS) {
    assert.ok(
      byName.get(toolName)?.outputSchema,
      `${toolName} did not advertise an output schema`,
    );
  }

  const expectedActionMembers = PROTOCOL_ACTION_SCHEMA_V1.oneOf.length;
  assert.equal(
    byName.get("nelos_plan_lifecycle")?.outputSchema?.properties?.protocol
      ?.properties?.result?.properties?.nextAction?.oneOf?.length,
    expectedActionMembers,
  );
  assert.equal(
    byName.get("nelos_orchestrate_advance")?.outputSchema?.properties
      ?.protocol?.properties?.result?.properties?.nextAction?.oneOf?.length,
    expectedActionMembers,
  );

  const cleanupSchema =
    byName.get("nelos_spinoff_cleanup")?.outputSchema?.properties;
  assert.equal(cleanupSchema?.view?.const, "action-receipt");
  assert.ok(cleanupSchema?.status?.enum?.includes("archiving"));
  assert.equal(cleanupSchema?.metrics?.type, "array");
  assert.equal(
    cleanupSchema?.protocol?.properties?.tool?.const,
    "nelos_spinoff_cleanup",
  );
  console.log(
    `✓ protocol output schemas expose all ${expectedActionMembers} action variants and compact cleanup receipts`,
  );
}

function verifyResource() {
  const listed = parseJson(
    runInspector([
      "--method",
      "resources/list",
      "--format",
      "json",
    ]).stdout,
    "resources/list result",
  );
  const resources = new Map(
    (listed.result?.resources ?? []).map((resource) => [resource.uri, resource]),
  );
  for (const uri of [
    EXECUTION_MAP_RESOURCE_URI,
    PLAN_SUMMARY_RESOURCE_URI,
    ACTION_RECEIPT_RESOURCE_URI,
  ]) {
    assert.ok(resources.has(uri), `${uri} was not listed`);
    assert.equal(
      resources.get(uri).mimeType,
      EXECUTION_MAP_RESOURCE_MIME_TYPE,
    );
  }

  const read = parseJson(
    runInspector([
      "--method",
      "resources/read",
      "--uri",
      EXECUTION_MAP_RESOURCE_URI,
      "--format",
      "json",
    ]).stdout,
    "resources/read result",
  );
  const content = read.result?.contents?.[0];
  assert.equal(content?.uri, EXECUTION_MAP_RESOURCE_URI);
  assert.equal(content?.mimeType, EXECUTION_MAP_RESOURCE_MIME_TYPE);
  assert.match(content?.text ?? "", /ui\/initialize/u);
  assert.match(content?.text ?? "", /ui\/notifications\/tool-result/u);
  assert.match(content?.text ?? "", /ui\/notifications\/size-changed/u);
  assert.match(content?.text ?? "", /ui\/notifications\/host-context-changed/u);
  assert.match(content?.text ?? "", /ResizeObserver/u);
  assert.match(content?.text ?? "", /root\.style\.height = "max-content"/u);
  assert.match(content?.text ?? "", /window\.openai\?\.toolOutput/u);
  assert.match(content?.text ?? "", /openai:set_globals/u);
  assert.match(content?.text ?? "", /Loading worker state/u);
  assert.match(content?.text ?? "", /Worker status unavailable/u);
  assert.match(content?.text ?? "", /--archived/u);
  assert.match(content?.text ?? "", /className = "member-heading"/u);
  assert.match(content?.text ?? "", /INTENT_GROUPS/u);
  assert.match(content?.text ?? "", /title: "Needs input"/u);
  assert.match(content?.text ?? "", /title: "In progress"/u);
  assert.match(content?.text ?? "", /title: "Queued"/u);
  assert.match(content?.text ?? "", /id="filter-current"/u);
  assert.match(content?.text ?? "", /id="filter-done"/u);
  assert.match(content?.text ?? "", /id="filter-history"/u);
  assert.doesNotMatch(content?.text ?? "", /Expand active/u);
  assert.match(content?.text ?? "", /currentViewKey/u);
  assert.match(content?.text ?? "", /currentFilter/u);
  assert.match(content?.text ?? "", /openGroupState/u);
  assert.match(content?.text ?? "", /applyHostContext/u);
  assert.match(content?.text ?? "", /id="host-fonts"/u);
  assert.match(content?.text ?? "", /styles\?\.css\?\.fonts/u);
  assert.match(content?.text ?? "", /id="members"[\s\S]*?role="group"[\s\S]*?aria-label="Nelos task workers"/u);
  assert.match(content?.text ?? "", /role="status"/u);
  assert.match(content?.text ?? "", /document\.createElement\("details"\)/u);
  assert.match(content?.text ?? "", /STATUS_GROUPS/u);
  assert.match(content?.text ?? "", /title: "Launch pending"/u);
  assert.match(content?.text ?? "", /title: "Archive"/u);
  assert.match(content?.text ?? "", /"task-id"/u);
  assert.match(content?.text ?? "", /padding: 7px 9px/u);
  assert.match(content?.text ?? "", /"Sub-agent"/u);
  assert.match(content?.text ?? "", /prefers-reduced-motion: reduce/u);
  assert.match(content?.text ?? "", /@keyframes status-pulse/u);
  assert.doesNotMatch(content?.text ?? "", /"Joined subagent"/u);
  assert.doesNotMatch(content?.text ?? "", /--danger/u);
  assert.doesNotMatch(content?.text ?? "", /<main aria-live=/u);
  assert.doesNotMatch(content?.text ?? "", /<header>/u);
  assert.doesNotMatch(content?.text ?? "", /class="eyebrow"/u);
  assert.doesNotMatch(content?.text ?? "", /id="phase"/u);
  assert.doesNotMatch(content?.text ?? "", /phaseElement/u);
  assert.doesNotMatch(content?.text ?? "", /id="summary"/u);
  assert.doesNotMatch(content?.text ?? "", /className = "metric"/u);
  assert.doesNotMatch(content?.text ?? "", /Current tasks/u);
  assert.doesNotMatch(content?.text ?? "", /Archived history/u);
  for (const [uri, pattern] of [
    [PLAN_SUMMARY_RESOURCE_URI, /Preparing plan/u],
    [ACTION_RECEIPT_RESOURCE_URI, /Processing action/u],
  ]) {
    const response = parseJson(
      runInspector([
        "--method",
        "resources/read",
        "--uri",
        uri,
        "--format",
        "json",
      ]).stdout,
      `resources/read ${uri} result`,
    );
    assert.match(response.result?.contents?.[0]?.text ?? "", pattern);
  }
  console.log("✓ purpose-built visual resources listed and read");
}

function verifyRepresentativeCall() {
  const { stdout } = runInspector([
    "--method",
    "tools/call",
    "--tool-name",
    "nelos_plan_bootstrap",
    "--tool-args-json",
    JSON.stringify({ objective: "Plan a visible task web receipt" }),
    "--format",
    "json",
  ]);
  const envelope = parseJson(stdout, "tools/call result");
  assert.equal(envelope.appInfo?.resourceUri, PLAN_SUMMARY_RESOURCE_URI);
  assert.equal(envelope.result?.isError, false);
  assert.equal(envelope.result?.structuredContent?.view, "plan-summary");
  assert.equal(envelope.result?.structuredContent?.phase, "planning");
  assert.equal(envelope.result?.structuredContent?.summary?.total, 1);
  assert.equal(
    envelope.result?.structuredContent?.members?.[0]?.model,
    "gpt-5.6-sol",
  );
  assert.equal(
    envelope.result?.structuredContent?.members?.[0]?.reasoning,
    "medium",
  );
  assert.equal(
    envelope.result?.structuredContent?.protocol?.schemaVersion,
    1,
  );
  assert.equal(
    envelope.result?.structuredContent?.protocol?.tool,
    "nelos_plan_bootstrap",
  );
  assert.equal(
    envelope.result?.structuredContent?.protocol?.result?.nextAction?.kind,
    "launch-planner",
  );
  console.log(
    "✓ representative planning call returned visual and protocol-complete structured content",
  );
}

function verifyInvalidCall() {
  const { stdout, stderr } = runInspector(
    [
      "--method",
      "tools/call",
      "--tool-name",
      "nelos_plan_bootstrap",
      "--tool-args-json",
      JSON.stringify({
        objective: "Plan a visible task web receipt",
        unexpected: true,
      }),
      "--format",
      "json",
    ],
    { expectedStatus: 5 },
  );
  const envelope = parseJson(stdout, "invalid tools/call result");
  assert.equal(envelope.result?.isError, true);
  assert.match(
    envelope.result?.content?.[0]?.text ?? "",
    /does not accept argument unexpected/u,
  );
  const errorEnvelope = parseJson(
    stderr.split(/\r?\n/u).filter(Boolean).at(-1),
    "Inspector error envelope",
  );
  assert.equal(errorEnvelope.error?.code, "tool_is_error");
  console.log("✓ invalid tool input produced Inspector tool_is_error");
}

function openInspector() {
  const child = spawn(
    npxCommand,
    [
      "--yes",
      INSPECTOR_PACKAGE,
      process.execPath,
      "bin/nelos-mcp",
    ],
    {
      cwd: repositoryRoot,
      env: process.env,
      stdio: "inherit",
    },
  );
  child.on("error", (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    if (signal) {
      console.error(`MCP Inspector exited after signal ${signal}`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = code ?? 1;
  });
}

assertInspectorRuntime();
if (process.argv.includes("--web")) {
  openInspector();
} else {
  verifyInitialize();
  verifyAppBindings();
  verifyOutputSchemas();
  verifyResource();
  verifyRepresentativeCall();
  verifyInvalidCall();
  console.log(`MCP App verification passed with ${INSPECTOR_PACKAGE}.`);
}
