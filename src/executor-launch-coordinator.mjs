import { ExecutorGrantAuthorityV1, gateExecutorWaveV1 } from "./executor-grants.mjs";
import { ExecutorLaunchJournalV1 } from "./executor-launch-journal.mjs";
import { ExecutionStoreV1, createWorkUnitSpecV1, workUnitDefinitionV1 } from "./execution-store.mjs";
import { ExecutorContractError, executorDigest, executorExact, executorInteger, executorText, normalizeExecutorWaveV1 } from "./executor-contract.mjs";
import { withExecutionOrchestrationLock } from "./task-state.mjs";
import { commitRuntimeMutationV1 } from "./runtime-mutation-fence.mjs";

const fail = (code) => { throw new ExecutorContractError(code); };
const summary = (op, reason = null) => ({ workUnitId: op.member.workUnitId, operationId: op.operationId,
  phase: op.phase, threadId: op.threadId, turnId: op.turnId, reason });

/** Effect ordering for an owned executor. Providers are service-installed;
 * this class neither starts a service nor exposes an MCP mutation endpoint.
 */
export class ExecutorLaunchCoordinatorV1 {
  #authority;
  #journal;
  #store;
  #effects;
  #withLock;
  #timeoutMs;
  #pendingEffects = 0;

  constructor({ authority, journal, store, effects, withLock = withExecutionOrchestrationLock, timeoutMs = 10_000 }) {
    if (!(authority instanceof ExecutorGrantAuthorityV1) || !(journal instanceof ExecutorLaunchJournalV1) ||
        !(store instanceof ExecutionStoreV1) || typeof withLock !== "function" ||
        !["createThread", "setTitle", "startTurn"].every((name) => typeof effects?.[name] === "function")) {
      fail("invalid-executor-dependencies");
    }
    executorInteger(timeoutMs);
    if (timeoutMs > 30_000) fail("invalid-limits");
    this.#authority = authority; this.#journal = journal; this.#store = store;
    this.#effects = effects; this.#withLock = withLock; this.#timeoutMs = timeoutMs;
  }

