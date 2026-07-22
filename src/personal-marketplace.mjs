import { isAbsolute, join, resolve } from "node:path";

const INSTALLATION_POLICY = "AVAILABLE";
const AUTHENTICATION_POLICY = "ON_INSTALL";
const PLUGIN_CATEGORY = "Developer Tools";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function skipWhitespace(text, index) {
  let cursor = index;
  while (/\s/.test(text[cursor] ?? "")) cursor += 1;
  return cursor;
}

function scanString(text, index) {
  if (text[index] !== '"') throw new Error("expected JSON string");
  let cursor = index + 1;
  while (cursor < text.length) {
    if (text[cursor] === '"') {
      const end = cursor + 1;
      return { end, value: JSON.parse(text.slice(index, end)) };
    }
    if (text[cursor] === "\\") cursor += 1;
    cursor += 1;
  }
  throw new Error("unterminated JSON string");
}

function scanArray(text, index, state) {
  const elements = [];
  let cursor = skipWhitespace(text, index + 1);
  if (text[cursor] === "]") {
    return { type: "array", start: index, end: cursor + 1, elements };
  }
  while (cursor < text.length) {
    const value = scanValue(text, cursor, state);
    elements.push(value);
    cursor = skipWhitespace(text, value.end);
    if (text[cursor] === "]") {
      return { type: "array", start: index, end: cursor + 1, elements };
    }
    if (text[cursor] !== ",") throw new Error("malformed JSON array");
    cursor = skipWhitespace(text, cursor + 1);
  }
  throw new Error("unterminated JSON array");
}

function scanObject(text, index, state, { root = false } = {}) {
  const keys = new Set();
  let cursor = skipWhitespace(text, index + 1);
  if (text[cursor] === "}") {
    return { type: "object", start: index, end: cursor + 1 };
  }
  while (cursor < text.length) {
    const key = scanString(text, cursor);
    if (keys.has(key.value)) throw new Error("duplicate JSON object key");
    keys.add(key.value);
    cursor = skipWhitespace(text, key.end);
    if (text[cursor] !== ":") throw new Error("malformed JSON object");
    cursor = skipWhitespace(text, cursor + 1);
    const value = scanValue(text, cursor, state);
    if (root && key.value === "plugins") {
      state.pluginsSeen = true;
      if (value.type === "array") state.plugins = value;
    }
    cursor = skipWhitespace(text, value.end);
    if (text[cursor] === "}") {
      return { type: "object", start: index, end: cursor + 1 };
    }
    if (text[cursor] !== ",") throw new Error("malformed JSON object");
    cursor = skipWhitespace(text, cursor + 1);
  }
  throw new Error("unterminated JSON object");
}

function scanValue(text, index, state, options = {}) {
  const cursor = skipWhitespace(text, index);
  const token = text[cursor];
  if (token === "{") return scanObject(text, cursor, state, options);
  if (token === "[") return scanArray(text, cursor, state);
  if (token === '"') {
    const value = scanString(text, cursor);
    return { type: "string", start: cursor, end: value.end };
  }
  const primitive = text.slice(cursor).match(
    /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/,
  )?.[0];
  if (!primitive) throw new Error("malformed JSON value");
  return { type: "primitive", start: cursor, end: cursor + primitive.length };
}

export function parsePersonalMarketplaceText(text) {
  const document = JSON.parse(text);
  const state = { plugins: null, pluginsSeen: false };
  const start = skipWhitespace(text, 0);
  if (text[start] !== "{") throw new Error("marketplace must be a JSON object");
  const root = scanObject(text, start, state, { root: true });
  if (skipWhitespace(text, root.end) !== text.length) {
    throw new Error("trailing marketplace content");
  }
  return { document, layout: state };
}

function insertionPoint(text, opening, closing) {
  let point = closing;
  while (point > opening + 1 && /\s/.test(text[point - 1])) point -= 1;
  return point;
}

export function applyPersonalMarketplaceMutation(text, mutation) {
  const { layout } = parsePersonalMarketplaceText(text);
  if (!layout.plugins) throw new Error("marketplace plugins array is missing");
  if (mutation.kind === "append-plugin") {
    const opening = layout.plugins.start;
    const closing = layout.plugins.end - 1;
    const point = insertionPoint(text, opening, closing);
    const prefix = point === opening + 1 ? "" : ",";
    return `${text.slice(0, point)}${prefix}${JSON.stringify(mutation.plugin)}${text.slice(point)}`;
  }
  if (mutation.kind === "append-target-properties") {
    const target = layout.plugins.elements[mutation.pluginIndex];
    if (target?.type !== "object") throw new Error("target plugin entry is ambiguous");
    const opening = target.start;
    const closing = target.end - 1;
    const point = insertionPoint(text, opening, closing);
    const fields = Object.entries(mutation.properties)
      .map(([key, value]) => `${JSON.stringify(key)}:${JSON.stringify(value)}`)
      .join(",");
    const prefix = point === opening + 1 ? "" : ",";
    return `${text.slice(0, point)}${prefix}${fields}${text.slice(point)}`;
  }
  throw new Error("unknown personal marketplace mutation");
}

function canonicalRelativeSource(pluginIdentity) {
  return `./plugins/${pluginIdentity.name}`;
}

function isDefaultPersonalMarketplace(marketplacePath, home) {
  return resolve(marketplacePath) ===
    join(resolve(home), ".agents", "plugins", "marketplace.json");
}

