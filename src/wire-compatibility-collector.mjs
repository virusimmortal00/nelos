import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const WIRE_COMPATIBILITY_EVIDENCE_SCHEMA_VERSION = 1;
export const WIRE_COMPATIBILITY_CONCLUSION_SCHEMA_VERSION = 1;

const VERSION_PATTERN = /(?:^|\/|\s)(\d+\.\d+\.\d+)(?![\w.+-])/u;
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_RUNTIME_OPERATIONS = 8;
const MAX_RUNTIME_PARAMS_BYTES = 16 * 1024;
const MAX_RUNTIME_MESSAGE_BYTES = 4 * 1024 * 1024;
const READ_ONLY_RUNTIME_METHODS = new Set([
  "thread/read",
  "thread/turns/list",
  "thread/list",
  "permissionProfile/list",
]);
const FAILURE_KINDS = new Set([
  "identity-mismatch",
  "incompatibility",
  "infrastructure",
  "malformed-output",
  "timeout",
]);

export class WireCompatibilityMismatch extends Error {
  constructor(message) {
    super(message);
    this.name = "WireCompatibilityMismatch";
  }
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function observedAt(now) {
  const value = now().toISOString();
  if (!Number.isFinite(Date.parse(value))) {
    throw new Error("wire evidence observation clock returned an invalid time");
  }
  return value;
}

function identityFromText(value) {
  const version = String(value).match(VERSION_PATTERN)?.[1] ?? null;
  return { version, commitSha: null };
}

function normalizeIdentities(values, label) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error(`${label} must contain at least one exact Codex identity`);
  }
  return values.map((value, index) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      typeof value.version !== "string" ||
      !/^\d+\.\d+\.\d+$/u.test(value.version) ||
      ![undefined, null].includes(value.commitSha) &&
        !/^[a-f0-9]{40}$/u.test(value.commitSha)
    ) {
      throw new Error(`${label}[${index}] is invalid`);
    }
    return {
      version: value.version,
      commitSha: value.commitSha ?? null,
    };
  });
}

function matchesExpectedIdentity(expected, observed) {
  return expected.version === observed.version &&
    (expected.commitSha === null || expected.commitSha === observed.commitSha);
}

function evidenceReport({
  checkId,
  evidenceKind,
  expectedIdentities,
  failure = null,
  identity = null,
  observations = [],
  observed,
  outcome,
  provenance,
  summary,
}) {
  return Object.freeze({
    schemaVersion: WIRE_COMPATIBILITY_EVIDENCE_SCHEMA_VERSION,
    checkId,
    evidenceKind,
    outcome,
    countsForCompatibility: outcome === "passed",
    authority: outcome === "passed" || outcome === "failed"
      ? "decisive-wire-evidence"
      : "non-evidence",
    expectedCodexIdentities: Object.freeze(expectedIdentities),
    observedCodexIdentity: identity && Object.freeze(identity),
    provenance: Object.freeze(provenance),
    digest: provenance.digest ?? null,
    observedAt: observed,
    observations: Object.freeze(observations),
    failure: failure && Object.freeze(failure),
    limitations: Object.freeze([
      "Does not infer Codex Desktop, cloud, entitlement, rollout, or closed-host semantics.",
    ]),
    summary,
  });
}

function failureReport(base, error, fallbackKind = "infrastructure") {
  const failureKind =
    error?.code === "ETIMEDOUT" || error?.killed || error?.signal
      ? "timeout"
      : error instanceof SyntaxError
        ? "malformed-output"
        : error instanceof WireCompatibilityMismatch
          ? "incompatibility"
          : fallbackKind;
  const outcome = failureKind === "incompatibility"
    ? "failed"
    : "infrastructure-failure";
  return evidenceReport({
    ...base,
    outcome,
    failure: {
      kind: failureKind,
      message: error?.message || String(error),
    },
    summary: `${base.checkId}: ${failureKind}`,
  });
}

function assertDeclaration(declaration, evidenceKind) {
  if (!declaration || typeof declaration !== "object" || Array.isArray(declaration)) {
    throw new Error(`${evidenceKind} declaration is required`);
  }
  if (typeof declaration.checkId !== "string" || !declaration.checkId) {
    throw new Error(`${evidenceKind} declaration.checkId is required`);
  }
  return normalizeIdentities(
    declaration.expectedCodexIdentities,
    `${evidenceKind} declaration.expectedCodexIdentities`,
  );
}

