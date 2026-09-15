import { ExecutorContractError, executorDigest, executorExact, executorText } from "./executor-contract.mjs";
import { classifyWorkResult, formatResultEnvelope } from "./work-result.mjs";

const fail = (code) => { throw new ExecutorContractError(code); };
const FIELDS = ["transportStatus", "workOutcome", "resultState", "attentionRequired",
  "attentionReason", "result", "fallbackSummary", "resultError"];
const MALFORMED_CODES = new Set(["unterminated_envelope", "nonterminal_envelope",
  "envelope_too_large", "invalid_json", "invalid_schema"]);

/** Validate the bounded classification again at the durable service boundary.
 * A provider's truthy result or claimed success is not validated evidence.
 * Only the final classification is retained; no upstream transcript is stored.
 */
export function normalizeExecutorResultEvidenceV1(value, { member, threadId, turnId }) {
  executorExact(value, ["threadId", "turnId", "status", "terminal", "result"]);
  if (value.threadId !== threadId || value.turnId !== turnId ||
      !["inProgress", "completed", "interrupted", "failed"].includes(value.status) ||
      value.terminal !== (value.status !== "inProgress")) fail("invalid-owned-result");
  executorExact(value.result, FIELDS);
  const result = value.result;
  let text = null;
  if (result.result !== null) {
    if (result.result.workUnitId !== member.workUnitId || result.result.specRevision !== member.specRevision ||
        result.result.attempt !== member.attempt) fail("result-scope-mismatch");
    try { text = formatResultEnvelope(result.result); }
    catch { fail("invalid-owned-result"); }
  } else if (result.fallbackSummary !== null) {
    executorText(result.fallbackSummary, 1000);
    text = result.fallbackSummary;
  }
  let normalized = classifyWorkResult({ latestTurn: { status: value.status,
    items: text === null ? [] : [{ type: "agentMessage", phase: "final_answer", text }] } });
  if (result.resultState === "malformed" && value.status === "completed") {
    if (result.result !== null || result.fallbackSummary !== null) fail("invalid-owned-result");
    executorExact(result.resultError, ["code", "message"]);
    if (!MALFORMED_CODES.has(result.resultError.code)) fail("invalid-owned-result");
    executorText(result.resultError.message, 300);
    normalized = { ...normalized, resultState: "malformed", attentionReason: "malformed_result",
      resultError: { code: result.resultError.code, message: result.resultError.message } };
  }
  // Fixed-key projection avoids treating object key order as evidence identity.
  const projected = Object.fromEntries(FIELDS.map((key) => [key, result[key]]));
  if (result.result !== null && normalized.result !== null) projected.result = normalized.result;
  if (result.resultError !== null && normalized.resultError !== null) projected.resultError = normalized.resultError;
  if (executorDigest(projected) !== executorDigest(normalized)) fail("invalid-owned-result");
  return { threadId, turnId, status: value.status, terminal: value.terminal, result: normalized };
}
