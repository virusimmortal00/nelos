import { isAbsolute } from "node:path";

export const EXECUTION_DISCOVERY_SCHEMA_VERSION = "0.152.0";
// Exact generated-schema reviews for diagnostics, never runtime admission. Desktop
// can bundle a prerelease CLI even when the Desktop release channel is stable.
export const REVIEWED_EXECUTION_SCHEMA_VERSIONS = Object.freeze([
  "0.152.0", "0.153.4", "0.154.0", "0.154.0-alpha.6.1", "0.154.0-alpha.6.2",
]);
export const EXECUTION_DISCOVERY_METHODS = Object.freeze([
  "account/read", "model/list", "permissionProfile/list", "configRequirements/read",
]);
const PAGE_SIZE = 100;
const MAX_PAGES = 4;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, maximum = 512) => typeof value === "string" &&
  value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f\u007f]/u.test(value);

class ProbeError extends Error {
  constructor(code, method = null, rpcCode = null) {
    super(code);
    this.code = code;
    this.method = method;
    this.rpcCode = Number.isSafeInteger(rpcCode) ? rpcCode : null;
  }
}

export function normalizeExecutionProbeOptionsV1(options) {
  const keys = ["cwd", "model", "reasoningEffort", "permissionProfile", "approvalPolicy", "timeoutMs"];
  if (!object(options) || Object.keys(options).some((key) => !keys.includes(key))) {
    throw new Error("execution probe options are invalid");
  }
  for (const key of keys.slice(0, 4)) {
    if (!text(options[key], key === "cwd" ? 4096 : 512)) {
      throw new Error(`execution probe ${key} is invalid`);
    }
  }
  if (!isAbsolute(options.cwd)) throw new Error("execution probe cwd must be an absolute path on this host");
  if (!["untrusted", "on-request", "never"].includes(options.approvalPolicy)) {
    throw new Error("execution probe requires an explicit supported approvalPolicy");
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 30_000) {
    throw new Error("execution probe timeoutMs must be between 1 and 30000");
  }
  return { ...options, timeoutMs };
}

