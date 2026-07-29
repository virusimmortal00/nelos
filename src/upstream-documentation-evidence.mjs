import { createHash } from "node:crypto";

export const UPSTREAM_DOCUMENTATION_EVIDENCE_KIND = "upstream-docs";
export const UPSTREAM_DOCUMENTATION_REPORT_SCHEMA_VERSION = 1;

const FAILURE_KINDS = new Set([
  "network",
  "parsing",
  "missing-section",
  "redirect-policy",
  "timeout",
]);

function fail(message) {
  throw new Error(`upstream documentation contract: ${message}`);
}

function validateString(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail(`${label} must be a non-empty string`);
  }
}

function validateUrl(value, label) {
  validateString(value, label);
  let url;
  try {
    url = new URL(value);
  } catch {
    fail(`${label} must be an absolute HTTPS URL`);
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    value.includes("*")
  ) {
    fail(`${label} must be a bounded absolute HTTPS URL`);
  }
}

export function validateUpstreamDocumentationContractV1(contract) {
  if (!contract || typeof contract !== "object" || Array.isArray(contract)) {
    fail("contract must be an object");
  }
  const allowed = [
    "schemaVersion",
    "id",
    "evidenceKind",
    "official",
    "requestedUrl",
    "selection",
    "timeoutMs",
    "redirectPolicy",
  ];
  for (const key of Object.keys(contract)) {
    if (!allowed.includes(key)) fail(`contract.${key} is not allowed`);
  }
  if (contract.schemaVersion !== 1) fail("contract.schemaVersion must be 1");
  validateString(contract.id, "contract.id");
  if (contract.evidenceKind !== UPSTREAM_DOCUMENTATION_EVIDENCE_KIND) {
    fail('contract.evidenceKind must be "upstream-docs"');
  }
  if (contract.official !== true) {
    fail("contract.official must explicitly be true");
  }
  validateUrl(contract.requestedUrl, "contract.requestedUrl");
  if (!Number.isInteger(contract.timeoutMs) || contract.timeoutMs < 1 || contract.timeoutMs > 60_000) {
    fail("contract.timeoutMs must be an integer from 1 through 60000");
  }
  if (contract.redirectPolicy !== "reject") {
    fail('contract.redirectPolicy must be "reject"');
  }
  const selection = contract.selection;
  if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
    fail("contract.selection must be an object");
  }
  const selectionKeys =
    selection.kind === "artifact"
      ? ["kind", "name", "maxBytes", "contentTypes"]
      : selection.kind === "section"
        ? ["kind", "name", "startMarker", "endMarker", "maxBytes", "contentTypes"]
        : [];
  if (selectionKeys.length === 0) {
    fail('contract.selection.kind must be "artifact" or "section"');
  }
  for (const key of Object.keys(selection)) {
    if (!selectionKeys.includes(key)) fail(`contract.selection.${key} is not allowed`);
  }
  validateString(selection.name, "contract.selection.name");
  if (!Number.isInteger(selection.maxBytes) || selection.maxBytes < 1 || selection.maxBytes > 2_000_000) {
    fail("contract.selection.maxBytes must be an integer from 1 through 2000000");
  }
  if (!Array.isArray(selection.contentTypes) || selection.contentTypes.length === 0) {
    fail("contract.selection.contentTypes must be a non-empty array");
  }
  selection.contentTypes.forEach((contentType, index) => {
    validateString(contentType, `contract.selection.contentTypes[${index}]`);
  });
  if (selection.kind === "section") {
    validateString(selection.startMarker, "contract.selection.startMarker");
    validateString(selection.endMarker, "contract.selection.endMarker");
    if (selection.startMarker === selection.endMarker) {
      fail("section markers must differ");
    }
  }
  return contract;
}

function selectedDescriptor(selection) {
  return Object.freeze({ kind: selection.kind, name: selection.name });
}

function unavailable(contract, observedAt, failureKind, detail) {
  return Object.freeze({
    schemaVersion: UPSTREAM_DOCUMENTATION_REPORT_SCHEMA_VERSION,
    contractId: contract.id,
    evidenceKind: UPSTREAM_DOCUMENTATION_EVIDENCE_KIND,
    requestedUrl: contract.requestedUrl,
    selected: selectedDescriptor(contract.selection),
    digest: null,
    observedAt,
    status: "unavailable",
    countsForCompatibility: false,
    failureKind,
    detail,
    selectedText: null,
  });
}

function classifyFetchError(error, timedOut) {
  if (timedOut || error?.name === "AbortError") return "timeout";
  return "network";
}

async function readBoundedText(response, selection) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > selection.maxBytes) {
    throw Object.assign(new Error(`artifact exceeds ${selection.maxBytes} bytes`), {
      failureKind: "parsing",
    });
  }
  const contentType = response.headers?.get?.("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (
    contentType &&
    !selection.contentTypes.some((allowed) => contentType === allowed.toLowerCase())
  ) {
    throw Object.assign(new Error(`unexpected content type ${contentType}`), {
      failureKind: "parsing",
    });
  }
  let bytes;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch (error) {
    throw Object.assign(new Error(`response body could not be parsed: ${error.message}`), {
      failureKind: "parsing",
    });
  }
  if (bytes.byteLength > selection.maxBytes) {
    throw Object.assign(new Error(`artifact exceeds ${selection.maxBytes} bytes`), {
      failureKind: "parsing",
    });
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw Object.assign(new Error(`response is not valid UTF-8: ${error.message}`), {
      failureKind: "parsing",
    });
  }
  if (selection.kind === "artifact") return text;
  const start = text.indexOf(selection.startMarker);
  if (start < 0) {
    throw Object.assign(new Error(`start marker for "${selection.name}" was not found`), {
      failureKind: "missing-section",
    });
  }
  const contentStart = start + selection.startMarker.length;
  const end = text.indexOf(selection.endMarker, contentStart);
  if (end < 0) {
    throw Object.assign(new Error(`end marker for "${selection.name}" was not found`), {
      failureKind: "missing-section",
    });
  }
  return text.slice(contentStart, end);
}

