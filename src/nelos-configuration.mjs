import { randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

import {
  taskStateDirectory,
  withNelosConfigurationLock,
} from "./task-state.mjs";

const require = createRequire(import.meta.url);
const { parse: parseToml } = require("./vendor/smol-toml-1.6.0.cjs");

export const NELOS_CONFIGURATION_SCHEMA_VERSION = 1;
export const NELOS_CLEANUP_POLICY_KEY = "spinoffs.cleanup_policy";
export const NELOS_CLEANUP_POLICIES = Object.freeze([
  "auto",
  "ask",
  "keep",
]);

const MAX_CONFIGURATION_BYTES = 64 * 1024;
const MAX_LEGACY_PREFERENCE_BYTES = 32 * 1024;

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function resolveNelosConfigPath({
  environment = process.env,
  homeDirectory = homedir(),
} = {}) {
  const explicit = nonEmpty(environment.NELOS_CONFIG);
  if (explicit) {
    if (!isAbsolute(explicit)) {
      throw new Error("NELOS_CONFIG must be an absolute path");
    }
    return explicit;
  }

  const xdgConfigHome = nonEmpty(environment.XDG_CONFIG_HOME);
  if (xdgConfigHome) {
    if (!isAbsolute(xdgConfigHome)) {
      throw new Error("XDG_CONFIG_HOME must be an absolute path");
    }
    return join(xdgConfigHome, "nelos", "config.toml");
  }

  const userHome = nonEmpty(environment.HOME) ?? nonEmpty(homeDirectory);
  if (!userHome || !isAbsolute(userHome)) {
    throw new Error("Nelos cannot resolve an absolute user home directory");
  }
  return join(userHome, ".config", "nelos", "config.toml");
}

export function legacyCleanupPreferencePath() {
  return join(taskStateDirectory(), "spinoff-lifecycle", "preference.json");
}

function commentIndex(line, lineNumber) {
  let quote = null;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quote === "\"") {
      if (escaped) {
        escaped = false;
      } else if (character === "\\") {
        escaped = true;
      } else if (character === quote) {
        quote = null;
      }
      continue;
    }
    if (quote === "'") {
      if (character === quote) quote = null;
      continue;
    }
    if (character === "\"" || character === "'") {
      quote = character;
      continue;
    }
    if (character === "#") return index;
  }
  if (quote !== null) {
    throw new Error(`line ${lineNumber}: unterminated string`);
  }
  return -1;
}

function assertOnlyKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new Error(`unsupported ${label} key ${key}`);
    }
  }
}

function locateEditableSetting(source) {
  const lines = source.split(/\r?\n/u);
  let table = null;
  let cleanupPolicyLine = null;
  let cleanupPolicyStyle = null;
  let spinoffsTableLine = null;
  const spinoffsKey = String.raw`(?:spinoffs|"spinoffs"|'spinoffs')`;
  const cleanupKey =
    String.raw`(?:cleanup_policy|"cleanup_policy"|'cleanup_policy')`;
  const spinoffsTable = new RegExp(
    String.raw`^\[\s*${spinoffsKey}\s*\]$`,
    "u",
  );
  const anyTable = /^\[\s*[^\]]+\s*\]$/u;
  const tableCleanup = new RegExp(String.raw`^${cleanupKey}\s*=`, "u");
  const dottedCleanup = new RegExp(
    String.raw`^${spinoffsKey}\s*\.\s*${cleanupKey}\s*=`,
    "u",
  );

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index];
    const marker = commentIndex(raw, lineNumber);
    const statement = raw.slice(0, marker === -1 ? raw.length : marker).trim();
    if (!statement) continue;
    if (spinoffsTable.test(statement)) {
      table = "spinoffs";
      spinoffsTableLine = index;
      continue;
    }
    if (anyTable.test(statement)) {
      table = "other";
      continue;
    }
    if (table === "spinoffs" && tableCleanup.test(statement)) {
      cleanupPolicyLine = index;
      cleanupPolicyStyle = "table";
    } else if (table === null && dottedCleanup.test(statement)) {
      cleanupPolicyLine = index;
      cleanupPolicyStyle = "dotted";
    }
  }
  return {
    lines,
    locations: {
      cleanupPolicyLine,
      cleanupPolicyStyle,
      spinoffsTableLine,
    },
  };
}