function artifactIdentities(value) {
  if (Array.isArray(value?.codexIdentities)) {
    return normalizeIdentities(value.codexIdentities, "artifact.codexIdentities");
  }
  if (Array.isArray(value?.testedCodexVersions)) {
    return normalizeIdentities(
      value.testedCodexVersions.map((version) => ({ version })),
      "artifact.testedCodexVersions",
    );
  }
  if (typeof value?.codexIdentity?.version === "string") {
    return normalizeIdentities([value.codexIdentity], "artifact.codexIdentity");
  }
  throw new SyntaxError("generated schema output has no exact Codex identity");
}

function assertExpectedIdentities(observed, expected) {
  for (const identity of observed) {
    if (!expected.some(
      (candidate) => matchesExpectedIdentity(candidate, identity),
    )) {
      const error = new Error(
        `observed Codex ${identity.version} does not match the declared identity`,
      );
      error.failureKind = "identity-mismatch";
      throw error;
    }
  }
  for (const identity of expected) {
    if (!observed.some(
      (candidate) => matchesExpectedIdentity(identity, candidate),
    )) {
      const error = new Error(
        `declared Codex ${identity.version} is absent from generated output`,
      );
      error.failureKind = "identity-mismatch";
      throw error;
    }
  }
}

function defaultSchemaValidator(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SyntaxError("generated schema output must be a JSON object");
  }
  if (value.methods !== undefined) {
    const required = ["thread/read", "thread/turns/list"];
    if (!required.every((method) => Object.hasOwn(value.methods, method))) {
      throw new WireCompatibilityMismatch(
        "generated schema is missing a required bounded read operation",
      );
    }
  }
}

async function executeDeclaredCommand(command, { runCommand, timeoutMs }) {
  if (
    !command ||
    typeof command.executable !== "string" ||
    !command.executable ||
    !Array.isArray(command.args) ||
    command.args.some((argument) => typeof argument !== "string")
  ) {
    throw new Error("declared command must provide executable and string args");
  }
  return runCommand(command.executable, command.args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    timeout: timeoutMs,
  });
}

export async function collectGeneratedSchemaEvidenceV1({
  declaration,
  now = () => new Date(),
  root = process.cwd(),
  runCommand = execFileAsync,
  timeoutMs = 30_000,
  validateSchema = defaultSchemaValidator,
} = {}) {
  const expectedIdentities = assertDeclaration(declaration, "generated-schema");
  const observed = observedAt(now);
  let provenance = { mode: "undeclared", digest: null };
  const base = {
    checkId: declaration.checkId,
    evidenceKind: "generated-schema",
    expectedIdentities,
    observed,
    provenance,
    identity: null,
  };
  try {
    let bytes;
    let parsed;
    let identities;
    if (declaration.artifact) {
      if (
        typeof declaration.artifact.path !== "string" ||
        !declaration.artifact.path ||
        resolve(root, declaration.artifact.path) === resolve(root) ||
        !resolve(root, declaration.artifact.path).startsWith(`${resolve(root)}/`)
      ) {
        throw new Error("declared generated-schema artifact path is invalid");
      }
      bytes = await readFile(resolve(root, declaration.artifact.path));
      provenance = {
        mode: "artifact",
        artifactPath: declaration.artifact.path,
        digest: digest(bytes),
      };
      parsed = JSON.parse(bytes.toString("utf8"));
      identities = artifactIdentities(parsed);
    } else if (declaration.command) {
      if (!declaration.identityCommand) {
        throw new Error("generated-schema command requires a declared identityCommand");
      }
      const identityResult = await executeDeclaredCommand(
        declaration.identityCommand,
        { runCommand, timeoutMs },
      );
      const identity = identityFromText(identityResult.stdout);
      if (!identity.version) {
        throw new SyntaxError("declared identity command returned no stable Codex version");
      }
      const result = await executeDeclaredCommand(
        declaration.command,
        { runCommand, timeoutMs },
      );
      bytes = Buffer.from(result.stdout, "utf8");
      provenance = {
        mode: "command",
        executable: declaration.command.executable,
        args: [...declaration.command.args],
        identityExecutable: declaration.identityCommand.executable,
        identityArgs: [...declaration.identityCommand.args],
        digest: digest(bytes),
      };
      parsed = JSON.parse(result.stdout);
      identities = [identity];
    } else {
      throw new Error("generated-schema declaration must select artifact or command");
    }
    assertExpectedIdentities(identities, expectedIdentities);
    await validateSchema(parsed);
    return evidenceReport({
      ...base,
      provenance,
      identity: identities.length === 1 ? identities[0] : null,
      observations: identities.map((identity) => ({
        operation: "generated-schema",
        status: "observed",
        codexIdentity: identity,
      })),
      outcome: "passed",
      summary: `generated schema observed for ${identities.map(({ version }) => version).join(", ")}`,
    });
  } catch (error) {
    const kind = error.failureKind ?? (
      error?.code === "ENOENT" ? "infrastructure" : undefined
    );
    return failureReport(
      { ...base, provenance },
      error,
      kind === "identity-mismatch" ? "identity-mismatch" : "infrastructure",
    );
  }
}