export function personalMarketplaceSourceReference(
  sourcePath,
  { pluginIdentity, marketplacePath, home },
) {
  const canonicalSource = resolve(sourcePath);
  const canonicalHome = resolve(home);
  if (
    isDefaultPersonalMarketplace(marketplacePath, canonicalHome) &&
    canonicalSource === join(canonicalHome, "plugins", pluginIdentity.name)
  ) {
    return canonicalRelativeSource(pluginIdentity);
  }
  return canonicalSource;
}

export function resolvePersonalMarketplaceSource(
  sourceReference,
  { pluginIdentity, marketplacePath, home },
) {
  if (typeof sourceReference !== "string" || sourceReference.length === 0) {
    throw new Error("local source path is missing");
  }
  if (isAbsolute(sourceReference)) return resolve(sourceReference);
  if (
    !isDefaultPersonalMarketplace(marketplacePath, home) ||
    sourceReference !== canonicalRelativeSource(pluginIdentity)
  ) {
    throw new Error("local source path is not a canonical personal reference");
  }
  return join(resolve(home), "plugins", pluginIdentity.name);
}

export function personalMarketplacePluginEntry(
  pluginIdentity,
  sourcePath,
  { marketplacePath, home },
) {
  return {
    name: pluginIdentity.name,
    source: {
      source: "local",
      path: personalMarketplaceSourceReference(sourcePath, {
        pluginIdentity,
        marketplacePath,
        home,
      }),
    },
    policy: {
      installation: INSTALLATION_POLICY,
      authentication: AUTHENTICATION_POLICY,
    },
    category: PLUGIN_CATEGORY,
  };
}

export function personalMarketplaceDocument(
  pluginIdentity,
  sourcePath,
  { marketplacePath, home },
) {
  return {
    name: pluginIdentity.marketplaceName,
    interface: { displayName: "Personal" },
    plugins: [
      personalMarketplacePluginEntry(pluginIdentity, sourcePath, {
        marketplacePath,
        home,
      }),
    ],
  };
}

export function inspectPersonalMarketplace(
  document,
  { pluginIdentity, sourcePath, marketplacePath, home },
) {
  if (!record(document) || document.name !== pluginIdentity.marketplaceName) {
    return {
      state: "conflict",
      reason: "marketplace identity does not match the personal marketplace",
    };
  }
  if (!Array.isArray(document.plugins)) {
    return { state: "conflict", reason: "plugins must be an array" };
  }

  const seen = new Set();
  for (let index = 0; index < document.plugins.length; index += 1) {
    const plugin = document.plugins[index];
    if (
      !record(plugin) ||
      typeof plugin.name !== "string" ||
      plugin.name.length === 0
    ) {
      return {
        state: "conflict",
        reason: `plugin entry ${index} has no unambiguous name`,
      };
    }
    if (seen.has(plugin.name)) {
      return {
        state: "conflict",
        reason: `plugin name ${plugin.name} appears more than once`,
      };
    }
    seen.add(plugin.name);
  }

  const pluginIndex = document.plugins.findIndex(
    ({ name }) => name === pluginIdentity.name,
  );
  const plugin = document.plugins[pluginIndex];
  if (!plugin) {
    return {
      state: "bootstrap-ready",
      reason: "Fraktik entry is absent",
      mutation: {
        kind: "append-plugin",
        plugin: personalMarketplacePluginEntry(pluginIdentity, sourcePath, {
          marketplacePath,
          home,
        }),
      },
    };
  }
  if (!record(plugin.source) || plugin.source.source !== "local") {
    return {
      state: "conflict",
      reason: "Fraktik entry is owned by a non-local source",
    };
  }

  let resolvedSource;
  try {
    resolvedSource = resolvePersonalMarketplaceSource(plugin.source.path, {
      pluginIdentity,
      marketplacePath,
      home,
    });
  } catch {
    return {
      state: "conflict",
      reason: "Fraktik local source path is malformed",
    };
  }
  if (resolvedSource !== resolve(sourcePath)) {
    return {
      state: "conflict",
      reason: "Fraktik entry points at a different local source",
    };
  }

  const properties = {};
  if (plugin.policy === undefined) {
    properties.policy = {
      installation: INSTALLATION_POLICY,
      authentication: AUTHENTICATION_POLICY,
    };
  } else if (
    !record(plugin.policy) ||
    plugin.policy.installation !== INSTALLATION_POLICY ||
    plugin.policy.authentication !== AUTHENTICATION_POLICY
  ) {
    return {
      state: "conflict",
      reason: "Fraktik entry has conflicting install or authentication policy",
    };
  }
  if (plugin.category === undefined) {
    properties.category = PLUGIN_CATEGORY;
  } else if (plugin.category !== PLUGIN_CATEGORY) {
    return {
      state: "conflict",
      reason: "Fraktik entry has a conflicting category",
    };
  }
  if (Object.keys(properties).length > 0) {
    return {
      state: "bootstrap-ready",
      reason: "Fraktik entry is ready for canonical metadata",
      mutation: {
        kind: "append-target-properties",
        pluginIndex,
        properties,
      },
    };
  }
  return {
    state: "compatible",
    reason: isAbsolute(plugin.source.path)
      ? "Fraktik uses the expected absolute local source"
      : "Fraktik uses the expected home-relative local source",
    sourcePath: resolvedSource,
  };
}
