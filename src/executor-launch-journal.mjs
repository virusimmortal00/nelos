import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ensureCanonicalDirectory } from "./path-safety.mjs";
import { withExecutorJournalLock } from "./task-state.mjs";
import { commitRuntimeMutationV1 } from "./runtime-mutation-fence.mjs";
import {
  ExecutorContractError, executorExact, executorText, executorInteger, executorHash, executorDigest,
  normalizeExecutorMemberV1, normalizeExecutorWaveV1, normalizeExecutorContextV1,
} from "./executor-contract.mjs";

const MAX_BYTES = 512 * 1024;
const MAX_OPERATIONS = 32;
const PHASES = ["prepared", "create-dispatched", "thread-bound", "turn-dispatched", "running", "terminal", "not-executed", "outcome-unknown"];
const proofs = new WeakMap();
const fail = (code) => { throw new ExecutorContractError(code); };
const unitId = (value) => {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value)) fail("invalid-work-unit-id");
  return value;
};
const operationId = (value) => {
  if (typeof value !== "string" || !/^launch:[a-f0-9-]{36}$/u.test(value)) fail("invalid-operation-id");
  return value;
};

export function readExecutorNonDispatchProofV1(proof) {
  const record = proofs.get(proof);
  if (!record) fail("invalid-non-dispatch-proof");
  return structuredClone(record);
}

function operation(value) {
  executorExact(value, ["operationId", "scopeDigest", "planRunId", "waveIndex", "waveDigest", "member",
    "executionGrantId", "context", "prompt", "phase", "uncertainStage", "threadId", "turnId", "terminalStatus"]);
  operationId(value.operationId);
  const member = normalizeExecutorMemberV1(value.member);
  const context = normalizeExecutorContextV1(value.context);
  executorHash(value.scopeDigest); executorHash(value.waveDigest); executorInteger(value.waveIndex);
  if (!/^run:[a-f0-9]{40}$/u.test(value.planRunId ?? "") ||
      !/^grant:[a-f0-9-]{36}$/u.test(value.executionGrantId ?? "") ||
      typeof value.prompt !== "string" || !value.prompt.trim() || Buffer.byteLength(value.prompt) > 32 * 1024 ||
      executorDigest(value.prompt) !== member.promptDigest || context.scopeDigest !== value.scopeDigest ||
      !PHASES.includes(value.phase)) fail("invalid-journal-record");
  if (value.threadId !== null) executorText(value.threadId, 256);
  if (value.turnId !== null) executorText(value.turnId, 256);
  const beforeThread = ["prepared", "create-dispatched", "not-executed"].includes(value.phase) ||
    (value.phase === "outcome-unknown" && value.uncertainStage === "create");
  const hasTurn = ["running", "terminal"].includes(value.phase);
  if ((beforeThread ? value.threadId !== null : value.threadId === null) ||
      (hasTurn ? value.turnId === null : value.turnId !== null) ||
      (value.phase === "outcome-unknown" ? !["create", "turn"].includes(value.uncertainStage) : value.uncertainStage !== null) ||
      (value.phase === "terminal" ? !["completed", "interrupted", "failed"].includes(value.terminalStatus) : value.terminalStatus !== null)) {
    fail("invalid-journal-record");
  }
  return { ...value, member, context };
}

export function validateExecutorJournalV1(value) {
  executorExact(value, ["schemaVersion", "workUnitId", "revision", "operations"]);
  if (value.schemaVersion !== 1) fail("unsupported-journal-version");
  unitId(value.workUnitId); executorInteger(value.revision);
  if (!Array.isArray(value.operations) || !value.operations.length || value.operations.length > MAX_OPERATIONS) fail("invalid-journal-record");
  const operations = Array.from(value.operations, operation);
  const ids = new Set();
  operations.forEach((op, index) => {
    if (op.member.workUnitId !== value.workUnitId || op.member.launchSequence !== index + 1 ||
        (index < operations.length - 1 && op.phase !== "not-executed") || ids.has(op.operationId)) fail("invalid-journal-record");
    ids.add(op.operationId);
  });
  return { ...value, operations };
}

/** Private write-ahead journal. Dispatch intent must be durably acknowledged
 * before invoking App Server. All post-dispatch failures remain uncertain.
 */
export class ExecutorLaunchJournalV1 {
  #directory;
  constructor({ directory } = {}) {
    if (typeof directory !== "string" || !isAbsolute(directory)) fail("invalid-journal-directory");
    this.#directory = directory;
  }