class StdioJsonlTransport {
  #buffer = "";
  #child;
  #closed = false;
  #nextId = 1;
  #pending = new Map();

  constructor(command, timeoutMs) {
    this.timeoutMs = timeoutMs;
    this.#child = spawn(command, ["app-server", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stdout.setEncoding("utf8");
    this.#child.stdout.on("data", (chunk) => this.#consume(chunk));
    this.#child.once("error", (error) => this.#fail(error));
    this.#child.once("exit", (code, signal) => {
      if (!this.#closed) {
        this.#fail(new Error(
          `Codex app-server exited (${signal || code || "unknown"})`,
        ));
      }
    });
    this.#child.stderr.resume();
  }

  #consume(chunk) {
    this.#buffer += chunk;
    if (Buffer.byteLength(this.#buffer, "utf8") > MAX_RUNTIME_MESSAGE_BYTES) {
      this.#fail(new SyntaxError("runtime response exceeded the message bound"));
      return;
    }
    let newline;
    while ((newline = this.#buffer.indexOf("\n")) !== -1) {
      const line = this.#buffer.slice(0, newline).trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.#fail(new SyntaxError(`runtime returned malformed JSON: ${error.message}`));
        return;
      }
      const pending = this.#pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new WireCompatibilityMismatch(
          `${pending.method} was rejected: ${message.error.message ?? "unknown error"}`,
        ));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  #fail(error) {
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }

  request(method, params) {
    const id = this.#nextId++;
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        const error = new Error(`${method} timed out`);
        error.code = "ETIMEDOUT";
        reject(error);
      }, this.timeoutMs);
      this.#pending.set(id, { method, resolve: resolvePromise, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method, params) {
    this.#child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  async close() {
    this.#closed = true;
    this.#child.stdin.end();
    this.#child.kill("SIGTERM");
  }
}

function runtimeIdentity(result) {
  const identity = identityFromText(result?.userAgent);
  if (!identity.version) {
    throw new SyntaxError("runtime initialize returned no exact stable Codex identity");
  }
  return identity;
}

function validateRuntimeOperations(operations) {
  if (
    !Array.isArray(operations) ||
    operations.length > MAX_RUNTIME_OPERATIONS
  ) {
    throw new Error(
      `runtime operations must contain at most ${MAX_RUNTIME_OPERATIONS} declared probes`,
    );
  }
  for (const operation of operations) {
    if (
      !operation ||
      !READ_ONLY_RUNTIME_METHODS.has(operation.method) ||
      operation.readOnly !== true ||
      !operation.params ||
      typeof operation.params !== "object" ||
      Array.isArray(operation.params) ||
      Buffer.byteLength(JSON.stringify(operation.params), "utf8") >
        MAX_RUNTIME_PARAMS_BYTES
    ) {
      throw new Error("runtime operations must be declared bounded read-only methods");
    }
    if (
      operation.params.limit !== undefined &&
      (!Number.isSafeInteger(operation.params.limit) ||
        operation.params.limit < 1 ||
        operation.params.limit > 100)
    ) {
      throw new Error("runtime operation limit must be an integer from 1 to 100");
    }
    if (
      ["thread/read", "thread/turns/list"].includes(operation.method) &&
      (
        typeof operation.params.threadId !== "string" ||
        operation.params.threadId.length === 0 ||
        operation.params.threadId.length > 512
      )
    ) {
      throw new Error(`${operation.method} requires a bounded threadId`);
    }
  }
}