export function parseNelosConfig(source) {
  if (typeof source !== "string") {
    throw new Error("Nelos configuration must be UTF-8 text");
  }
  if (Buffer.byteLength(source, "utf8") > MAX_CONFIGURATION_BYTES) {
    throw new Error("Nelos configuration exceeds 64 KiB");
  }
  let parsed;
  try {
    parsed = parseToml(source, { integersAsBigInt: true });
  } catch (error) {
    throw new Error(`invalid TOML: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Nelos configuration root must be a TOML table");
  }
  assertOnlyKeys(parsed, ["schema_version", "spinoffs"], "root");
  if (parsed.schema_version === undefined) {
    throw new Error("schema_version = 1 is required");
  }
  if (parsed.schema_version !== 1n) {
    throw new Error(
      `unsupported schema_version ${String(parsed.schema_version)}`,
    );
  }
  const spinoffs = parsed.spinoffs ?? {};
  if (
    !spinoffs ||
    typeof spinoffs !== "object" ||
    Array.isArray(spinoffs)
  ) {
    throw new Error("spinoffs must be a TOML table");
  }
  assertOnlyKeys(spinoffs, ["cleanup_policy"], "spinoffs");
  const cleanupPolicy = spinoffs.cleanup_policy ?? null;
  if (
    cleanupPolicy !== null &&
    !NELOS_CLEANUP_POLICIES.includes(cleanupPolicy)
  ) {
    throw new Error("cleanup_policy must be one of auto, ask, or keep");
  }
  const editable = locateEditableSetting(source);
  if (
    Object.hasOwn(parsed, "spinoffs") &&
    cleanupPolicy === null &&
    editable.locations.spinoffsTableLine === null
  ) {
    throw new Error(
      "spinoffs inline tables use valid but unsupported editing syntax",
    );
  }
  if (
    cleanupPolicy !== null &&
    editable.locations.cleanupPolicyLine === null
  ) {
    throw new Error(
      "spinoffs.cleanup_policy uses valid but unsupported editing syntax",
    );
  }

  return {
    schemaVersion: NELOS_CONFIGURATION_SCHEMA_VERSION,
    cleanupPolicy,
    source,
    ...editable,
  };
}

function replaceCleanupPolicy(document, value) {
  const lines = [...document.lines];
  const rendered = document.locations.cleanupPolicyStyle === "dotted"
    ? `spinoffs.cleanup_policy = ${JSON.stringify(value)}`
    : `cleanup_policy = ${JSON.stringify(value)}`;
  if (document.locations.cleanupPolicyLine !== null) {
    const index = document.locations.cleanupPolicyLine;
    const marker = commentIndex(lines[index], index + 1);
    const comment = marker === -1 ? "" : lines[index].slice(marker);
    const indentation = lines[index].match(/^\s*/u)?.[0] ?? "";
    lines[index] = `${indentation}${rendered}${comment ? ` ${comment}` : ""}`;
  } else if (document.locations.spinoffsTableLine !== null) {
    lines.splice(document.locations.spinoffsTableLine + 1, 0, rendered);
  } else {
    while (lines.length > 0 && lines.at(-1) === "") lines.pop();
    if (lines.length > 0) lines.push("");
    lines.push("[spinoffs]", rendered);
  }
  return `${lines.join("\n").replace(/\n*$/u, "")}\n`;
}

function removeCleanupPolicy(document) {
  if (document.locations.cleanupPolicyLine === null) return document.source;
  const lines = [...document.lines];
  lines.splice(document.locations.cleanupPolicyLine, 1);
  return `${lines.join("\n").replace(/\n*$/u, "")}\n`;
}

function initialConfig(value) {
  return [
    `schema_version = ${NELOS_CONFIGURATION_SCHEMA_VERSION}`,
    "",
    "[spinoffs]",
    `cleanup_policy = ${JSON.stringify(value)}`,
    "",
  ].join("\n");
}

export class NelosConfigStoreV1 {
  #path;
  #fileSystem;
  #makeTemporaryId;

  constructor({
    path = resolveNelosConfigPath(),
    fileSystem = defaultFileSystem,
    makeTemporaryId = randomUUID,
  } = {}) {
    this.#path = path;
    this.#fileSystem = fileSystem;
    this.#makeTemporaryId = makeTemporaryId;
  }

  get path() {
    return this.#path;
  }

  async read() {
    try {
      const metadata = await this.#fileSystem.lstat(this.#path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error("configuration path is not a regular file");
      }
      if (metadata.size > MAX_CONFIGURATION_BYTES) {
        throw new Error("configuration exceeds 64 KiB");
      }
      const source = await this.#fileSystem.readFile(this.#path, "utf8");
      return { exists: true, document: parseNelosConfig(source) };
    } catch (error) {
      if (error?.code === "ENOENT") return { exists: false, document: null };
      throw new Error(
        `invalid Nelos configuration at ${this.#path}: ${error.message}`,
      );
    }
  }

  async #write(source) {
    const directory = dirname(this.#path);
    await this.#fileSystem.mkdir(directory, {
      recursive: true,
      mode: 0o700,
    });
    const temporary =
      `${this.#path}.${process.pid}.${this.#makeTemporaryId()}.tmp`;
    try {
      await this.#fileSystem.writeFile(temporary, source, {
        flag: "wx",
        mode: 0o600,
      });
      await this.#fileSystem.rename(temporary, this.#path);
    } catch (error) {
      await this.#fileSystem.rm(temporary, { force: true }).catch(() => {});
      throw error;
    }
  }

  async setCleanupPolicy(value) {
    if (!NELOS_CLEANUP_POLICIES.includes(value)) {
      throw new Error("cleanup policy must be one of auto, ask, or keep");
    }
    const current = await this.read();
    const source = current.exists
      ? replaceCleanupPolicy(current.document, value)
      : initialConfig(value);
    parseNelosConfig(source);
    await this.#write(source);
    return this.read();
  }

  async resetCleanupPolicy() {
    const current = await this.read();
    if (
      !current.exists ||
      current.document.locations.cleanupPolicyLine === null
    ) {
      return current;
    }
    const source = removeCleanupPolicy(current.document);
    parseNelosConfig(source);
    await this.#write(source);
    return this.read();
  }
}