/**
 * Fetch one declared official document without following redirects. This
 * collector is advisory and read-only: its only output is an observation.
 */
export async function collectUpstreamDocumentationEvidenceV1(
  contract,
  {
    fetchImpl = globalThis.fetch,
    now = () => new Date().toISOString(),
  } = {},
) {
  validateUpstreamDocumentationContractV1(contract);
  if (typeof fetchImpl !== "function") fail("fetchImpl must be a function");
  const observedAt = now();
  const controller = new AbortController();
  let timedOut = false;
  let timeout;
  try {
    const fetchPromise = Promise.resolve().then(() =>
      fetchImpl(contract.requestedUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { accept: contract.selection.contentTypes.join(", ") },
      }));
    const timeoutPromise = new Promise((_, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(Object.assign(new Error(`timed out after ${contract.timeoutMs}ms`), {
          name: "AbortError",
        }));
      }, contract.timeoutMs);
    });
    const response = await Promise.race([fetchPromise, timeoutPromise]);
    if (
      (response.status >= 300 && response.status < 400) ||
      (response.url && response.url !== contract.requestedUrl)
    ) {
      return unavailable(
        contract,
        observedAt,
        "redirect-policy",
        "redirects are rejected; no redirect target was fetched",
      );
    }
    if (!response.ok) {
      return unavailable(
        contract,
        observedAt,
        "network",
        `request failed with HTTP ${response.status}`,
      );
    }
    let selectedText;
    try {
      selectedText = await readBoundedText(response, contract.selection);
    } catch (error) {
      return unavailable(
        contract,
        observedAt,
        FAILURE_KINDS.has(error.failureKind) ? error.failureKind : "parsing",
        error.message,
      );
    }
    if (selectedText.trim() === "") {
      return unavailable(
        contract,
        observedAt,
        "parsing",
        `declared ${contract.selection.kind} "${contract.selection.name}" was empty`,
      );
    }
    return Object.freeze({
      schemaVersion: UPSTREAM_DOCUMENTATION_REPORT_SCHEMA_VERSION,
      contractId: contract.id,
      evidenceKind: UPSTREAM_DOCUMENTATION_EVIDENCE_KIND,
      requestedUrl: contract.requestedUrl,
      selected: selectedDescriptor(contract.selection),
      digest: `sha256:${createHash("sha256").update(selectedText).digest("hex")}`,
      observedAt,
      status: "available",
      countsForCompatibility: true,
      failureKind: null,
      detail: "Declared upstream documentation artifact collected.",
      selectedText,
    });
  } catch (error) {
    const failureKind = classifyFetchError(error, timedOut);
    return unavailable(contract, observedAt, failureKind, error.message);
  } finally {
    clearTimeout(timeout);
  }
}

export async function collectUpstreamDocumentationContractsV1(
  contracts,
  options = {},
) {
  if (!Array.isArray(contracts)) fail("contracts must be an array");
  const ids = new Set();
  for (const contract of contracts) {
    validateUpstreamDocumentationContractV1(contract);
    if (ids.has(contract.id)) fail(`duplicate contract id ${contract.id}`);
    ids.add(contract.id);
  }
  return Promise.all(
    contracts.map((contract) =>
      collectUpstreamDocumentationEvidenceV1(contract, options)),
  );
}

/**
 * Remove fetched text while retaining the complete, serializable audit record.
 */
export function createUpstreamDocumentationReportV1(observations) {
  if (!Array.isArray(observations)) fail("observations must be an array");
  const records = observations.map((observation) => Object.freeze({
    contractId: observation.contractId,
    requestedUrl: observation.requestedUrl,
    selected: observation.selected,
    digest: observation.digest,
    observedAt: observation.observedAt,
    status: observation.status,
    evidenceKind: observation.evidenceKind,
    countsForCompatibility: observation.countsForCompatibility,
    failureKind: observation.failureKind,
    detail: observation.detail,
  }));
  return Object.freeze({
    schemaVersion: UPSTREAM_DOCUMENTATION_REPORT_SCHEMA_VERSION,
    evidenceKind: UPSTREAM_DOCUMENTATION_EVIDENCE_KIND,
    status: records.every(({ status }) => status === "available")
      ? "available"
      : "unavailable",
    records: Object.freeze(records),
  });
}

export function adaptUpstreamDocumentationObservationV1(observation, { checkId }) {
  validateString(checkId, "checkId");
  return Object.freeze({
    checkId,
    kind: UPSTREAM_DOCUMENTATION_EVIDENCE_KIND,
    outcome: observation.status === "available"
      ? "passed"
      : "infrastructure-failure",
    countsForCompatibility: observation.status === "available",
    source: observation.requestedUrl,
    summary: observation.detail,
    upstreamDocumentation: Object.freeze({
      requestedUrl: observation.requestedUrl,
      selected: observation.selected,
      digest: observation.digest,
      observedAt: observation.observedAt,
      status: observation.status,
      evidenceKind: observation.evidenceKind,
      failureKind: observation.failureKind,
    }),
  });
}