  async #directoryReady() {
    await ensureCanonicalDirectory(this.#directory, "executor journal", { mode: 0o700 });
    const info = await fs.stat(this.#directory);
    if ((info.mode & 0o077) !== 0 || (process.getuid && info.uid !== process.getuid())) fail("insecure-journal-directory");
  }

  #path(workUnitId) { return join(this.#directory, `${executorDigest(unitId(workUnitId))}.json`); }

  async #load(workUnitId) {
    let handle;
    try {
      handle = await fs.open(this.#path(workUnitId), constants.O_RDONLY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isFile() || info.size > MAX_BYTES || (info.mode & 0o077) !== 0 ||
          (process.getuid && info.uid !== process.getuid())) fail("invalid-journal-file");
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > MAX_BYTES) fail("journal-size-limit");
      const record = validateExecutorJournalV1(JSON.parse(buffer.subarray(0, length).toString("utf8")));
      if (record.workUnitId !== workUnitId) fail("journal-identity-mismatch");
      return record;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error instanceof ExecutorContractError) throw error;
      fail("journal-unreadable");
    } finally {
      await handle?.close();
    }
  }

  async #write(record) {
    const normalized = validateExecutorJournalV1(record);
    const source = `${JSON.stringify(normalized)}\n`;
    if (Buffer.byteLength(source) > MAX_BYTES) fail("journal-size-limit");
    const target = this.#path(record.workUnitId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    let handle;
    try {
      handle = await fs.open(temporary, "wx", 0o600);
      await handle.writeFile(source);
      await handle.sync();
      await handle.close(); handle = null;
      await commitRuntimeMutationV1(async () => {
        await fs.rename(temporary, target);
        const directory = await fs.open(this.#directory, constants.O_RDONLY);
        try { await directory.sync(); } finally { await directory.close(); }
      });
    } finally {
      await handle?.close();
      await fs.rm(temporary, { force: true });
    }
    return structuredClone(normalized);
  }

  async #mutate(workUnitId, callback) {
    unitId(workUnitId);
    await this.#directoryReady();
    return withExecutorJournalLock(this.#directory, workUnitId, async () => callback(await this.#load(workUnitId)));
  }

  async read(workUnitId) {
    unitId(workUnitId);
    await this.#directoryReady();
    return this.#load(workUnitId);
  }

  async prepare({ wave, sliceId, executionGrantId, context, prompt }) {
    const scope = normalizeExecutorWaveV1(wave);
    const member = scope.members.find((item) => item.sliceId === sliceId);
    if (!member) fail("unknown-wave-member");
    const proposed = operation({
      operationId: `launch:${randomUUID()}`, scopeDigest: executorDigest(scope),
      planRunId: scope.planRunId, waveIndex: scope.waveIndex, waveDigest: scope.waveDigest,
      member, executionGrantId, context, prompt, phase: "prepared", uncertainStage: null,
      threadId: null, turnId: null, terminalStatus: null,
    });
    return this.#mutate(member.workUnitId, async (current) => {
      const prior = current?.operations.find((op) => op.member.launchSequence === member.launchSequence);
      if (prior) {
        if (prior.scopeDigest === proposed.scopeDigest && executorDigest(prior.member) === executorDigest(member) &&
            prior.prompt === prompt && prior.executionGrantId === executionGrantId) return current;
        fail("launch-sequence-conflict");
      }
      if ((current?.operations.length ?? 0) >= MAX_OPERATIONS) fail("journal-operation-limit");
      if (member.launchSequence !== (current?.operations.length ?? 0) + 1) fail("launch-sequence-conflict");
      if (current && current.operations.at(-1).phase !== "not-executed") fail("launch-reconciliation-required");
      return this.#write({ schemaVersion: 1, workUnitId: member.workUnitId,
        revision: (current?.revision ?? 0) + 1, operations: [...(current?.operations ?? []), proposed] });
    });
  }

  async transition({ workUnitId, operationId: id, expectedRevision, event }) {
    operationId(id); executorInteger(expectedRevision);
    return this.#mutate(workUnitId, async (current) => {
      if (!current || current.revision !== expectedRevision) fail("journal-revision-conflict");
      const op = current.operations.at(-1);
      if (op.operationId !== id) fail("stale-launch-operation");
      const next = structuredClone(op);
      switch (event?.type) {
        case "create-dispatched":
          executorExact(event, ["type"]);
          if (op.phase !== "prepared") fail("invalid-launch-transition");
          next.phase = "create-dispatched"; break;
        case "thread-bound":
          executorExact(event, ["type", "threadId"]);
          if (!(op.phase === "create-dispatched" || (op.phase === "outcome-unknown" && op.uncertainStage === "create"))) fail("invalid-launch-transition");
          next.phase = "thread-bound"; next.threadId = executorText(event.threadId, 256); next.uncertainStage = null; break;
        case "turn-dispatched":
          executorExact(event, ["type"]);
          if (op.phase !== "thread-bound") fail("invalid-launch-transition");
          next.phase = "turn-dispatched"; break;
        case "running":
          executorExact(event, ["type", "turnId"]);
          if (!(op.phase === "turn-dispatched" || (op.phase === "outcome-unknown" && op.uncertainStage === "turn"))) fail("invalid-launch-transition");
          next.phase = "running"; next.turnId = executorText(event.turnId, 256); next.uncertainStage = null; break;
        case "terminal":
          executorExact(event, ["type", "status"]);
          if (op.phase !== "running" || !["completed", "interrupted", "failed"].includes(event.status)) fail("invalid-launch-transition");
          next.phase = "terminal"; next.terminalStatus = event.status; break;
        case "not-executed":
          executorExact(event, ["type"]);
          if (op.phase !== "prepared") fail("non-dispatch-not-proven");
          next.phase = "not-executed"; break;
        case "outcome-unknown":
          executorExact(event, ["type"]);
          if (!["create-dispatched", "turn-dispatched"].includes(op.phase)) fail("invalid-launch-transition");
          next.phase = "outcome-unknown"; next.uncertainStage = op.phase === "create-dispatched" ? "create" : "turn"; break;
        default: fail("invalid-launch-event");
      }
      return this.#write({ ...current, revision: current.revision + 1,
        operations: [...current.operations.slice(0, -1), next] });
    });
  }

  async proveNotExecuted({ workUnitId, operationId: id }) {
    operationId(id);
    const record = await this.read(workUnitId);
    const op = record?.operations.find((item) => item.operationId === id);
    if (op?.phase !== "not-executed") fail("non-dispatch-not-proven");
    const proof = Object.freeze({});
    proofs.set(proof, { workUnitId, specRevision: op.member.specRevision, attempt: op.member.attempt, launchActionId: id });
    return proof;
  }
}