async function readLegacyPreference(path, fileSystem) {
  try {
    const metadata = await fileSystem.lstat(path);
    if (
      !metadata.isFile() ||
      metadata.isSymbolicLink() ||
      metadata.size > MAX_LEGACY_PREFERENCE_BYTES
    ) {
      throw new Error("legacy cleanup preference is not a bounded regular file");
    }
    const parsed = JSON.parse(await fileSystem.readFile(path, "utf8"));
    if (
      parsed?.schemaVersion !== 1 ||
      !NELOS_CLEANUP_POLICIES.includes(parsed?.policy)
    ) {
      throw new Error("legacy cleanup preference has an invalid schema");
    }
    return { exists: true, policy: parsed.policy };
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { exists: false, policy: null };
    }
    throw new Error(
      `invalid legacy Nelos preference at ${path}: ${error.message}`,
    );
  }
}

export class NelosConfigurationV1 {
  #store;
  #legacyPreferencePath;
  #fileSystem;
  #withLock;

  constructor({
    store = new NelosConfigStoreV1(),
    legacyPreferencePath: legacyPath = legacyCleanupPreferencePath(),
    fileSystem = defaultFileSystem,
    withLock = null,
  } = {}) {
    this.#store = store;
    this.#legacyPreferencePath = legacyPath;
    this.#fileSystem = fileSystem;
    this.#withLock = withLock ?? (
      (callback) => withNelosConfigurationLock(this.#store.path, callback)
    );
  }

  #response(current, migration = null) {
    const configured = current.document?.cleanupPolicy ?? null;
    return {
      schemaVersion: NELOS_CONFIGURATION_SCHEMA_VERSION,
      configPath: this.#store.path,
      configFileExists: current.exists,
      setting: {
        key: NELOS_CLEANUP_POLICY_KEY,
        value: configured ?? "auto",
        source: configured !== null ? "toml" : "default",
      },
      allowedValues: [...NELOS_CLEANUP_POLICIES],
      migration,
    };
  }

  async get() {
    const current = await this.#store.read();
    if (current.exists) return this.#response(current);
    return this.#withLock(async () => {
      const lockedCurrent = await this.#store.read();
      if (lockedCurrent.exists) return this.#response(lockedCurrent);
      const legacy = await readLegacyPreference(
        this.#legacyPreferencePath,
        this.#fileSystem,
      );
      if (!legacy.exists) return this.#response(lockedCurrent);
      const migrated = await this.#store.setCleanupPolicy(legacy.policy);
      await this.#fileSystem.rm(this.#legacyPreferencePath, { force: true });
      return this.#response(migrated, {
        performed: true,
        from: "legacy-preference",
      });
    });
  }

  async set({ key, value, userIntentConfirmed }) {
    if (key !== NELOS_CLEANUP_POLICY_KEY) {
      throw new Error(`unsupported Nelos configuration key ${key}`);
    }
    if (userIntentConfirmed !== true) {
      throw new Error(
        "changing Nelos configuration requires explicit user intent",
      );
    }
    return this.#withLock(async () => {
      const current = await this.#store.setCleanupPolicy(value);
      await this.#fileSystem.rm(this.#legacyPreferencePath, { force: true });
      return this.#response(current);
    });
  }

  async reset({ key, userIntentConfirmed }) {
    if (key !== NELOS_CLEANUP_POLICY_KEY) {
      throw new Error(`unsupported Nelos configuration key ${key}`);
    }
    if (userIntentConfirmed !== true) {
      throw new Error(
        "changing Nelos configuration requires explicit user intent",
      );
    }
    return this.#withLock(async () => {
      const current = await this.#store.resetCleanupPolicy();
      await this.#fileSystem.rm(this.#legacyPreferencePath, { force: true });
      return this.#response(current);
    });
  }
}
