import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { win32 } from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import {
  EXECUTION_MAP_FIXTURES,
  MCP_APP_VISUAL_FIXTURES,
  PURPOSEFUL_VISUAL_FIXTURES,
  startMcpAppFixtureServer,
} from "../scripts/mcp-app-fixture-server.mjs";
import {
  MCP_APPS_SANDBOX_PORT,
  isPathWithin,
  resolveSandboxPort,
} from "../scripts/dev-mcp-app-ui.mjs";
import {
  ACTION_RECEIPT_RESOURCE_URI,
  EXECUTION_MAP_RESOURCE_MIME_TYPE,
  EXECUTION_MAP_RESOURCE_URI,
  EXECUTION_MAP_STATUSES,
  PLAN_SUMMARY_RESOURCE_URI,
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
      removeProperty(name) {
        const value = properties.get(name) ?? "";
        properties.delete(name);
        return value;
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
  const taskContextElement = makeElement("div", "task-context");
  taskContextElement.className = "task-context";
  taskContextElement.hidden = true;
  const taskContextLabelElement = makeElement("span", "task-context-label");
  taskContextLabelElement.className = "task-context-label";
  taskContextLabelElement.textContent = "Task";
  const taskContextValueElement = makeElement("strong", "task-context-value");
  taskContextValueElement.className = "task-context-value";
  const filtersElement = makeElement("nav", "filters");
  filtersElement.className = "filters";
  filtersElement.hidden = true;
  const filterCurrentElement = makeElement("button", "filter-current");
  filterCurrentElement.className = "filter-button";
  filterCurrentElement.textContent = "Current";
  filterCurrentElement.setAttribute("aria-pressed", "true");
  const filterDoneElement = makeElement("button", "filter-done");
  filterDoneElement.className = "filter-button";
  filterDoneElement.textContent = "Done";
  filterDoneElement.setAttribute("aria-pressed", "false");
  const filterHistoryElement = makeElement("button", "filter-history");
  filterHistoryElement.className = "filter-button";
  filterHistoryElement.textContent = "History";
  filterHistoryElement.setAttribute("aria-pressed", "false");
  const membersElement = makeElement("div", "members");
  membersElement.className = "groups";
  membersElement.setAttribute("role", "group");
  const updateStatusElement = makeElement("p", "update-status");
  updateStatusElement.className = "sr-only";
  taskContextElement.append(
    taskContextLabelElement,
    taskContextValueElement,
  );
  filtersElement.append(
    filterCurrentElement,
    filterDoneElement,
    filterHistoryElement,
  );
  main.append(
    taskContextElement,
    filtersElement,
    membersElement,
    updateStatusElement,
  );
  body.append(main);
  documentElement.append(head, body);

  const syntheticHeight = () => {
    let height = 28;
    if (!taskContextElement.hidden) height += 24;
    if (!filtersElement.hidden) height += 26;
    for (const child of membersElement.children) {
      if (hasClass(child, "empty")) {
        height += 50;
        continue;
      }
      if (hasClass(child, "single-member")) {
        height += 44;
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
    document,
    documentElement,
    filterCurrentElement,
    filterDoneElement,
    filterHistoryElement,
    filtersElement,
    flushAnimationFrames,
    hostFontsElement,
    membersElement,
    observers,
    postedMessages,
    sendHostContext,
    sendOpenAIResult,
    sendToolResult,
    taskContextElement,
    taskContextLabelElement,
    taskContextValueElement,
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

test("purpose-built fixtures cover plan and outcome receipts", () => {
  assert.deepEqual(
    PURPOSEFUL_VISUAL_FIXTURES.map(({ map, resourceUri }) => [
      map.view,
      resourceUri,
    ]),
    [
      ["plan-summary", PLAN_SUMMARY_RESOURCE_URI],
      ["action-receipt", ACTION_RECEIPT_RESOURCE_URI],
    ],
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
      MCP_APP_VISUAL_FIXTURES.map(({ toolName }) => toolName).sort(),
    );
    for (const current of MCP_APP_VISUAL_FIXTURES) {
      const descriptor = listed.tools.find(
        ({ name }) => name === current.toolName,
      );
      assert.equal(
        descriptor?._meta?.ui?.resourceUri,
        current.resourceUri ?? EXECUTION_MAP_RESOURCE_URI,
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
      /grouped by current execution status/u,
    );
    for (const [uri, pattern] of [
      [PLAN_SUMMARY_RESOURCE_URI, /Nelos plan summary/u],
      [ACTION_RECEIPT_RESOURCE_URI, /Nelos action receipt/u],
    ]) {
      const purposeful = await client.readResource({ uri });
      assert.match(purposeful.contents[0]?.text ?? "", pattern);
    }
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
      document,
      documentElement,
      filterCurrentElement,
      filterDoneElement,
      filterHistoryElement,
      filtersElement,
      flushAnimationFrames,
      hostFontsElement,
      membersElement,
      observers,
      postedMessages,
      sendHostContext,
      sendOpenAIResult,
      sendToolResult,
      taskContextElement,
      taskContextLabelElement,
      taskContextValueElement,
      triggerResize,
      updateStatusElement,
    } = widget;
    assert.equal(membersElement.tagName, "div");
    assert.equal(membersElement.attributes.role, "group");
    assert.equal(membersElement.children[0]?.tagName, "p");
    assert.equal(membersElement.children[0]?.textContent, "Loading worker state…");
    assert.equal(taskContextElement.hidden, true);
    assert.equal(filtersElement.hidden, true);
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
    assert.equal(
      documentElement.style.getPropertyValue("--color-background-primary"),
      "rgb(255, 255, 255)",
    );
    assert.equal(observers.length, 1);
    assert.deepEqual(observers[0].observed, [documentElement, document.body]);

    const runningMap = EXECUTION_MAP_FIXTURES.find(
      ({ key }) => key === "running_subagent",
    ).map;
    sendToolResult(runningMap);
    assert.equal(taskContextElement.hidden, false);
    assert.equal(taskContextLabelElement.textContent, "Task");
    assert.equal(taskContextValueElement.textContent, runningMap.task);
    assert.equal(
      taskContextValueElement.title,
      `Task: ${runningMap.task}`,
    );
    assert.equal(membersElement.children.length, 1);
    assert.equal(membersElement.children[0].tagName, "article");
    assert.equal(membersElement.children[0].className, "member single-member");
    assert.equal(filtersElement.hidden, true);
    assert.equal(membersElement.children[0].dataset.status, "running");
    assert.equal(
      membersElement.children[0].children[1].children[0].children[0].textContent,
      runningMap.members[0].task,
    );
    assert.equal(
      membersElement.children[0].children[1].children[1].children[0].textContent,
      "Running",
    );

    const acceptedMap = EXECUTION_MAP_FIXTURES.find(
      ({ key }) => key === "accepted_subagent",
    ).map;
    sendOpenAIResult(acceptedMap);
    assert.equal(membersElement.children.length, 1);
    assert.equal(membersElement.children[0].className, "member single-member");
    assert.equal(membersElement.children[0].dataset.status, "accepted");
    assert.equal(
      membersElement.children[0].children[1].children[1].children[0].textContent,
      "Accepted",
    );

    const archivedMap = EXECUTION_MAP_FIXTURES.find(
      ({ key }) => key === "archived_spinoff",
    ).map;
    sendOpenAIResult(archivedMap);
    assert.equal(membersElement.children[0].className, "member single-member");
    assert.equal(membersElement.children[0].dataset.status, "archived");
    assert.equal(
      membersElement.children[0].children[1].children[1].children[0].textContent,
      "Archive",
    );

    const mixedMap = EXECUTION_MAP_FIXTURES.find(
      ({ key }) => key === "mixed_statuses",
    ).map;
    sendOpenAIResult(mixedMap);
    filterCurrentElement.click();
    flushAnimationFrames();
    assert.equal(taskContextLabelElement.textContent, "Task");
    assert.equal(taskContextValueElement.textContent, mixedMap.task);
    assert.equal(filtersElement.hidden, false);
    assert.equal(filterCurrentElement.textContent, "Current 10");
    assert.equal(filterDoneElement.textContent, "Done 3");
    assert.equal(filterHistoryElement.textContent, "History 2");
    assert.equal(filterCurrentElement.attributes["aria-pressed"], "true");
    const expectedGroups = [
      ["needs-input", "Needs input (3)", true],
      ["in-progress", "In progress (4)", false],
      ["queued", "Queued (3)", false],
    ];
    assert.equal(membersElement.children.length, expectedGroups.length);
    for (const [index, [groupKey, summary, open]] of expectedGroups.entries()) {
      const group = membersElement.children[index];
      assert.equal(group.tagName, "details");
      assert.equal(group.className, "member-group");
      assert.equal(group.dataset.group, groupKey);
      assert.equal(group.open, open);
      assert.equal(group.children[0].tagName, "summary");
      assert.equal(group.children[0].textContent, summary);
      assert.equal(
        group.children[1].attributes["aria-label"],
        `${summary.replace(/ \(\d+\)$/u, "")} workers`,
      );
    }
    const needsInputGroup = membersElement.children.find(
      ({ dataset }) => dataset.group === "needs-input",
    );
    assert.deepEqual(
      needsInputGroup.children[1].children
        .map(({ dataset }) => dataset.status)
        .sort(),
      ["attention", "authorization-required", "unknown"],
    );
    const inProgressGroup = membersElement.children.find(
      ({ dataset }) => dataset.group === "in-progress",
    );
    const runningRows = inProgressGroup.children[1].children.filter(
      ({ dataset }) => dataset.status === "running",
    );
    assert.deepEqual(
      runningRows.map(
        ({ children }) => children[1].children[0].children[0].textContent,
      ),
      [
        "Exercise the compact worker row with a deliberately long task title",
        "Verify status rollup interaction",
      ],
    );
    const firstRunningRow = runningRows[0];
    const firstRunningContent = firstRunningRow.children[1];
    const firstRunningMeta = firstRunningContent.children[1];
    assert.equal(firstRunningMeta.children.length, 5);
    assert.equal(firstRunningMeta.children[0].className, "tag status");
    assert.equal(firstRunningMeta.children[0].textContent, "Running");
    const taskIdTag = firstRunningMeta.children[4];
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
    assert.equal(
      updateStatusElement.textContent,
      "Execution map updated: 10 workers shown in Current.",
    );

    const sizeMessages = () => postedMessages.filter(
      ({ method }) => method === "ui/notifications/size-changed",
    );
    const currentHeight = sizeMessages().at(-1).params.height;
    const inProgressSummary = inProgressGroup.children[0];
    inProgressSummary.focus();
    inProgressSummary.click();
    flushAnimationFrames();
    assert.equal(inProgressGroup.open, true);
    assert.ok(sizeMessages().at(-1).params.height > currentHeight);

    const updatedMixedMap = JSON.parse(JSON.stringify(mixedMap));
    updatedMixedMap.members.find(({ id }) => id === "running-b").task =
      "Verify retained status rollup interaction";
    sendOpenAIResult(updatedMixedMap);
    const updatedInProgressGroup = membersElement.children.find(
      ({ dataset }) => dataset.group === "in-progress",
    );
    assert.notEqual(updatedInProgressGroup, inProgressGroup);
    assert.equal(updatedInProgressGroup.open, true);
    assert.equal(document.activeElement, updatedInProgressGroup.children[0]);
    const updatedRunningRows = updatedInProgressGroup.children[1].children.filter(
      ({ dataset }) => dataset.status === "running",
    );
    assert.equal(
      updatedRunningRows[1]
        .children[1].children[0].children[0].textContent,
      "Verify retained status rollup interaction",
    );

    filterDoneElement.click();
    flushAnimationFrames();
    assert.equal(filterDoneElement.attributes["aria-pressed"], "true");
    assert.equal(membersElement.children.length, 3);
    assert.ok(
      membersElement.children.every(
        ({ className }) => className === "member single-member",
      ),
    );
    assert.deepEqual(
      membersElement.children.map(({ dataset }) => dataset.status).sort(),
      ["accepted", "complete", "kept"],
    );
    assert.equal(
      updateStatusElement.textContent,
      "Execution map updated: 3 workers shown in Done.",
    );

    filterHistoryElement.click();
    flushAnimationFrames();
    assert.equal(filterHistoryElement.attributes["aria-pressed"], "true");
    assert.equal(membersElement.children.length, 2);
    assert.ok(
      membersElement.children.every(
        ({ dataset }) => dataset.status === "archived",
      ),
    );
    assert.deepEqual(
      membersElement.children.map(
        ({ children }) => children[1].children[0].children[0].textContent,
      ),
      [
        "Archive the superseded implementation task",
        "Archive the historical verification task",
      ],
    );

    filterCurrentElement.click();
    flushAnimationFrames();
    assert.equal(filterCurrentElement.attributes["aria-pressed"], "true");
    assert.equal(
      membersElement.children.find(
        ({ dataset }) => dataset.group === "in-progress",
      ).open,
      true,
    );
    const sizeCountBeforeDuplicate = sizeMessages().length;
    triggerResize();
    assert.equal(sizeMessages().length, sizeCountBeforeDuplicate);

    const focusedNeedsInputGroup = membersElement.children.find(
      ({ dataset }) => dataset.group === "needs-input",
    );
    focusedNeedsInputGroup.children[0].focus();
    const withoutNeedsInputMap = JSON.parse(JSON.stringify(updatedMixedMap));
    const needsInputStatuses = new Set([
      "authorization-required",
      "attention",
      "unknown",
    ]);
    withoutNeedsInputMap.members = withoutNeedsInputMap.members.filter(
      ({ status }) => !needsInputStatuses.has(status),
    );
    withoutNeedsInputMap.summary.total = withoutNeedsInputMap.members.length;
    withoutNeedsInputMap.summary.attention = 0;
    sendOpenAIResult(withoutNeedsInputMap);
    assert.equal(document.activeElement.dataset.group, "in-progress");

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
      "",
    );
    assert.equal(
      documentElement.style.getPropertyValue("--color-background-primary"),
      "",
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
    sendHostContext({ platform: "desktop" });
    assert.equal(
      documentElement.style.getPropertyValue("--color-text-warning"),
      "rgb(180, 83, 9)",
    );

    const oneGroupMap = JSON.parse(JSON.stringify(withoutNeedsInputMap));
    oneGroupMap.members = oneGroupMap.members.filter(
      ({ status }) => status === "complete",
    );
    oneGroupMap.summary.total = oneGroupMap.members.length;
    sendOpenAIResult(oneGroupMap);
    assert.equal(filtersElement.hidden, true);
    assert.equal(membersElement.children[0].className, "member single-member");
    assert.equal(membersElement.children[0].dataset.status, "complete");

    const largeHistoryMap = EXECUTION_MAP_FIXTURES.find(
      ({ key }) => key === "large_history",
    ).map;
    sendOpenAIResult(largeHistoryMap);
    assert.equal(filtersElement.hidden, false);
    assert.equal(filterCurrentElement.textContent, "Current 5");
    assert.equal(filterHistoryElement.textContent, "History 5");
    assert.equal(filterDoneElement.hidden, true);
    assert.equal(membersElement.children.length, 1);
    assert.equal(membersElement.children[0].dataset.group, "in-progress");
    assert.equal(
      membersElement.children[0].children[0].textContent,
      "In progress (5)",
    );
    filterHistoryElement.click();
    flushAnimationFrames();
    assert.equal(membersElement.children.length, 5);
    assert.ok(
      membersElement.children.every(
        ({ dataset }) => dataset.status === "archived",
      ),
    );

    const terminalOnlyMap = JSON.parse(JSON.stringify(mixedMap));
    terminalOnlyMap.members = terminalOnlyMap.members.filter(
      ({ status }) => status === "complete" || status === "archived",
    );
    terminalOnlyMap.summary.total = terminalOnlyMap.members.length;
    sendOpenAIResult(terminalOnlyMap);
    assert.equal(filterDoneElement.textContent, "Done 1");
    assert.equal(filterHistoryElement.textContent, "History 2");
    assert.equal(membersElement.children.length, 2);
    filterDoneElement.click();
    flushAnimationFrames();
    assert.equal(membersElement.children.length, 1);
    assert.equal(membersElement.children[0].dataset.status, "complete");

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
    assert.equal(filtersElement.hidden, true);
    assert.equal(membersElement.children.length, 1);
    assert.equal(membersElement.children[0].tagName, "p");
    assert.equal(
      membersElement.children[0].textContent,
      "No task members in this receipt.",
    );
    assert.equal(
      updateStatusElement.textContent,
      "Execution map updated: 0 workers shown in Current.",
    );
  } finally {
    await client.close();
    await running.close();
  }
});
