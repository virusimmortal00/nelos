import { lstat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { ExecutorJobServiceV1, normalizeExecutorJobV1 } from "./executor-job-service.mjs";
import { ExecutorContractError, executorDigest, executorExact } from "./executor-contract.mjs";
import { createWorkUnitSpecV1 } from "./execution-store.mjs";
import { deriveWebReadinessV1 } from "./queen-acceptance.mjs";
import { ensureCanonicalDirectory } from "./path-safety.mjs";
import { readPrivateExecutorJsonV1 } from "./executor-service-channel.mjs";
import { withExecutorJournalLock } from "./task-state.mjs";

const fail = (code) => { throw new ExecutorContractError(code); };
const overlaps = (a, b) => { const r = relative(a, b); return !r || (r !== ".." && !r.startsWith("../")); };

export function normalizeExecutorPlanPolicyV1(value) {
  executorExact(value, ["schemaVersion", "jobs"]);
  if (value.schemaVersion !== 4 || !Array.isArray(value.jobs) || !value.jobs.length || value.jobs.length > 16) fail("invalid-executor-plan");
  const jobs = value.jobs.map((entry) => {
    executorExact(entry, ["config", "dependsOn"]);
    if (!Array.isArray(entry.dependsOn) || new Set(entry.dependsOn).size !== entry.dependsOn.length) fail("invalid-executor-dependencies");
    return { config: normalizeExecutorJobV1(entry.config), dependsOn: [...entry.dependsOn].sort() };
  });
  const first = jobs[0].config;
  for (const { config } of jobs) {
    if (["command", "codexHome", "hostId"].some((key) => config[key] !== first[key]) || config.job.wave.planRunId !== first.job.wave.planRunId) fail("executor-plan-host-mismatch");
  }
  deriveWebReadinessV1({ workUnits: jobs.map(({ config, dependsOn }) => createWorkUnitSpecV1({ ...config.job.workUnits[0], dependencies: dependsOn })) });
  for (let a = 0; a < jobs.length; a++) for (let b = a + 1; b < jobs.length; b++) {
    const left = jobs[a].config, right = jobs[b].config;
    const lp = left.job.wave.members[0].target.cwd, rp = right.job.wave.members[0].target.cwd;
    if ((left.workspace || right.workspace) && (overlaps(lp, rp) || overlaps(rp, lp))) fail("overlapping-executor-workspaces");
    if (left.workspace && right.workspace && left.job.wave.members[0].target.repositoryId === right.job.wave.members[0].target.repositoryId &&
        left.workspace.branch === right.workspace.branch) fail("duplicate-executor-branch");
  }
  return { schemaVersion: 4, jobs };
}

// Installed complete plan; parent requests select only its existing identities.
// Each job keeps its original private journal, acceptance and outbox boundary.
export class ExecutorPlanServiceV1 {
  #config; #directory; #options; #jobs = new Map(); #clients = new Set(); #queue = Promise.resolve();
  #starting; #owner; #done; #finish; #state = "new"; #draining = false;
  constructor({ config, directory, ...options }) {
    this.#config = normalizeExecutorPlanPolicyV1(config); this.#directory = directory; this.#options = options;
    this.#done = new Promise((resolve) => { this.#finish = resolve; });
  }
  start() {
    if (this.#starting) return this.#starting;
    let ready, reject;
    this.#state = "starting";
    this.#starting = new Promise((resolve, rejected) => { ready = resolve; reject = rejected; });
    this.#owner = (async () => {
      try {
        await ensureCanonicalDirectory(this.#directory, "executor plan state", { mode: 0o700 });
        const info = await lstat(this.#directory);
        if ((info.mode & 0o077) || (process.getuid && info.uid !== process.getuid())) fail("insecure-service-directory");
        await withExecutorJournalLock(join(this.#directory, "owner-locks"), "plan", async () => {
          const binding = { schemaVersion: 1, policyDigest: executorDigest(this.#config) }, path = join(this.#directory, "plan-binding.json");
          try { await writeFile(path, JSON.stringify(binding), { mode: 0o600, flag: "wx" }); } catch (error) { if (error.code !== "EEXIST") throw error; }
          if (executorDigest(await readPrivateExecutorJsonV1(path)) !== executorDigest(binding)) fail("service-job-policy-mismatch");
          for (const entry of this.#config.jobs) {
            const id = entry.config.job.workUnits[0].workUnitId;
            const service = new ExecutorJobServiceV1({ ...this.#options, config: entry.config, directory: join(this.#directory, executorDigest(id).slice(0, 16)) });
            const record = { ...entry, service, client: null, error: null }; this.#jobs.set(id, record);
            try { await service.start(); record.client = service.attach(); }
            catch (error) { record.error = error.code ?? "job-start-unavailable"; }
          }
          this.#state = this.#draining ? "draining" : "ready"; ready(this.status()); await this.#done;
        });
      } catch (error) { this.#state = "failed"; reject(error); this.#finish(); }
      return this.status();
    })();
    return this.#starting;
  }
  get stopped() { return this.#owner ?? Promise.reject(new ExecutorContractError("supervisor-not-started")); }
  status() { return { state: this.#state, plan: true, planRunId: this.#config.jobs[0].config.job.wave.planRunId, workUnitIds: [...this.#jobs.keys()],
    activities: [...this.#jobs.values()].reduce((n, { service }) => n + (service.status().activities ?? 0), 0),
    jobs: [...this.#jobs].map(([workUnitId, { service, error }]) => ({ workUnitId, ...service.status(), error })),
    completionDelivery: { mode: "durable-inbox", detachedWakeAvailable: false }, runtimeCertified: false }; }
  attach() { if (this.#draining || this.#state !== "ready") fail("supervisor-not-accepting"); const client = Object.freeze({}); this.#clients.add(client); return client; }
  detach(client) { this.#clients.delete(client); }
  attachApprovalChannel(channel) {
    const detach = [...this.#jobs.values()].filter(({ error }) => !error).map(({ service }) => service.attachApprovalChannel(channel));
    return () => detach.forEach((close) => close());
  }
  async #view() {
    const snapshots = await Promise.all([...this.#jobs].map(async ([workUnitId, entry]) => {
      const fallback = () => ({ unit: createWorkUnitSpecV1(entry.config.job.workUnits[0]), decisions: [], operation: null });
      let snapshot;
      try { snapshot = entry.error ? fallback() : await entry.service.snapshot(); }
      catch (error) { entry.error = error.code ?? "job-state-unavailable"; snapshot = fallback(); }
      return { workUnitId, entry, snapshot };
    }));
    const readiness = deriveWebReadinessV1({ workUnits: snapshots.map(({ entry, snapshot }) => ({ ...snapshot.unit, dependencies: entry.dependsOn })),
      decisions: snapshots.flatMap(({ snapshot }) => snapshot.decisions) });
    const unavailable = new Set(snapshots.filter(({ entry }) => entry.error).map(({ workUnitId }) => workUnitId));
    readiness.readyWorkUnitIds = readiness.readyWorkUnitIds.filter((id) => !unavailable.has(id));
    readiness.entries = readiness.entries.map((entry) => unavailable.has(entry.workUnitId) ? { ...entry, ready: false, reason: "executor-state-unavailable" } : entry);
    return { snapshots, readiness };
  }
  request(client, method, params) {
    const next = this.#queue.catch(() => {}).then(async () => {
      if (!this.#clients.has(client)) fail("unknown-service-client");
      if (method === "status") { executorExact(params, []); const { readiness } = await this.#view(); return { ...this.status(), readiness }; }
      if (method === "launch") {
        executorExact(params, []); if (this.#draining) fail("supervisor-not-accepting");
        const { readiness, snapshots } = await this.#view();
        if (snapshots.some(({ entry, snapshot }) => entry.error || !entry.service.status().acceptingLaunches ||
            (snapshot.operation && !["running", "terminal"].includes(snapshot.operation.phase)))) return { kind: "reconciliation-required", readiness, jobs: this.status().jobs };
        const accepted = new Set(readiness.entries.filter(({ accepted }) => accepted).map(({ workUnitId }) => workUnitId));
        const earliest = Math.min(...snapshots.filter(({ workUnitId }) => !accepted.has(workUnitId)).map(({ entry }) => entry.config.job.wave.waveIndex));
        const selected = readiness.readyWorkUnitIds.filter((id) => this.#jobs.get(id).config.job.wave.waveIndex === earliest).map((id) => [id, this.#jobs.get(id)]);
        const preflight = await Promise.all(selected.map(async ([workUnitId, entry]) => ({ workUnitId, grant: await entry.service.prepareLaunch(entry.client) })));
        if (preflight.some(({ grant }) => grant.kind !== "execution-granted")) return { kind: "execution-unavailable", preflight };
        const members = [];
        for (const [workUnitId, entry] of selected) {
          if (this.#draining) break;
          const result = await entry.service.request(entry.client, "launch", {}); members.push({ workUnitId, result });
          if (result.kind !== "wave-started" && result.kind !== "existing-operation") break;
        }
        return { kind: members.length ? "plan-wave-dispatched" : "no-ready-work", members, readiness: (await this.#view()).readiness };
      }
      if (method === "notifications") {
        executorExact(params, []); const notifications = [];
        for (const entry of this.#jobs.values()) if (!entry.error) notifications.push(...(await entry.service.request(entry.client, method, {})).notifications);
        return { notifications, detachedWakeAvailable: false };
      }
      if (!["collect", "join", "acknowledge"].includes(method)) fail("unsupported-service-method");
      const { workUnitId, ...args } = params ?? {};
      const entry = this.#jobs.get(workUnitId); if (!entry || entry.error) fail("executor-plan-member-unavailable");
      if (method === "join" && args.expectedAttempt !== entry.config.job.workUnits[0].attempt) fail("stale-attempt-decision");
      const result = await entry.service.request(entry.client, method, args);
      return method === "join" ? { ...result, readiness: (await this.#view()).readiness } : result;
    });
    this.#queue = next; return next;
  }
  drain() {
    if (!this.#starting) fail("supervisor-not-started");
    if (this.#draining) return this.status();
    this.#draining = true; this.#state = "draining";
    this.#queue = this.#queue.catch(() => {}).then(async () => {
      await this.#starting.catch(() => {});
      for (const { service, error } of this.#jobs.values()) if (!error) service.drain();
      await Promise.all([...this.#jobs.values()].filter(({ error }) => !error).map(({ service }) => service.stopped));
      if (this.#state !== "failed") this.#state = "stopped";
      this.#finish();
    });
    return this.status();
  }
}
