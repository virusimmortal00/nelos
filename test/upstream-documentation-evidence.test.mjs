import assert from "node:assert/strict";
import test from "node:test";

import {
  adaptUpstreamDocumentationObservationV1,
  collectUpstreamDocumentationContractsV1,
  collectUpstreamDocumentationEvidenceV1,
  createUpstreamDocumentationReportV1,
  validateUpstreamDocumentationContractV1,
} from "../src/upstream-documentation-evidence.mjs";
import {
  APP_SERVER_DOCUMENTATION_CONTRACT_V1,
} from "../src/upstream-documentation-contracts.mjs";
import {
  COMPATIBILITY_CONTRACT_REGISTRY_V1,
} from "../src/compatibility-contract-registry.mjs";

function contract(overrides = {}) {
  return {
    schemaVersion: 1,
    id: "docs.test",
    evidenceKind: "upstream-docs",
    official: true,
    requestedUrl: "https://docs.example.test/guide",
    selection: {
      kind: "artifact",
      name: "guide",
      maxBytes: 1_024,
      contentTypes: ["text/plain"],
    },
    timeoutMs: 100,
    redirectPolicy: "reject",
    ...overrides,
  };
}

function response(body, overrides = {}) {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/plain" },
    ...overrides,
  });
}

const fixedNow = () => "2026-07-29T12:00:00.000Z";

test("App Server documentation contract derives its URL from the registry", () => {
  const check = COMPATIBILITY_CONTRACT_REGISTRY_V1.checks.find(
    ({ id }) => id === "upstream.app-server-docs",
  );
  assert.equal(APP_SERVER_DOCUMENTATION_CONTRACT_V1.requestedUrl, check.source);
});

test("collector fetches the exact declared URL and records a bounded artifact digest", async () => {
  const requests = [];
  const observation = await collectUpstreamDocumentationEvidenceV1(
    contract(),
    {
      now: fixedNow,
      fetchImpl: async (url, options) => {
        requests.push({ url, options });
        return response("official fixture guidance");
      },
    },
  );

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "https://docs.example.test/guide");
  assert.equal(requests[0].options.redirect, "manual");
  assert.equal(observation.status, "available");
  assert.equal(observation.requestedUrl, "https://docs.example.test/guide");
  assert.deepEqual(observation.selected, { kind: "artifact", name: "guide" });
  assert.match(observation.digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(observation.observedAt, fixedNow());
  assert.equal(observation.evidenceKind, "upstream-docs");
  assert.equal(observation.selectedText, "official fixture guidance");
});

test("section collection inspects only the declared marker-bounded section", async () => {
  const sectionContract = contract({
    selection: {
      kind: "section",
      name: "models",
      startMarker: "<!-- models:start -->",
      endMarker: "<!-- models:end -->",
      maxBytes: 1_024,
      contentTypes: ["text/plain"],
    },
  });
  const observation = await collectUpstreamDocumentationEvidenceV1(
    sectionContract,
    {
      now: fixedNow,
      fetchImpl: async () =>
        response("ignored<!-- models:start -->selected<!-- models:end -->ignored"),
    },
  );
  assert.equal(observation.status, "available");
  assert.equal(observation.selectedText, "selected");
});

test("network, parsing, missing-section, redirect, and timeout failures are unavailable", async () => {
  const cases = [
    {
      expected: "network",
      contract: contract(),
      fetchImpl: async () => {
        throw new TypeError("socket unavailable");
      },
    },
    {
      expected: "parsing",
      contract: contract({
        selection: {
          kind: "artifact",
          name: "guide",
          maxBytes: 2,
          contentTypes: ["text/plain"],
        },
      }),
      fetchImpl: async () => response("too long"),
    },
    {
      expected: "parsing",
      contract: contract(),
      fetchImpl: async () => response("   "),
    },
    {
      expected: "missing-section",
      contract: contract({
        selection: {
          kind: "section",
          name: "models",
          startMarker: "BEGIN",
          endMarker: "END",
          maxBytes: 1_024,
          contentTypes: ["text/plain"],
        },
      }),
      fetchImpl: async () => response("section absent"),
    },
    {
      expected: "redirect-policy",
      contract: contract(),
      fetchImpl: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://other.example.test/" },
        }),
    },
    {
      expected: "timeout",
      contract: contract({ timeoutMs: 5 }),
      fetchImpl: async () => new Promise(() => {}),
    },
  ];

  for (const item of cases) {
    const observation = await collectUpstreamDocumentationEvidenceV1(
      item.contract,
      { now: fixedNow, fetchImpl: item.fetchImpl },
    );
    assert.equal(observation.status, "unavailable", item.expected);
    assert.equal(observation.failureKind, item.expected);
    assert.equal(observation.countsForCompatibility, false);
    assert.equal(observation.digest, null);
  }
});

test("report and compatibility adapters omit fetched text and never count failures", async () => {
  const observations = await collectUpstreamDocumentationContractsV1(
    [contract()],
    {
      now: fixedNow,
      fetchImpl: async () => {
        throw new Error("fixture outage");
      },
    },
  );
  const report = createUpstreamDocumentationReportV1(observations);
  assert.equal(report.status, "unavailable");
  assert.equal(report.records[0].selectedText, undefined);
  assert.deepEqual(
    Object.keys(report.records[0]).sort(),
    [
      "contractId",
      "countsForCompatibility",
      "detail",
      "digest",
      "evidenceKind",
      "failureKind",
      "observedAt",
      "requestedUrl",
      "selected",
      "status",
    ].sort(),
  );

  const evidence = adaptUpstreamDocumentationObservationV1(
    observations[0],
    { checkId: "upstream.docs" },
  );
  assert.equal(evidence.outcome, "infrastructure-failure");
  assert.equal(evidence.countsForCompatibility, false);
  assert.equal(evidence.kind, "upstream-docs");
});

test("contracts reject undeclared fields, non-HTTPS URLs, and unbounded selections", () => {
  assert.throws(
    () => validateUpstreamDocumentationContractV1({
      ...contract(),
      requestedUrl: "http://docs.example.test/guide",
    }),
    /absolute HTTPS URL/u,
  );
  assert.throws(
    () => validateUpstreamDocumentationContractV1({
      ...contract(),
      anotherUrl: "https://undeclared.example.test",
    }),
    /not allowed/u,
  );
  assert.throws(
    () => validateUpstreamDocumentationContractV1({
      ...contract(),
      selection: { ...contract().selection, maxBytes: Infinity },
    }),
    /maxBytes/u,
  );
});