async function collectRuntime({
  declaration,
  evidenceKind,
  enabled,
  now,
  timeoutMs,
  transportFactory,
}) {
  const expectedIdentities = assertDeclaration(declaration, evidenceKind);
  const observed = observedAt(now);
  const provenance = {
    mode: "runtime",
    executable: declaration.executable ?? null,
    transport: declaration.transport,
    operations: (declaration.operations ?? []).map(({ method }) => method),
    digest: null,
  };
  const base = {
    checkId: declaration.checkId,
    evidenceKind,
    expectedIdentities,
    observed,
    provenance,
    identity: null,
  };
  if (evidenceKind === "runtime-live" && enabled !== true) {
    return evidenceReport({
      ...base,
      outcome: "unavailable",
      failure: {
        kind: "infrastructure",
        message: "runtime-live collection requires enabled: true",
      },
      summary: "runtime-live probe was not explicitly enabled",
    });
  }
  let transport;
  try {
    if (declaration.transport !== "stdio-jsonl") {
      throw new Error("only declared stdio-jsonl runtime transport is supported");
    }
    validateRuntimeOperations(declaration.operations);
    if (!transportFactory && (
      typeof declaration.executable !== "string" || !declaration.executable
    )) {
      throw new Error("runtime declaration.executable is required");
    }
    transport = transportFactory
      ? await transportFactory(declaration)
      : new StdioJsonlTransport(declaration.executable, timeoutMs);
    const initialize = await transport.request("initialize", {
      clientInfo: {
        name: "nelos_wire_collector",
        title: "Nelos Wire Compatibility Collector",
        version: "1.0.0",
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    const identity = runtimeIdentity(initialize);
    if (!expectedIdentities.some(
      (candidate) => matchesExpectedIdentity(candidate, identity),
    )) {
      const error = new Error(
        `runtime Codex ${identity.version} is not an exact declared supported identity`,
      );
      error.failureKind = "identity-mismatch";
      throw error;
    }
    transport.notify?.("initialized", {});
    const observations = [{
      operation: "initialize",
      status: "passed",
      digest: digest(JSON.stringify(initialize)),
    }];
    for (const operation of declaration.operations) {
      const result = await transport.request(operation.method, operation.params);
      if (typeof operation.validate === "function") {
        await operation.validate(result);
      }
      observations.push({
        operation: operation.method,
        status: "passed",
        digest: digest(JSON.stringify(result)),
      });
    }
    const reportDigest = digest(JSON.stringify(observations));
    return evidenceReport({
      ...base,
      identity,
      provenance: { ...provenance, digest: reportDigest },
      observations,
      outcome: "passed",
      summary: `${evidenceKind} passed against exact Codex ${identity.version}`,
    });
  } catch (error) {
    return failureReport(
      base,
      error,
      error.failureKind ?? "infrastructure",
    );
  } finally {
    await transport?.close?.().catch(() => {});
  }
}

export function collectRuntimeTransportEvidenceV1(options = {}) {
  return collectRuntime({
    ...options,
    evidenceKind: "runtime-transport",
    enabled: true,
    now: options.now ?? (() => new Date()),
    timeoutMs: options.timeoutMs ?? 10_000,
  });
}

export function collectRuntimeLiveEvidenceV1(options = {}) {
  return collectRuntime({
    ...options,
    evidenceKind: "runtime-live",
    enabled: options.enabled,
    now: options.now ?? (() => new Date()),
    timeoutMs: options.timeoutMs ?? 10_000,
  });
}

export function concludeWireCompatibilityV1({
  generatedSchema = [],
  runtimeTransport = [],
  runtimeLive = [],
  implementationSource = [],
} = {}) {
  const decisive = [
    ...generatedSchema,
    ...runtimeTransport,
    ...runtimeLive,
  ];
  const failed = decisive.filter(({ outcome }) => outcome === "failed");
  const passed = decisive.filter(({ outcome }) => outcome === "passed");
  const status = failed.length > 0
    ? "incompatible"
    : passed.length > 0
      ? "compatible"
      : "unverified";
  return Object.freeze({
    schemaVersion: WIRE_COMPATIBILITY_CONCLUSION_SCHEMA_VERSION,
    status,
    decisiveEvidence: Object.freeze(decisive),
    advisoryImplementationSource: Object.freeze(
      implementationSource.map((observation) => Object.freeze({
        ...observation,
        countsForCompatibility: false,
        authority: "advisory-only",
      })),
    ),
    rationale: failed.length > 0
      ? "Generated-schema or exact runtime evidence found an incompatibility."
      : passed.length > 0
        ? "Generated-schema or exact runtime evidence supports compatibility."
        : "No generated-schema or exact runtime compatibility evidence is available.",
  });
}

export function validateWireCompatibilityEvidenceV1(report) {
  if (
    !report ||
    report.schemaVersion !== WIRE_COMPATIBILITY_EVIDENCE_SCHEMA_VERSION ||
    !["generated-schema", "runtime-transport", "runtime-live"]
      .includes(report.evidenceKind) ||
    !["passed", "failed", "unavailable", "infrastructure-failure"]
      .includes(report.outcome) ||
    report.countsForCompatibility !== (report.outcome === "passed") ||
    typeof report.observedAt !== "string" ||
    !Number.isFinite(Date.parse(report.observedAt)) ||
    report.digest !== null && !SHA256_PATTERN.test(report.digest) ||
    report.failure !== null && !FAILURE_KINDS.has(report.failure.kind)
  ) {
    throw new Error("wire compatibility evidence report is invalid");
  }
  return report;
}