// Discovery is deliberately not an execution grant. Even successful observations
// still need target/auth binding, a certified executor, and effective-policy checks.
export async function probeAppServerExecutionV1({ request, observedVersion, options }) {
  const selected = normalizeExecutionProbeOptionsV1(options);
  if (typeof request !== "function") throw new Error("execution probe requires a request function");
  const result = {
    schemaVersion: 1,
    source: "app-server-read-probe",
    reviewedSchemaVersion: REVIEWED_EXECUTION_SCHEMA_VERSIONS.includes(observedVersion)
      ? observedVersion : EXECUTION_DISCOVERY_SCHEMA_VERSION,
    observedVersion: text(observedVersion) ? observedVersion : null,
    state: "unavailable",
    executionAuthorized: false,
    runtimeCertified: false,
    selection: {
      cwd: selected.cwd,
      model: selected.model,
      reasoningEffort: selected.reasoningEffort,
      permissionProfile: selected.permissionProfile,
      approvalPolicy: selected.approvalPolicy,
    },
    checks: {},
    blockers: [],
  };
  const controller = new AbortController();
  const deadlineAt = Date.now() + selected.timeoutMs;
  const timer = setTimeout(() => controller.abort(), selected.timeoutMs);
  async function read(method, params) {
    if (controller.signal.aborted) throw new ProbeError("probe-timeout", method);
    let abort;
    try {
      const response = await Promise.race([
        Promise.resolve().then(() => {
          if (controller.signal.aborted) throw new ProbeError("probe-timeout", method);
          return request(method, params, { deadlineAt, signal: controller.signal });
        }),
        new Promise((_, reject) => {
          abort = () => reject(new ProbeError("probe-timeout", method));
          controller.signal.addEventListener("abort", abort, { once: true });
        }),
      ]);
      if (controller.signal.aborted) throw new ProbeError("probe-timeout", method);
      if (!object(response)) throw new ProbeError("invalid-probe-response", method);
      return response;
    } catch (error) {
      if (error instanceof ProbeError) throw error;
      throw new ProbeError(error?.rpcCode === -32601 ? "probe-method-unsupported" :
        "probe-request-failed", method, error?.rpcCode);
    } finally {
      controller.signal.removeEventListener("abort", abort);
    }
  }
  async function pages(method, params, validate) {
    const rows = [];
    const cursors = new Set();
    let cursor;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await read(method, { ...params, limit: PAGE_SIZE, ...(cursor ? { cursor } : {}) });
      if (!Array.isArray(response.data) || response.data.length > PAGE_SIZE ||
          !response.data.every(validate)) throw new ProbeError("invalid-probe-response", method);
      rows.push(...response.data);
      if (response.nextCursor === undefined || response.nextCursor === null) return rows;
      if (!text(response.nextCursor, 4096) || cursors.has(response.nextCursor)) {
        throw new ProbeError("invalid-probe-pagination", method);
      }
      cursor = response.nextCursor;
      cursors.add(cursor);
    }
    throw new ProbeError("probe-page-limit", method);
  }
  const probes = [
    ["accountConfigured", async () => {
      const response = await read("account/read", { refreshToken: false });
      if (typeof response.requiresOpenaiAuth !== "boolean" ||
          (response.account != null && (!object(response.account) ||
            !["apiKey", "chatgpt", "amazonBedrock"].includes(response.account.type)))) {
        throw new ProbeError("invalid-probe-response", "account/read");
      }
      return response.requiresOpenaiAuth === false || response.account != null;
    }],
    ["modelAndEffortAdvertised", async () => {
      const models = await pages("model/list", { includeHidden: true }, (model) =>
        object(model) && text(model.model) &&
        Array.isArray(model.supportedReasoningEfforts) && model.supportedReasoningEfforts.length <= 32 &&
        model.supportedReasoningEfforts.every((effort) => object(effort) && text(effort.reasoningEffort)));
      const matches = models.filter((model) => model.model === selected.model);
      if (matches.length > 1) throw new ProbeError("ambiguous-model-route", "model/list");
      return matches.length === 1 && matches[0].supportedReasoningEfforts.some(
        (effort) => effort.reasoningEffort === selected.reasoningEffort,
      );
    }],
    ["permissionProfileAllowed", async () => {
      const profiles = await pages("permissionProfile/list", { cwd: selected.cwd }, (profile) =>
        object(profile) && text(profile.id) && typeof profile.allowed === "boolean");
      const matches = profiles.filter((profile) => profile.id === selected.permissionProfile);
      if (matches.length > 1) throw new ProbeError("ambiguous-permission-profile", "permissionProfile/list");
      return matches.length === 1 && matches[0].allowed;
    }],
    ["approvalPolicyAllowed", async () => {
      const response = await read("configRequirements/read", null);
      if (!Object.hasOwn(response, "requirements") ||
          (response.requirements !== null && !object(response.requirements))) {
        throw new ProbeError("invalid-probe-response", "configRequirements/read");
      }
      const policies = response.requirements?.allowedApprovalPolicies;
      if (policies === undefined || policies === null) return true;
      if (!Array.isArray(policies) || policies.length > 32 ||
          !policies.every((policy) => ["untrusted", "on-request", "never"].includes(policy) ||
            (object(policy) && object(policy.granular) &&
              ["mcp_elicitations", "rules", "sandbox_approval"].every(
                (key) => typeof policy.granular[key] === "boolean")))) {
        throw new ProbeError("invalid-probe-response", "configRequirements/read");
      }
      return policies.includes(selected.approvalPolicy);
    }],
  ];
  try {
    const outcomes = await Promise.allSettled(probes.map(([, probe]) => probe()));
    outcomes.forEach((outcome, index) => {
      const check = probes[index][0];
      if (outcome.status === "fulfilled") {
        result.checks[check] = outcome.value ? "satisfied" : "unsatisfied";
        if (!outcome.value) result.blockers.push({ code: check, method: EXECUTION_DISCOVERY_METHODS[index], rpcCode: null });
      } else {
        result.checks[check] = "unknown";
        const error = outcome.reason;
        result.blockers.push({ code: error instanceof ProbeError ? error.code : "invalid-probe-response",
          method: EXECUTION_DISCOVERY_METHODS[index], rpcCode: error?.rpcCode ?? null });
      }
    });
    result.state = result.blockers.length ? "unavailable" : "discovery-complete";
    return result;
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
