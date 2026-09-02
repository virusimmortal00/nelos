import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  probeAppServerExecutionV1,
  normalizeExecutionProbeOptionsV1,
  EXECUTION_DISCOVERY_METHODS,
  EXECUTION_DISCOVERY_SCHEMA_VERSION,
} from "../src/app-server-execution-profile.mjs";
import { executionProbeResponses, probeSelection } from "./support/execution-probe-fixture.mjs";

async function probe({ responses = executionProbeResponses(), request, observedVersion = "0.152.0", options = {} } = {}) {
  const calls = [];
  const result = await probeAppServerExecutionV1({
    observedVersion,
    options: { ...probeSelection, ...options },
    request: async (method, params, context) => {
      calls.push({ method, params });
      return request ? request(method, params, context) : responses[method];
    },
  });
  return { calls, result };
}

test("execution discovery requires live exact route and policy matches, without issuing a grant", async () => {
  const { calls, result } = await probe();
  assert.equal(result.state, "discovery-complete");
  assert.equal(result.executionAuthorized, false);
  assert.equal(result.runtimeCertified, false);
  assert.equal(result.reviewedSchemaVersion, "0.152.0");
  assert.deepEqual(result.blockers, []);
  assert.deepEqual(calls.map(({ method }) => method), EXECUTION_DISCOVERY_METHODS);
  assert.deepEqual(calls[0].params, { refreshToken: false });
  assert.equal(calls[2].params.cwd, probeSelection.cwd);
  assert.equal(calls[3].params, null);
  assert.doesNotMatch(JSON.stringify(result), /private|example.invalid|description|instructions/i);
});

test("missing auth, requested model/effort/profile, and managed policy restrictions fail closed", async () => {
  const cases = [
    ["account/read", { requiresOpenaiAuth: true, account: null }, "accountConfigured"],
    ["model/list", { data: [] }, "modelAndEffortAdvertised"],
    ["model/list", { data: [{ model: probeSelection.model, supportedReasoningEfforts: [{ reasoningEffort: "low" }] }] }, "modelAndEffortAdvertised"],
    ["permissionProfile/list", { data: [] }, "permissionProfileAllowed"],
    ["permissionProfile/list", { data: [{ id: "workspace", allowed: false }] }, "permissionProfileAllowed"],
    ["configRequirements/read", { requirements: { allowedApprovalPolicies: ["never"] } }, "approvalPolicyAllowed"],
  ];
  for (const [method, response, blocker] of cases) {
    const responses = { ...executionProbeResponses(), [method]: response };
    const { result } = await probe({ responses });
    assert.equal(result.state, "unavailable", method);
    assert.equal(result.checks[blocker], "unsatisfied");
    assert.equal(result.blockers[0].code, blocker);
  }
});

test("malformed discovery cannot turn unknown capabilities into positive evidence", async () => {
  for (const [method, response] of [
    ["account/read", { requiresOpenaiAuth: "true", account: {} }],
    ["account/read", { requiresOpenaiAuth: true, account: { type: "future-auth" } }],
    ["model/list", { data: [{ model: probeSelection.model, supportedReasoningEfforts: ["high"] }] }],
    ["permissionProfile/list", { data: [{ id: "workspace", allowed: "true" }] }],
    ["configRequirements/read", {}],
    ["configRequirements/read", { requirements: { allowedApprovalPolicies: true } }],
  ]) {
    const { result } = await probe({ responses: { ...executionProbeResponses(), [method]: response } });
    assert.equal(result.state, "unavailable");
    assert.equal(result.blockers[0].code, "invalid-probe-response", method);
    assert.equal(result.blockers[0].method, method);
  }
});

