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

async function mountExecutionMapWidget(source, {
  hostContext = {
    theme: "light",
    styles: {
      variables: {
        "--color-text-primary": "rgb(20, 21, 24)",
        "--color-background-primary": "rgb(255, 255, 255)",
      },
      css: {
        fonts: '@font-face { font-family: "Fixture Sans"; src: local("Arial"); }',
      },
    },
    platform: "desktop",
    deviceCapabilities: { touch: false, hover: true },
    safeAreaInsets: { top: 0, right: 0, bottom: 0, left: 0 },
  },
} = {}) {
  const windowListeners = new Map();
  const animationFrames = [];
  const observers = [];
  const postedMessages = [];
  const elementsById = new Map();
  let document;

  const styleDeclaration = () => {
    const properties = new Map();
    return {
      colorScheme: "",
      height: "",
      getPropertyValue(name) {
        return properties.get(name) ?? "";
      },
      setProperty(name, value) {
        properties.set(name, String(value));
      },
    };
  };

  const hasClass = (element, className) =>
    String(element.className || "").split(/\s+/u).includes(className);

  const makeElement = (tagName, id = "") => {
    const eventListeners = new Map();
    let open = false;
    const element = {
      tagName: tagName.toLowerCase(),
      id,
      className: "",
      textContent: "",
      title: "",
      dataset: {},
      attributes: {},
      children: [],
      parentElement: null,
      hidden: false,
      style: styleDeclaration(),
      append(...children) {
        for (const child of children) {
          if (!child || typeof child === "string") continue;
          child.parentElement = this;
          this.children.push(child);
        }
      },
      replaceChildren(...children) {
        const focusedChild = this.contains(document.activeElement);
        for (const child of this.children) child.parentElement = null;
        this.children = [];
        this.append(...children);
        if (focusedChild) document.activeElement = document.body;
      },
      setAttribute(name, value) {
        this.attributes[name] = String(value);
      },
      getAttribute(name) {
        return this.attributes[name] ?? null;
      },
      addEventListener(type, listener) {
        const current = eventListeners.get(type) ?? [];
        current.push(listener);
        eventListeners.set(type, current);
      },
      dispatchEvent(event) {
        event.target ??= this;
        for (const listener of eventListeners.get(event.type) ?? []) {
          listener.call(this, event);
        }
        return true;
      },
      click() {
        this.dispatchEvent({ type: "click" });
        if (this.tagName === "summary" && this.parentElement?.tagName === "details") {
          this.parentElement.open = !this.parentElement.open;
        }
      },
      focus() {
        document.activeElement = this;
      },
      contains(candidate) {
        if (!candidate) return false;
        if (candidate === this) return true;
        return this.children.some((child) => child.contains(candidate));
      },
      closest(selector) {
        if (selector === ".member-group" && hasClass(this, "member-group")) {
          return this;
        }
        return this.parentElement?.closest(selector) ?? null;
      },
      querySelectorAll(selector) {
        const matches = [];
        const className = selector.startsWith(".") ? selector.slice(1) : null;
        const visit = (candidate) => {
          if (className && hasClass(candidate, className)) matches.push(candidate);
          for (const child of candidate.children) visit(child);
        };
        for (const child of this.children) visit(child);
        return matches;
      },
      querySelector(selector) {
        return this.querySelectorAll(selector)[0] ?? null;
      },
      getBoundingClientRect() {
        return { width: 0, height: 0 };
      },
    };
    Object.defineProperty(element, "open", {
      get() {
        return open;
      },
      set(value) {
        const next = Boolean(value);
        if (next === open) return;
        open = next;
        element.dispatchEvent({ type: "toggle" });
      },
    });
    if (id) elementsById.set(id, element);
    return element;
  };

  const documentElement = makeElement("html");
  const head = makeElement("head");
  const hostFontsElement = makeElement("style", "host-fonts");
  head.append(hostFontsElement);
  const body = makeElement("body");
  const main = makeElement("main");
  const groupActionsElement = makeElement("div", "group-actions");
  groupActionsElement.className = "group-actions";
  groupActionsElement.hidden = true;
  const bulkToggleElement = makeElement("button", "bulk-toggle");
  bulkToggleElement.className = "bulk-toggle";
  bulkToggleElement.textContent = "Expand active";
  bulkToggleElement.setAttribute("aria-expanded", "false");
  const membersElement = makeElement("div", "members");
  membersElement.className = "groups";
  const updateStatusElement = makeElement("p", "update-status");
  updateStatusElement.className = "sr-only";
  groupActionsElement.append(bulkToggleElement);
  main.append(groupActionsElement, membersElement, updateStatusElement);
  body.append(main);
  documentElement.append(head, body);

  const syntheticHeight = () => {
    let height = 28;
    if (!groupActionsElement.hidden) height += 26;
    for (const child of membersElement.children) {
      if (hasClass(child, "empty")) {
        height += 50;
        continue;
      }
      if (!hasClass(child, "member-group")) continue;
      height += 22;
      if (child.open) height += 4 + (child.children[1]?.children.length ?? 0) * 36;
    }
    height += Number.parseFloat(
      documentElement.style.getPropertyValue("--nelos-safe-area-top") || "0",
    );
    height += Number.parseFloat(
      documentElement.style.getPropertyValue("--nelos-safe-area-bottom") || "0",
    );
    return height;
  };
  documentElement.getBoundingClientRect = () => ({
    width: window.innerWidth,
    height: syntheticHeight(),
  });

  document = {
    activeElement: body,
    body,
    documentElement,
    head,
    createElement: makeElement,
    getElementById(id) {
      return elementsById.get(id) ?? null;
    },
    querySelector(selector) {
      if (!selector.startsWith("#")) return null;
      return elementsById.get(selector.slice(1)) ?? null;
    },
  };

  const dispatchWindowEvent = (type, event) => {
    for (const listener of windowListeners.get(type) ?? []) listener(event);
  };
  const parent = {
    postMessage(message) {
      postedMessages.push(message);
      if (message.method !== "ui/initialize" || message.id === undefined) return;
      dispatchWindowEvent("message", {
        source: parent,
        data: {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: "2026-01-26",
            hostInfo: { name: "fixture-host", version: "1.0.0" },
            hostCapabilities: {},
            hostContext,
          },
        },
      });
    },
  };

  class FakeResizeObserver {
    constructor(callback) {
      this.callback = callback;
      this.observed = [];
      observers.push(this);
    }
    observe(element) {
      this.observed.push(element);
    }
    disconnect() {
      this.observed = [];
    }
  }

  const window = {
    ResizeObserver: FakeResizeObserver,
    innerWidth: 760,
    openai: undefined,
    parent,
    addEventListener(type, listener) {
      const current = windowListeners.get(type) ?? [];
      current.push(listener);
      windowListeners.set(type, current);
    },
    requestAnimationFrame(callback) {
      animationFrames.push(callback);
      return animationFrames.length;
    },
  };

  const flushAnimationFrames = () => {
    while (animationFrames.length > 0) {
      const current = animationFrames.splice(0);
      for (const callback of current) callback(0);
    }
  };
  const sendToolResult = (map) => {
    dispatchWindowEvent("message", {
      source: parent,
      data: {
        jsonrpc: "2.0",
        method: "ui/notifications/tool-result",
        params: { structuredContent: map },
      },
    });
    flushAnimationFrames();
  };
  const sendOpenAIResult = (map) => {
    dispatchWindowEvent("openai:set_globals", {
      detail: { globals: { toolOutput: map } },
    });
    flushAnimationFrames();
  };
  const sendHostContext = (params) => {
    dispatchWindowEvent("message", {
      source: parent,
      data: {
        jsonrpc: "2.0",
        method: "ui/notifications/host-context-changed",
        params,
      },
    });
    flushAnimationFrames();
  };
  const triggerResize = () => {
    for (const observer of observers) observer.callback([]);
    flushAnimationFrames();
  };

  await runInNewContext(`(async () => {${source}})()`, {
    console: { debug() {} },
    document,
    window,
  });
  flushAnimationFrames();

  return {
    bulkToggleElement,
    document,
    documentElement,
    flushAnimationFrames,
    groupActionsElement,
    hostFontsElement,
    membersElement,
    observers,
    postedMessages,
    sendHostContext,
    sendOpenAIResult,
    sendToolResult,
    triggerResize,
    updateStatusElement,
    window,
  };
}

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

    const widget = await mountExecutionMapWidget(source);
    const {
      bulkToggleElement,
      document,
      documentElement,
      flushAnimationFrames,
      groupActionsElement,
      hostFontsElement,
      membersElement,
      observers,
      postedMessages,
      sendHostContext,
      sendOpenAIResult,
      sendToolResult,
      triggerResize,
      updateStatusElement,
    } = widget;
    assert.equal(membersElement.tagName, "div");
    assert.equal(membersElement.children[0]?.tagName, "p");
    assert.equal(membersElement.children[0]?.textContent, "Waiting for task state…");
    assert.equal(documentElement.dataset.theme, "light");
    assert.equal(documentElement.style.colorScheme, "light");
    assert.equal(
      hostFontsElement.textContent,
      '@font-face { font-family: "Fixture Sans"; src: local("Arial"); }',
    );
    assert.equal(
      documentElement.style.getPropertyValue("--color-text-primary"),
      "rgb(20, 21, 24)",
    );
    assert.equal(observers.length, 1);
    assert.deepEqual(observers[0].observed, [documentElement, document.body]);

    const runningMap = EXECUTION_MAP_FIXTURES.find(
      ({ key }) => key === "running_subagent",
    ).map;
    sendToolResult(runningMap);
    assert.equal(membersElement.children.length, 1);
    assert.equal(membersElement.children[0].className, "member-group");
    assert.equal(membersElement.children[0].open, false);
    assert.equal(groupActionsElement.hidden, true);
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
    sendOpenAIResult(acceptedMap);
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
    sendOpenAIResult(archivedMap);
    assert.equal(membersElement.children[0].open, false);
    assert.equal(
      membersElement.children[0].children[0].textContent,
      "Archive (1)",
    );

    const mixedMap = EXECUTION_MAP_FIXTURES.find(
      ({ key }) => key === "mixed_statuses",
    ).map;
    sendOpenAIResult(mixedMap);
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
    assert.equal(groupActionsElement.hidden, false);
    assert.equal(bulkToggleElement.textContent, "Expand active");
    assert.equal(bulkToggleElement.attributes["aria-expanded"], "false");
    assert.equal(
      updateStatusElement.textContent,
      "Execution map updated: 15 tasks in 13 statuses.",
    );

    const sizeMessages = () => postedMessages.filter(
      ({ method }) => method === "ui/notifications/size-changed",
    );
    const collapsedHeight = sizeMessages().at(-1).params.height;
    const runningSummary = runningGroup.children[0];
    runningSummary.focus();
    runningSummary.click();
    flushAnimationFrames();
    assert.equal(runningGroup.open, true);
    assert.equal(archiveGroup.open, false);
    assert.equal(bulkToggleElement.textContent, "Collapse all");
    assert.ok(sizeMessages().at(-1).params.height > collapsedHeight);

    const updatedMixedMap = JSON.parse(JSON.stringify(mixedMap));
    updatedMixedMap.members.find(({ id }) => id === "running-b").task =
      "Verify retained status rollup interaction";
    sendOpenAIResult(updatedMixedMap);
    const updatedRunningGroup = membersElement.children.find(
      ({ dataset }) => dataset.status === "running",
    );
    assert.notEqual(updatedRunningGroup, runningGroup);
    assert.equal(updatedRunningGroup.open, true);
    assert.equal(document.activeElement, updatedRunningGroup.children[0]);
    assert.equal(
      updatedRunningGroup.children[1].children[1]
        .children[1].children[0].children[0].textContent,
      "Verify retained status rollup interaction",
    );

    bulkToggleElement.click();
    flushAnimationFrames();
    assert.ok(membersElement.children.every(({ open }) => open === false));
    assert.equal(bulkToggleElement.textContent, "Expand active");
    assert.equal(sizeMessages().at(-1).params.height, collapsedHeight);

    bulkToggleElement.click();
    flushAnimationFrames();
    const terminalStatuses = new Set([
      "complete",
      "accepted",
      "archived",
      "kept",
    ]);
    for (const group of membersElement.children) {
      assert.equal(group.open, !terminalStatuses.has(group.dataset.status));
    }
    assert.equal(bulkToggleElement.textContent, "Collapse all");
    assert.equal(bulkToggleElement.attributes["aria-expanded"], "true");
    assert.ok(sizeMessages().at(-1).params.height > collapsedHeight);

    bulkToggleElement.click();
    flushAnimationFrames();
    assert.ok(membersElement.children.every(({ open }) => open === false));
    assert.equal(sizeMessages().at(-1).params.height, collapsedHeight);
    const sizeCountBeforeDuplicate = sizeMessages().length;
    triggerResize();
    assert.equal(sizeMessages().length, sizeCountBeforeDuplicate);

    const attentionGroup = membersElement.children.find(
      ({ dataset }) => dataset.status === "attention",
    );
    attentionGroup.children[0].focus();
    const withoutAttentionMap = JSON.parse(JSON.stringify(updatedMixedMap));
    withoutAttentionMap.members = withoutAttentionMap.members.filter(
      ({ status }) => status !== "attention",
    );
    withoutAttentionMap.summary.total = withoutAttentionMap.members.length;
    withoutAttentionMap.summary.attention = 0;
    sendOpenAIResult(withoutAttentionMap);
    assert.equal(document.activeElement.dataset.status, "complete");

    sendHostContext({
      theme: "dark",
      styles: {
        variables: {
          "--color-text-warning": "rgb(180, 83, 9)",
          "--not-an-mcp-token": "ignored",
        },
        css: {
          fonts: '@font-face { font-family: "Fixture Sans"; src: local("Helvetica"); }',
        },
      },
      platform: "mobile",
      deviceCapabilities: { touch: true },
      safeAreaInsets: { top: 3, right: 4, bottom: 5, left: 6 },
    });
    assert.equal(documentElement.dataset.theme, "dark");
    assert.equal(documentElement.dataset.platform, "mobile");
    assert.equal(documentElement.dataset.touch, "true");
    assert.equal(documentElement.style.colorScheme, "dark");
    assert.equal(
      documentElement.style.getPropertyValue("--color-text-primary"),
      "rgb(20, 21, 24)",
    );
    assert.equal(
      documentElement.style.getPropertyValue("--color-text-warning"),
      "rgb(180, 83, 9)",
    );
    assert.equal(
      documentElement.style.getPropertyValue("--not-an-mcp-token"),
      "",
    );
    assert.equal(
      documentElement.style.getPropertyValue("--nelos-safe-area-bottom"),
      "5px",
    );
    assert.equal(
      hostFontsElement.textContent,
      '@font-face { font-family: "Fixture Sans"; src: local("Helvetica"); }',
    );

    const oneGroupMap = JSON.parse(JSON.stringify(withoutAttentionMap));
    oneGroupMap.members = oneGroupMap.members.filter(
      ({ status }) => status === "complete",
    );
    oneGroupMap.summary.total = oneGroupMap.members.length;
    bulkToggleElement.focus();
    sendOpenAIResult(oneGroupMap);
    assert.equal(groupActionsElement.hidden, true);
    assert.equal(document.activeElement, membersElement.children[0].children[0]);

    const largeHistoryMap = EXECUTION_MAP_FIXTURES.find(
      ({ key }) => key === "large_history",
    ).map;
    sendOpenAIResult(largeHistoryMap);
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

    const terminalOnlyMap = JSON.parse(JSON.stringify(mixedMap));
    terminalOnlyMap.members = terminalOnlyMap.members.filter(
      ({ status }) => status === "complete" || status === "archived",
    );
    terminalOnlyMap.summary.total = terminalOnlyMap.members.length;
    sendOpenAIResult(terminalOnlyMap);
    assert.equal(bulkToggleElement.textContent, "Expand all");
    bulkToggleElement.click();
    flushAnimationFrames();
    assert.ok(membersElement.children.every(({ open }) => open === true));

    const emptyMap = {
      ...terminalOnlyMap,
      task: "Empty task map",
      members: [],
      summary: {
        ...terminalOnlyMap.summary,
        total: 0,
        spinoffs: 0,
        subagents: 0,
        created: 0,
        archived: 0,
        running: 0,
        attention: 0,
        complete: 0,
        accepted: 0,
      },
    };
    sendToolResult(emptyMap);
    assert.equal(groupActionsElement.hidden, true);
    assert.equal(membersElement.children.length, 1);
    assert.equal(membersElement.children[0].tagName, "p");
    assert.equal(
      membersElement.children[0].textContent,
      "No task members in this receipt.",
    );
    assert.equal(
      updateStatusElement.textContent,
      "Execution map updated: 0 tasks in 0 statuses.",
    );
  } finally {
    await client.close();
    await running.close();
  }
});
