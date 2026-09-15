import { lstat, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ExecutorLaunchJournalV1 } from "./executor-launch-journal.mjs";
import { ExecutionStoreV1, workUnitDefinitionV1 } from "./execution-store.mjs";
import { executorDigest, executorExact, ExecutorContractError } from "./executor-contract.mjs";
import { ensureCanonicalDirectory } from "./path-safety.mjs";
import { readPrivateExecutorJsonV1 } from "./executor-service-channel.mjs";
import { withExecutorJournalLock } from "./task-state.mjs";

const fail = (code) => { throw new ExecutorContractError(code); };
const equal = (a, b) => executorDigest(a) === executorDigest(b);

// One bounded notice per immutable job attempt. Config comes from the owning
// service's normalized operator policy, never from a notification request.
export class ExecutorCompletionOutboxV1 {
  #config; #directory; #journal; #units;
  constructor({ config, directory }) {
    this.#config = structuredClone(config);
    this.#directory = join(directory, "notifications");
    this.#journal = new ExecutorLaunchJournalV1({ directory: join(directory, "journal") });
    this.#units = new ExecutionStoreV1({ directory: join(directory, "units") });
  }
  async #expected() {
    const { wave, workUnits: [definition] } = this.#config.job;
    const operation = (await this.#journal.read(definition.workUnitId))?.operations.at(-1);
    if (!operation?.completion || operation.phase !== "terminal") return null;
    // Journal reads revalidate bounded result evidence, including its attempt.
    const unit = await this.#units.read(definition.workUnitId);
    if (!equal(operation.member, wave.members[0]) || operation.scopeDigest !== executorDigest(wave) ||
        !unit || !equal(workUnitDefinitionV1(unit), definition) || unit.binding.state !== "bound" ||
        unit.binding.memberThreadId !== operation.threadId || unit.binding.launchActionId !== operation.operationId) fail("notification-binding-mismatch");
    const notice = { schemaVersion: 1, kind: "worker-terminal", policyDigest: executorDigest(this.#config),
      parentThreadId: definition.queenThreadId, workUnitId: definition.workUnitId,
      specRevision: definition.specRevision, attempt: definition.attempt,
      operationId: operation.operationId, threadId: operation.threadId, turnId: operation.turnId,
      status: operation.completion.status, workOutcome: operation.completion.result.workOutcome,
      resultDigest: executorDigest(operation.completion) };
    return { notificationId: `completion:${executorDigest(notice)}`, ...notice };
  }
  async #write(record) {
    const path = join(this.#directory, "completion.json"), temporary = join(this.#directory, `.${randomUUID()}.tmp`);
    let file;
    try {
      file = await open(temporary, "wx", 0o600);
      await file.writeFile(JSON.stringify(record) + "\n"); await file.sync(); await file.close(); file = null;
      await rename(temporary, path);
      const directory = await open(this.#directory, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    } finally { await file?.close(); await unlink(temporary).catch(() => {}); }
  }
  async #access(acknowledgment = null) {
    await ensureCanonicalDirectory(this.#directory, "executor completion outbox", { mode: 0o700 });
    const info = await lstat(this.#directory);
    if ((info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) fail("insecure-service-directory");
    return withExecutorJournalLock(this.#directory, "completion", async () => {
      const notice = await this.#expected();
      const existing = await readPrivateExecutorJsonV1(join(this.#directory, "completion.json")).catch((error) => {
        if (error.code === "ENOENT") return null; throw error;
      });
      if (existing) {
        executorExact(existing, ["schemaVersion", "notification", "acknowledged"]);
        if (existing.schemaVersion !== 1 || typeof existing.acknowledged !== "boolean" ||
            !notice || !equal(existing.notification, notice)) fail("notification-evidence-mismatch");
      }
      if (acknowledgment && (!notice || acknowledgment.notificationId !== notice.notificationId ||
          acknowledgment.expectedAttempt !== notice.attempt)) fail("notification-acknowledgment-mismatch");
      if (!notice) return null;
      const record = { schemaVersion: 1, notification: notice, acknowledged: Boolean(acknowledgment || existing?.acknowledged) };
      // Re-publish even on replay: a previous directory-sync failure must not
      // turn a merely visible rename into an acknowledged durable write.
      await this.#write(record);
      return { ...notice, acknowledged: record.acknowledged };
    });
  }
  async project() { return this.#access(); }
  async list() { const notice = await this.#access(); return notice ? [notice] : []; }
  async acknowledge(params) {
    executorExact(params, ["notificationId", "expectedAttempt"]);
    if (typeof params.notificationId !== "string" || !/^completion:[a-f0-9]{64}$/u.test(params.notificationId) ||
        !Number.isSafeInteger(params.expectedAttempt) || params.expectedAttempt < 1 || params.expectedAttempt > 3) fail("invalid-notification-acknowledgment");
    return this.#access(params);
  }
}