test("exact matches on later pages are found and duplicate matches are ambiguous", async () => {
  const responses = executionProbeResponses();
  const { result, calls } = await probe({ request: (method, params) => {
    if (["model/list", "permissionProfile/list"].includes(method) && !params.cursor) {
      return { data: [], nextCursor: "page2" };
    }
    return responses[method];
  } });
  assert.equal(result.state, "discovery-complete");
  assert.equal(calls.filter(({ params }) => params?.cursor === "page2").length, 2);
  for (const method of ["model/list", "permissionProfile/list"]) {
    const duplicate = await probe({ request: (name, params) => name === method ? {
      ...responses[name], nextCursor: params.cursor ? null : "duplicate",
    } : responses[name] });
    assert.equal(duplicate.result.state, "unavailable");
    assert.match(duplicate.result.blockers[0].code, /^ambiguous-/);
  }
});

test("pagination loops, oversized pages, and endless cursors have hard bounds", async () => {
  for (const mode of ["repeat", "endless", "oversized"]) {
    let pages = 0;
    const responses = executionProbeResponses();
    const { result } = await probe({ request: (method) => {
      if (method !== "model/list") return responses[method];
      pages += 1;
      return mode === "oversized" ? { data: Array(101).fill(responses[method].data[0]) } :
        { data: [], nextCursor: mode === "repeat" ? "same" : `page${pages}` };
    } });
    assert.equal(result.state, "unavailable");
    assert.equal(pages, mode === "repeat" ? 2 : mode === "endless" ? 4 : 1);
  }
});

test("unsupported methods preserve RPC codes while discarding server secrets", async () => {
  const responses = executionProbeResponses();
  const { result } = await probe({ request: (method) => {
    if (method === "permissionProfile/list") throw Object.assign(new Error("private token"), { rpcCode: -32601 });
    return responses[method];
  } });
  assert.deepEqual(result.blockers, [{ code: "probe-method-unsupported", method: "permissionProfile/list", rpcCode: -32601 }]);
  assert.doesNotMatch(JSON.stringify(result), /private token/);
});

test("a hung read ends at the overall deadline even if its transport ignores cancellation", async () => {
  let signal;
  const { result, calls } = await probe({
    options: { timeoutMs: 20 },
    request: (_method, _params, context) => {
      signal = context.signal;
      return new Promise(() => {});
    },
  });
  assert.equal(signal.aborted, true);
  assert.equal(calls.length, 4);
  assert.equal(result.blockers.length, 4);
  assert.ok(result.blockers.every(({ code }) => code === "probe-timeout"));
});

test("older and invalid versions do not probe, and newer versions remain uncertified", async () => {
  for (const observedVersion of ["0.144.6", "0.152.0-beta.1", "invalid", null]) {
    const { result, calls } = await probe({ observedVersion });
    assert.deepEqual(calls, []);
    assert.equal(result.state, "unavailable");
  }
  const { result } = await probe({ observedVersion: "0.152.1" });
  assert.equal(result.state, "discovery-complete");
  assert.equal(result.runtimeCertified, false);
});

test("invalid or caller-authored authority inputs are rejected before any request", async () => {
  for (const options of [{ cwd: "relative" }, { model: "" }, { timeoutMs: 30_001 },
    { approvalPolicy: "unlessTrusted" }, { executionAuthorized: true }, { launcherAvailable: true }]) {
    assert.throws(() => normalizeExecutionProbeOptionsV1({ ...probeSelection, ...options }));
  }
});

test("the discovery profile records the reduced generated schema and its evidence boundary", async () => {
  const fixture = JSON.parse(await readFile(new URL("./fixtures/app-server-execution-discovery-0.152.0.json", import.meta.url)));
  assert.equal(fixture.codexVersion, EXECUTION_DISCOVERY_SCHEMA_VERSION);
  assert.equal(fixture.runtimeExecutionTested, false);
  assert.deepEqual(Object.keys(fixture.methods), EXECUTION_DISCOVERY_METHODS);
  assert.equal(fixture.methods["account/read"].params.refreshToken.type, "boolean");
  assert.equal(fixture.methods["permissionProfile/list"].consumedDefinitions.PermissionProfileSummary.properties.allowed.type, "boolean");
  assert.deepEqual(fixture.methods["configRequirements/read"].params, { type: "null" });
});