  async #effect(name, input) {
    if (this.#pendingEffects >= 16) fail("executor-busy");
    this.#pendingEffects += 1;
    const controller = new AbortController();
    let timer;
    const pending = Promise.resolve().then(() => commitRuntimeMutationV1(() => {
      if (controller.signal.aborted) fail("effect-timeout");
      return this.#effects[name](structuredClone(input), { signal: controller.signal });
    })).finally(() => { this.#pendingEffects -= 1; });
    try {
      return await Promise.race([pending, new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new ExecutorContractError("effect-timeout")); }, this.#timeoutMs);
      })]);
    } finally {
      clearTimeout(timer); controller.abort();
    }
  }

  async #admit(wave, executionGrantId) {
    const admission = await gateExecutorWaveV1({ authority: this.#authority, wave, executionGrantId });
    if (admission.kind !== "execution-admitted") fail(admission.reason);
    return admission;
  }

  #transition(record, event) {
    return this.#journal.transition({ workUnitId: record.workUnitId,
      operationId: record.operations.at(-1).operationId, expectedRevision: record.revision, event });
  }

  async #bind(op) {
    const current = await this.#store.read(op.member.workUnitId);
    if (current?.binding.state === "unbound") {
      await this.#store.markLaunchPending({ workUnitId: op.member.workUnitId, specRevision: op.member.specRevision,
        launchActionId: op.operationId });
    }
    return this.#store.bind({ workUnitId: op.member.workUnitId, specRevision: op.member.specRevision,
      launchActionId: op.operationId, memberThreadId: op.threadId });
  }

  async #release(record) {
    const op = record.operations.at(-1);
    const proof = await this.#journal.proveNotExecuted({ workUnitId: record.workUnitId, operationId: op.operationId });
    await this.#store.releaseUndispatchedLaunch(proof);
  }

  async launchWave(input) {
    executorExact(input, ["wave", "executionGrantId", "workUnits", "prompts"]);
    const wave = normalizeExecutorWaveV1(input.wave);
    if (!Array.isArray(input.workUnits) || input.workUnits.length !== wave.members.length ||
        !Array.isArray(input.prompts) || input.prompts.length !== wave.members.length) fail("invalid-wave-inputs");
    const workUnits = input.workUnits.map(createWorkUnitSpecV1);
    const prompts = new Map();
    for (const entry of input.prompts) {
      executorExact(entry, ["sliceId", "text"]);
      if (prompts.has(entry.sliceId) || typeof entry.text !== "string" || !entry.text.trim() ||
          Buffer.byteLength(entry.text) > 32 * 1024) fail("invalid-wave-prompt");
      prompts.set(entry.sliceId, entry.text);
    }
    if (new Set(workUnits.map((unit) => unit.workUnitId)).size !== workUnits.length) fail("duplicate-work-unit");
    for (const member of wave.members) {
      const unit = workUnits.find((unit) => unit.workUnitId === member.workUnitId);
      if (!unit || unit.memberKind !== "spinoff" || unit.specRevision !== member.specRevision ||
          unit.attempt !== member.attempt || unit.title !== member.title ||
          !prompts.has(member.sliceId) || executorDigest(prompts.get(member.sliceId)) !== member.promptDigest ||
          (unit.launch && (unit.launch.nativeTask.model !== member.model ||
            unit.launch.nativeTask.thinking !== member.reasoningEffort || unit.launch.workspaceMode !== member.workspaceMode))) {
        fail("work-unit-scope-mismatch");
      }
      const current = await this.#store.read(member.workUnitId);
      if (current && executorDigest(workUnitDefinitionV1(current)) !== executorDigest(workUnitDefinitionV1(unit))) fail("work-unit-definition-conflict");
      const prior = (await this.#journal.read(member.workUnitId))?.operations.at(-1);
      if (prior) {
        const freshSequence = prior.phase === "not-executed" && member.launchSequence === prior.member.launchSequence + 1;
        const sameOperation = prior.scopeDigest === executorDigest(wave) &&
          prior.member.launchSequence === member.launchSequence && prior.executionGrantId === input.executionGrantId;
        if (!freshSequence && (!sameOperation || !["prepared", "running"].includes(prior.phase))) {
          return { schemaVersion: 1, kind: "reconciliation-required", reason: "existing-operation", members: [summary(prior)] };
        }
      }
      if (current && current.binding.state !== "unbound") {
        if (!prior || prior.operationId !== current.binding.launchActionId ||
            (current.binding.state === "bound" && prior.threadId !== current.binding.memberThreadId)) {
          return { schemaVersion: 1, kind: "reconciliation-required", reason: "foreign-or-legacy-binding", members: [] };
        }
      }
    }
    const admitted = await gateExecutorWaveV1({ authority: this.#authority, wave, executionGrantId: input.executionGrantId });
    if (admitted.kind !== "execution-admitted") return { ...admitted, members: [] };
    const results = [];
    for (const member of wave.members) {
      const unit = workUnits.find((unit) => unit.workUnitId === member.workUnitId);
      let result;
      try {
        result = await this.#withLock(member.workUnitId, () => this.#launchMember({ wave,
          executionGrantId: input.executionGrantId, member, unit, prompt: prompts.get(member.sliceId) }));
      } catch (error) {
        result = { workUnitId: member.workUnitId, phase: "attention", reason:
          error instanceof ExecutorContractError ? error.code : "executor-state-unavailable" };
      }
      results.push(result);
      if (result.phase !== "running") return { schemaVersion: 1, kind: "reconciliation-required", members: results };
    }
    return { schemaVersion: 1, kind: "wave-started", members: results };
  }

  async #launchMember({ wave, executionGrantId, member, unit, prompt }) {
    const admission = await this.#admit(wave, executionGrantId);
    const current = await this.#store.read(member.workUnitId);
    if (current && executorDigest(workUnitDefinitionV1(current)) !== executorDigest(workUnitDefinitionV1(unit))) fail("work-unit-definition-conflict");
    if (!current) await this.#store.create(unit);
    let record = await this.#journal.prepare({ wave, sliceId: member.sliceId, executionGrantId, context: admission.context, prompt });
    let op = record.operations.at(-1);
    const operationId = op.operationId;
    // Repeated launch calls only report the existing operation. A separate
    // recovery call may repair local binding but never repeats an upstream call.
    if (op.phase !== "prepared") return summary(op, "existing-operation");
    try {
      await this.#store.markLaunchPending({ workUnitId: member.workUnitId, specRevision: member.specRevision, launchActionId: op.operationId });
      await this.#admit(wave, executionGrantId);
      record = await this.#transition(record, { type: "create-dispatched" });
      await this.#admit(wave, executionGrantId);
      const created = await this.#effect("createThread", { member, operationId: op.operationId });
      // Keep the identity even if effective route/policy or subsequent title
      // verification is wrong. A created task must never disappear into retry.
      executorText(created?.threadId, 256);
      record = await this.#transition(record, { type: "thread-bound", threadId: created.threadId });
      op = record.operations.at(-1);
      await this.#bind(op);
      if (created.model !== member.model || created.cwd !== member.target.cwd ||
          created.permissionProfile !== member.permissionProfile || created.approvalPolicy !== member.approvalPolicy) {
        fail("effective-execution-contract-mismatch");
      }
      await this.#admit(wave, executionGrantId);
      const titled = await this.#effect("setTitle", { threadId: op.threadId, title: member.title });
      if (titled?.observedTitle !== member.title) fail("title-verification-failed");
      await this.#admit(wave, executionGrantId);
      record = await this.#transition(record, { type: "turn-dispatched" });
      await this.#admit(wave, executionGrantId);
      const started = await this.#effect("startTurn", { member, threadId: op.threadId, prompt,
        clientUserMessageId: `nelos:${op.operationId}` });
      executorText(started?.turnId, 256);
      record = await this.#transition(record, { type: "running", turnId: started.turnId });
      return summary(record.operations.at(-1));
    } catch (error) {
      // Reload first: rename may have committed even when directory sync failed.
      record = await this.#journal.read(member.workUnitId);
      op = record?.operations.at(-1);
      if (!op || op.operationId !== operationId) fail("journal-reconciliation-required");
      if (op.phase === "prepared") {
        record = await this.#transition(record, { type: "not-executed" });
        await this.#release(record);
      } else if (["create-dispatched", "turn-dispatched"].includes(op.phase)) {
        record = await this.#transition(record, { type: "outcome-unknown" });
      }
      return summary(record.operations.at(-1), error instanceof ExecutorContractError ? error.code : "executor-effect-failed");
    }
  }

  async recover(workUnitId) {
    return this.#withLock(workUnitId, async () => {
      let record = await this.#journal.read(workUnitId);
      if (!record) return { workUnitId, phase: "attention", reason: "no-owned-launch-evidence" };
      let op = record.operations.at(-1);
      const unit = await this.#store.read(workUnitId);
      if (!unit || unit.specRevision !== op.member.specRevision || unit.attempt !== op.member.attempt) fail("work-unit-scope-mismatch");
      if (op.phase === "prepared") record = await this.#transition(record, { type: "not-executed" });
      else if (["create-dispatched", "turn-dispatched"].includes(op.phase)) record = await this.#transition(record, { type: "outcome-unknown" });
      op = record.operations.at(-1);
      if (op.phase === "not-executed") await this.#release(record);
      else if (op.threadId) await this.#bind(op);
      return summary(op, op.phase === "not-executed" ? "fresh-grant-and-sequence-required" : "upstream-observation-required");
    });
  }

  async collectResult(workUnitId) {
    if (typeof this.#effects.readResult !== "function") fail("result-reader-unavailable");
    return this.#withLock(workUnitId, async () => {
      let record = await this.#journal.read(workUnitId);
      const op = record?.operations.at(-1);
      if (!op || !["running", "terminal"].includes(op.phase)) fail("result-reconciliation-required");
      const matchingBinding = async () => {
        const unit = await this.#store.read(workUnitId);
        if (!unit || unit.specRevision !== op.member.specRevision || unit.attempt !== op.member.attempt ||
            unit.binding.state !== "bound" || unit.binding.memberThreadId !== op.threadId ||
            unit.binding.launchActionId !== op.operationId) fail("result-binding-mismatch");
      };
      await matchingBinding();
      const observed = await this.#effect("readResult", { threadId: op.threadId, turnId: op.turnId });
      executorExact(observed, ["threadId", "turnId", "status", "terminal", "result"]);
      if (observed.threadId !== op.threadId || observed.turnId !== op.turnId ||
          !["inProgress", "completed", "interrupted", "failed"].includes(observed.status) ||
          observed.terminal !== (observed.status !== "inProgress") || !observed.result) fail("invalid-owned-result");
      const envelope = observed.result.result;
      if (envelope && (envelope.workUnitId !== workUnitId || envelope.specRevision !== op.member.specRevision ||
          envelope.attempt !== op.member.attempt)) fail("result-scope-mismatch");
      await matchingBinding();
      if (op.phase === "terminal" && observed.status !== op.terminalStatus) fail("terminal-result-conflict");
      if (observed.terminal && op.phase !== "terminal") {
        record = await this.#transition(record, { type: "terminal", status: observed.status });
      }
      // The durable terminal transition is transport evidence only. Queen
      // acceptance still evaluates the validated result and its artifacts.
      return { ...summary(record.operations.at(-1)), source: "owned-app-server",
        status: observed.status, result: observed.result };
    });
  }
}
