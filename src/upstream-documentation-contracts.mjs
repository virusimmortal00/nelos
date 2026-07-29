import { INTELLIGENCE_PROFILE_CATALOG } from "./intelligence-profile-catalog.mjs";
import {
  COMPATIBILITY_CONTRACT_REGISTRY_V1,
} from "./compatibility-contract-registry.mjs";
import {
  UPSTREAM_DOCUMENTATION_EVIDENCE_KIND,
  validateUpstreamDocumentationContractV1,
} from "./upstream-documentation-evidence.mjs";

function artifactContract(id, requestedUrl, name) {
  const contract = Object.freeze({
    schemaVersion: 1,
    id,
    evidenceKind: UPSTREAM_DOCUMENTATION_EVIDENCE_KIND,
    official: true,
    requestedUrl,
    selection: Object.freeze({
      kind: "artifact",
      name,
      maxBytes: 1_000_000,
      contentTypes: Object.freeze([
        "text/html",
        "text/markdown",
        "text/plain",
      ]),
    }),
    timeoutMs: 10_000,
    redirectPolicy: "reject",
  });
  validateUpstreamDocumentationContractV1(contract);
  return contract;
}

const appServerDocumentationCheck =
  COMPATIBILITY_CONTRACT_REGISTRY_V1.checks.find(
    ({ id }) => id === "upstream.app-server-docs",
  );

if (
  !appServerDocumentationCheck ||
  appServerDocumentationCheck.evidenceKind !== UPSTREAM_DOCUMENTATION_EVIDENCE_KIND
) {
  throw new Error("upstream.app-server-docs is absent from the compatibility registry");
}

export const APP_SERVER_DOCUMENTATION_CONTRACT_V1 = artifactContract(
  appServerDocumentationCheck.id,
  appServerDocumentationCheck.source,
  "current-app-server-documentation",
);

export const MODEL_CATALOG_DOCUMENTATION_CONTRACTS_V1 = Object.freeze([
  artifactContract(
    "model-catalog.models-guidance",
    INTELLIGENCE_PROFILE_CATALOG.sourceUrl,
    "current-model-guidance",
  ),
  artifactContract(
    "model-catalog.subagents-guidance",
    "https://developers.openai.com/codex/subagents",
    "current-subagent-guidance",
  ),
]);
