import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import {
  planWorkSlices,
  SLICE_PLAN_INPUT_SCHEMA,
} from "./slice-planner.mjs";
import {
  createPlanningBootstrapV1,
  finalizePlanningBootstrapV1,
  PLANNING_BOOTSTRAP_INPUT_SCHEMA,
} from "./planning-bootstrap.mjs";
import {
  PlanningLifecycleCoordinatorV1,
  PlanningLifecycleProtocolError,
  PLANNING_LIFECYCLE_INPUT_SCHEMA,
} from "./planning-lifecycle.mjs";
import {
  ExceptionReplanningCoordinatorV1,
  EXCEPTION_REPLANNING_INPUT_SCHEMA,
} from "./exception-replanning.mjs";
import {
  LAUNCH_BATCH_VERIFICATION_INPUT_SCHEMA,
  verifyLaunchBatchV1,
} from "./launch-batch-verification.mjs";
import {
  createPlanRunV1,
  PlanRunStoreV1,
} from "./plan-run-store.mjs";
import { routeIntelligenceProfile } from "./intelligence-profile-router.mjs";
import {
  resolveNativeSubagentThreadV1,
  verifyRuntimeIntelligenceV1,
} from "./runtime-intelligence-verification.mjs";
import { withNextAction } from "./next-action.mjs";
import {
  MCP_ORCHESTRATE_INPUT_SCHEMA,
  McpOrchestrationAdapterV1,
} from "./mcp-orchestration.mjs";
import {
  MCP_OBSERVATION_ADVANCE_INPUT_SCHEMA,
  McpJoinAdapterV1,
} from "./mcp-observation.mjs";
import {
  MCP_QUEEN_DECISION_INPUT_SCHEMA,
  McpQueenDecisionAdapterV1,
} from "./mcp-queen-decision.mjs";
import {
  CodexAppServerBridgeV1,
  MCP_APP_SERVER_MAX_BATCH_THREADS,
  MCP_APP_SERVER_MAX_WAIT_MS,
  MCP_APP_SERVER_MAX_WAIT_THREADS,
} from "./mcp-app-server-bridge.mjs";
import {
  SPINOFF_CLEANUP_INPUT_SCHEMA,
  SPINOFF_COMPLETE_INPUT_SCHEMA,
  SpinoffLifecycleAdapterV1,
} from "./spinoff-lifecycle.mjs";
import {
  NELOS_CLEANUP_POLICIES,
  NELOS_CLEANUP_POLICY_KEY,
  NelosConfigurationV1,
} from "./nelos-configuration.mjs";
import {
  MCP_PROTOCOL_TOOL_CONTRACTS_V1,
  MCP_PROTOCOL_TOOL_OUTPUT_SCHEMAS_V1,
} from "./protocol-contract/index.mjs";
import {
  createLaunchAuthorizationReceiptV1,
  LAUNCH_AUTHORIZATION_PRODUCER_INPUT_SCHEMA,
  LAUNCH_AUTHORIZATION_RECEIPT_SCHEMA,
} from "./launch-execution-gate.mjs";
import {
  EXECUTION_MAP_REFRESH_INPUT_SCHEMA,
  projectExecutionMapForToolResultV1,
  executionMapOutputSchemaForToolV1,
  executionMapToolMetadataV1,
  listExecutionMapResourcesV1,
  readExecutionMapResourceV1,
  refreshExecutionMapStatusV1,
} from "./execution-map.mjs";
import {
  allocatePermanentWebId,
  listWebRecords,
  readWebRecord,
  withWebRegistryLock,
  writeWebRecord,
} from "./task-state.mjs";
import {
  allocateWebId,
  parentWebId,
  parseWebTitle,
  renderPersistedQueenWebTitle,
  titleLineageId,
} from "./task-web.mjs";
import { workUnitFromPlanSliceV1 } from "./plan-orchestration-bridge.mjs";
import { workUnitDefinitionV1 } from "./execution-store.mjs";
import {
  NelosWebInspectorV1,
  WEB_INSPECTION_INPUT_SCHEMA,
} from "./web-inspection.mjs";

// MCP tool surface for the marketplace plugin; scope and trust model are
// specified in docs/mcp-tool-surface.md. Transport is
// newline-delimited JSON-RPC over stdio, as required by MCP. The planner owns
// one narrowly scoped
// queen-title observation through a lazy Codex app-server child; inspection is
// bounded and read-only. Native mutations remain host-owned effects.

export const MCP_SERVER_NAME = "nelos";
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze([
  "2025-11-25",
  "2025-06-18",
]);
export const MCP_DEFAULT_PROTOCOL_VERSION = MCP_SUPPORTED_PROTOCOL_VERSIONS[0];
export const MCP_MAX_MESSAGE_BYTES = 256 * 1024;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRequestId(value) {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isInteger(value))
  );
}

function negotiatedProtocolVersion(requested) {
  return MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
    ? requested
    : MCP_DEFAULT_PROTOCOL_VERSION;
}

const READ_ONLY_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  openWorldHint: false,
});

const STATEFUL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

const DESTRUCTIVE_STATEFUL_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: true,
  openWorldHint: false,
});

const CONFIGURATION_KEY_SCHEMA = Object.freeze({
  type: "string",
  enum: [NELOS_CLEANUP_POLICY_KEY],
});

const DEFAULT_WEB_REGISTRY = Object.freeze({
  allocate: allocatePermanentWebId,
  withLock: withWebRegistryLock,
  read: readWebRecord,
  list: listWebRecords,
  write: writeWebRecord,
});

/**
 * Persist verified joined-member bindings before recording a verified wave.
 * Replays accept the same durable binding and reject conflicting identities.
 */
async function adoptVerifiedJoinedMembers(
  record,
  verification,
  orchestrationAdapter,
) {
  const joined = verification.members.filter(
    ({ lifecycle }) => lifecycle === "subagent",
  );
  if (joined.length === 0) return;
  // Subagent-only plans intentionally have no durable web identity or later
  // durable dependency consumer, so they retain their lightweight path.
  if (!record.webIdentity) return;
  if (!record.plan) {
    throw new Error(
      "verified joined-member repair requires a persisted plan and web identity",
    );
  }
  const slices = record.plan.waves.flatMap((wave) => wave.slices);
  for (const member of joined) {
    const slice = slices.find(({ id }) => id === member.sliceId);
    if (!slice) {
      throw new Error(
        `verified joined member ${member.sliceId} is absent from the persisted plan`,
      );
    }
    const workUnit = workUnitDefinitionV1(workUnitFromPlanSliceV1(slice, {
      webId: record.webIdentity.webId,
      queenThreadId: record.queenThreadId,
      cleanupIntended: record.cleanupIntended,
    }));
    const prepared = await orchestrationAdapter.orchestrate({
      workUnit,
      receipt: null,
    });
    if (prepared.binding.state === "bound") {
      if (prepared.binding.memberThreadId !== member.threadId) {
        throw new Error(
          `verified joined member ${member.sliceId} conflicts with its durable binding`,
        );
      }
      continue;
    }
    const launch = prepared.effects.find(
      ({ type }) => ["native-create", "native-reconcile-create"].includes(type),
    );
    const actionId = launch?.type === "native-create"
      ? launch.actionId
      : launch?.createActionId;
    if (!actionId) {
      throw new Error(
        `verified joined member ${member.sliceId} has no durable launch action`,
      );
    }
    await orchestrationAdapter.orchestrate({
      workUnit,
      receipt: {
        schemaVersion: 1,
        actionId,
        type: "native-create",
        workUnitId: workUnit.workUnitId,
        specRevision: workUnit.specRevision,
        attempt: workUnit.attempt,
        memberThreadId: member.threadId,
      },
    });
  }
}

async function plannedSlicesOutput(
  plan,
  appServerBridge,
  additionalFields = {},
  {
    queenThreadId,
    planRunStore,
    parentPlanRun = null,
    webRegistry,
    cleanupIntended = true,
    launchAuthorization = null,
  },
) {
  let sourceId =
    additionalFields.lifecycle?.bootstrapId ??
    additionalFields.planning?.bootstrapId ??
    `structured:${createHash("sha256")
      .update(JSON.stringify({ plan, cleanupIntended }), "utf8")
      .digest("hex")}`;
  const candidate = createPlanRunV1(plan, {
    queenThreadId,
    sourceId,
    parentPlanRun,
    cleanupIntended,
  });
  const existing = await planRunStore.read(candidate.planRunId);
  let persistedWebIdentity =
    parentPlanRun?.webIdentity ?? existing?.webIdentity ?? null;
  let settledQueenTitle = null;

  if (plan.summary.spinoffs > 0) {
    const before = await appServerBridge.inspect({ threadId: queenThreadId });
    if (!before.title) {
      throw new Error("current queen task has no settled title");
    }
    const preflight = await appServerBridge.inspect({ threadId: queenThreadId });
    if (preflight.title !== before.title) {
      throw new Error("queen title changed during synchronization");
    }
    settledQueenTitle = preflight.title;
    persistedWebIdentity = await webRegistry.withLock(async () => {
      const stored = await webRegistry.read(queenThreadId);
      const revivingArchivedQueen = stored?.archivedAt != null;
      if (revivingArchivedQueen && parentPlanRun === null) {
        persistedWebIdentity = null;
        sourceId =
          `revived:${createHash("sha256")
            .update(
              JSON.stringify([sourceId, stored.archivedAt]),
              "utf8",
            )
            .digest("hex")}`;
      }
      const current = stored && !stored.archivedAt ? stored : null;
      const parsed = parseWebTitle(settledQueenTitle);
      const plannedWebId = persistedWebIdentity?.webId ?? null;
      const recordedWebId = current?.outboundWebId
        ? String(current.outboundWebId).trim().toUpperCase()
        : null;
      for (const observedWebId of [
        recordedWebId,
        revivingArchivedQueen ? null : parsed.outboundWebId,
      ]) {
        if (
          observedWebId &&
          plannedWebId &&
          observedWebId !== plannedWebId
        ) {
          throw new Error(
            `queen web identity ${observedWebId} conflicts with persisted web identity ${plannedWebId}`,
          );
        }
      }
      if (
        recordedWebId &&
        parsed.outboundWebId &&
        recordedWebId !== parsed.outboundWebId
      ) {
        throw new Error(
          "queen title conflicts with its persisted legacy web record",
        );
      }
      const webId =
        plannedWebId ??
        recordedWebId ??
        (revivingArchivedQueen ? null : parsed.outboundWebId) ??
        (webRegistry.allocate
          ? await webRegistry.allocate({
              allocationKey: `queen:${candidate.planRunId}:${revivingArchivedQueen ? stored.archivedAt : "active"}`,
              parentWebId: revivingArchivedQueen ? null : parsed.inboundWebId,
            })
          : allocateWebId(
              await webRegistry.list(),
              revivingArchivedQueen ? null : parsed.inboundWebId,
            ));
      const queenTitle =
        persistedWebIdentity?.queenTitle ??
        renderPersistedQueenWebTitle(
          revivingArchivedQueen ? parsed.baseTitle : settledQueenTitle,
          webId,
        );
      const normalized = {
        schemaVersion: 1,
        webId,
        queenThreadId,
        queenTitle,
      };
      if (
        persistedWebIdentity &&
        JSON.stringify(persistedWebIdentity) !== JSON.stringify(normalized)
      ) {
        throw new Error(
          "queen observation conflicts with persisted plan-run lineage",
        );
      }
      const parsedQueenTitle = parseWebTitle(queenTitle);
      const alreadyPersisted =
        current?.baseTitle === parsedQueenTitle.baseTitle &&
        (current?.inboundWebId ?? null) === parsedQueenTitle.inboundWebId &&
        current?.outboundWebId === webId &&
        current?.queenMarked === true &&
        current?.renderedTitle === queenTitle &&
        current?.archivedAt === null;
      if (!alreadyPersisted) {
        const timestamp = new Date().toISOString();
        await webRegistry.write({
          ...(current ?? {}),
          threadId: queenThreadId,
          baseTitle: parsedQueenTitle.baseTitle,
          inboundWebId: parsedQueenTitle.inboundWebId,
          outboundWebId: webId,
          lineageId: webId,
          queenThreadId: current?.queenThreadId ?? null,
          queenMarked: true,
          renderedTitle: queenTitle,
          createdAt: current?.createdAt ?? timestamp,
          updatedAt: timestamp,
          archivedAt: null,
        });
      }
      return normalized;
    });
  }
  const lineageIdsBySlice = {};
  for (const prior of [parentPlanRun, existing]) {
    for (const wave of prior?.waves ?? []) {
      for (const member of wave.members) {
        if (member.lifecycle === "spinoff") {
          const lineageId = titleLineageId(member.title);
          if (
            lineageId &&
            parentWebId(lineageId) === persistedWebIdentity?.webId
          ) {
            lineageIdsBySlice[member.sliceId] = lineageId;
          }
        }
      }
    }
  }
  if (plan.summary.spinoffs > 0) {
    const allocationCandidate = createPlanRunV1(plan, {
      queenThreadId,
      sourceId,
      parentPlanRun,
      webIdentity: persistedWebIdentity,
      cleanupIntended,
    });
    await webRegistry.withLock(async () => {
      const records = await webRegistry.list();
      const provisional = [];
      for (const wave of plan.waves) {
        for (const slice of wave.slices) {
          if (slice.lifecycle !== "spinoff" || lineageIdsBySlice[slice.id]) continue;
          const lineageId = webRegistry.allocate
            ? await webRegistry.allocate({
                allocationKey: `plan:${allocationCandidate.planRunId}:slice:${slice.id}`,
                parentWebId: persistedWebIdentity.webId,
              })
            : allocateWebId([...records, ...provisional], persistedWebIdentity.webId);
          lineageIdsBySlice[slice.id] = lineageId;
          provisional.push({ lineageId });
        }
      }
    });
  }
  const planRun = await planRunStore.create(
    createPlanRunV1(plan, {
      queenThreadId,
      sourceId,
      parentPlanRun,
      webIdentity: persistedWebIdentity,
      lineageIdsBySlice,
      cleanupIntended,
    }),
  );
  const { launchAuthorization: _authorization, ...output } = withNextAction({
    command: "plan slices",
    plan,
    planRun,
    cleanupIntended,
    launchAuthorization,
    ...additionalFields,
  });
  if (plan.summary.spinoffs === 0) return output;

  const requestedTitle = planRun.webIdentity.queenTitle;
  const changed = requestedTitle !== settledQueenTitle;
  return {
    ...output,
    queenTitleSync: {
      schemaVersion: 1,
      threadId: queenThreadId,
      webId: planRun.webIdentity.webId,
      previousTitle: settledQueenTitle,
      title: requestedTitle,
      changed,
      verified: !changed,
    },
    ...(changed
      ? {
          nextAction: {
            schemaVersion: 1,
            kind: "native-set-title",
            actionId: `plan-title:${planRun.planRunId.slice(4)}:queen`,
            threadId: queenThreadId,
            title: requestedTitle,
            verify: true,
            after: "repeat-plan-slices",
          },
        }
      : {}),
  };
}

const TOOLS = [
  {
    name: "nelos_plan_bootstrap",
    description:
      "Prepare one bounded Sol/medium joined planning subagent for an " +
      "unstructured objective. Returns an exact native launch action and a " +
      "strict result contract. Call it again with the exact planner response to " +
      "validate and route the plan; callers with an existing structured plan " +
      "should use nelos_plan_slices directly.",
    inputSchema: {
      ...PLANNING_BOOTSTRAP_INPUT_SCHEMA,
      properties: {
        ...PLANNING_BOOTSTRAP_INPUT_SCHEMA.properties,
        launchAuthorization: LAUNCH_AUTHORIZATION_RECEIPT_SCHEMA,
      },
    },
    annotations: STATEFUL_ANNOTATIONS,
    async run(args, { appServerBridge, planRunStore, webRegistry }) {
      const {
        queenThreadId,
        launchAuthorization = null,
        ...bootstrapArgs
      } = args;
      if (args.response !== undefined) {
        if (typeof queenThreadId !== "string" || !queenThreadId.trim()) {
          throw new Error(
            "queenThreadId is required when finalizing a planning bootstrap",
          );
        }
        const { response, ...request } = bootstrapArgs;
        const finalized = finalizePlanningBootstrapV1(request, response);
        if (!finalized.ready) {
          return withNextAction({
            command: "plan bootstrap review",
            bootstrap: finalized,
          });
        }
        return plannedSlicesOutput(
          finalized.plan,
          appServerBridge,
          {
            planning: {
              bootstrapId: finalized.bootstrapId,
              confidence: finalized.confidence,
              classificationEvidence: finalized.classificationEvidence,
            },
          },
          {
            queenThreadId,
            planRunStore,
            webRegistry,
            launchAuthorization,
          },
        );
      }
      return withNextAction({
        command: "plan bootstrap",
        bootstrap: createPlanningBootstrapV1(bootstrapArgs),
      });
    },
  },
  {
    name: "nelos_plan_lifecycle",
    description:
      "Durably coordinate the exact Sol/medium planning lifecycle through " +
      "typed native launch and result receipts. Uses a caller-stable " +
      "idempotency key, verifies joined-subagent identity, topology, route, " +
      "and terminal result turn, then requires exact native-host launch " +
      "authorization before returning an executable wave.",
    inputSchema: PLANNING_LIFECYCLE_INPUT_SCHEMA,
    annotations: STATEFUL_ANNOTATIONS,
    async run(args, {
      appServerBridge,
      planningLifecycle,
      planRunStore,
      webRegistry,
    }) {
      const result = await planningLifecycle.advance(args, {
        appServerBridge,
      });
      if (!result.plan) return result;
      return plannedSlicesOutput(
        result.plan,
        appServerBridge,
        {
          lifecycle: result.lifecycle,
          bootstrap: result.bootstrap,
          planning: result.planning,
        },
        {
          queenThreadId: args.queenThreadId,
          planRunStore,
          webRegistry,
          cleanupIntended: args.cleanupIntended ?? true,
          launchAuthorization: args.launchAuthorization ?? null,
        },
      );
    },
  },
  {
    name: "nelos_plan_replan",
    description:
      "Start or advance one bounded Sol/medium replanning lifecycle only for " +
      "typed execution failure, blocking, changed requirements, or insufficient " +
      "confidence. Preserves completed slices and never schedules them again.",
    inputSchema: EXCEPTION_REPLANNING_INPUT_SCHEMA,
    annotations: STATEFUL_ANNOTATIONS,
    async run(args, {
      appServerBridge,
      exceptionReplanning,
      planRunStore,
      webRegistry,
    }) {
      const result = await exceptionReplanning.advance(args, {
        appServerBridge,
      });
      if (!result.plan) {
        if (result.replanning?.executionComplete) {
          return {
            ...result,
            nextAction: {
              schemaVersion: 1,
              kind: "complete",
              state: "exception-replan-has-no-pending-slices",
            },
          };
        }
        return result;
      }
      const parentPlanRun = await planRunStore.read(
        result.replanning.basePlanRunId,
      );
      if (!parentPlanRun) {
        throw new Error("exception replan lost its persisted base plan run");
      }
      return plannedSlicesOutput(
        result.plan,
        appServerBridge,
        {
          lifecycle: result.lifecycle,
          bootstrap: result.bootstrap,
          planning: result.planning,
          replanning: result.replanning,
        },
        {
          queenThreadId: args.queenThreadId,
          planRunStore,
          parentPlanRun,
          webRegistry,
          cleanupIntended: parentPlanRun.cleanupIntended,
          launchAuthorization: args.launchAuthorization ?? null,
        },
      );
    },
  },
  {
    name: "nelos_plan_slices",
    description:
      "Validate a structured slice-plan JSON object and return " +
      "dependency-safe waves with reviewed per-slice launch options and the " +
      "machine-generated nextAction. Every wave requires exact native-host " +
      "capability and creation authorization. Plans containing spinoffs first " +
      "synchronize and verify the current queen title through Codex.",
    inputSchema: {
      type: "object",
      properties: {
        plan: {
          description:
            "Slice plan with schemaVersion, objective, optional maxParallel, " +
            "and slices (id, title, objective, deliverable, " +
            "acceptanceCriteria, dependsOn, lifecycle, workspaceMode, " +
            "taskShape).",
          ...SLICE_PLAN_INPUT_SCHEMA,
        },
        queenThreadId: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          description:
            "Explicit current queen task ID; required when any slice is a spinoff",
        },
        cleanupIntended: {
          type: "boolean",
          description:
            "Grant archive capability for terminal cleanup. Defaults to true; the configured cleanup policy decides whether eligible accepted spin-offs are archived.",
        },
        launchAuthorization: LAUNCH_AUTHORIZATION_RECEIPT_SCHEMA,
      },
      required: ["plan", "queenThreadId"],
      additionalProperties: false,
    },
    annotations: STATEFUL_ANNOTATIONS,
    async run(args, { appServerBridge, planRunStore, webRegistry }) {
      const plan = planWorkSlices(args.plan);
      return plannedSlicesOutput(
        plan,
        appServerBridge,
        {},
        {
          queenThreadId: args.queenThreadId,
          planRunStore,
          webRegistry,
          cleanupIntended: args.cleanupIntended ?? true,
          launchAuthorization: args.launchAuthorization ?? null,
        },
      );
    },
  },
  {
    name: "nelos_launch_authorize",
    description:
      "Produce one exact native-launch-authorization receipt from the " +
      "machine-generated authorization request, bounded capabilities copied " +
      "from the current native host tool registry, and explicit user intent. " +
      "The caller must replay the receipt through the planning lifecycle; " +
      "this tool never launches work.",
    inputSchema: LAUNCH_AUTHORIZATION_PRODUCER_INPUT_SCHEMA,
    annotations: DESTRUCTIVE_STATEFUL_ANNOTATIONS,
    async run(args) {
      return {
        command: "launch authorize",
        receipt: createLaunchAuthorizationReceiptV1(args),
      };
    },
  },
  {
    name: "nelos_launch_verify_batch",
    description:
      "Atomically gate one launched wave by verifying every member's unique " +
      "native identity, available topology, lifecycle-appropriate presentation " +
      "(agent path for joined subagents, native title for spinoffs), and exact model/effort " +
      "before any result is read or accepted. Any member failure blocks the batch.",
    inputSchema: LAUNCH_BATCH_VERIFICATION_INPUT_SCHEMA,
    annotations: STATEFUL_ANNOTATIONS,
    async run(args, {
      appServerBridge,
      launchBatchVerifier,
      orchestrationAdapter,
      planRunStore,
    }) {
      const { record, wave } = await planRunStore.requireWave({
        planRunId: args.planRunId,
        queenThreadId: args.parentThreadId,
        waveIndex: args.waveIndex,
        waveDigest: args.waveDigest,
      });
      const verification = await launchBatchVerifier(args, {
        appServerBridge,
        waveContract: wave,
      });
      if (verification.allVerified) {
        await adoptVerifiedJoinedMembers(
          record,
          verification,
          orchestrationAdapter,
        );
        await planRunStore.markWaveVerified({
          planRunId: args.planRunId,
          queenThreadId: args.parentThreadId,
          waveIndex: args.waveIndex,
          waveDigest: args.waveDigest,
        });
      }
      const titleMismatch = verification.members.find(
        (member) =>
          member.lifecycle === "spinoff" &&
          member.attentionReason === "title-mismatch" &&
          member.checks.identity === "verified" &&
          member.checks.read === "verified" &&
          member.checks.topology === "verified" &&
          member.checks.route === "verified",
      );
      const expectedTitle = titleMismatch
        ? wave.members.find(
            ({ sliceId }) => sliceId === titleMismatch.sliceId,
          )?.title
        : null;
      return {
        command: "launch verify batch",
        verification,
        nextAction: verification.allVerified
          ? {
              schemaVersion: 1,
              kind: "native-wait-wave",
              targets: verification.members.map((member) => {
                const receipt = args.members.find(
                  ({ sliceId }) => sliceId === member.sliceId,
                );
                return member.lifecycle === "subagent"
                  ? {
                      sliceId: member.sliceId,
                      lifecycle: "subagent",
                      memberKind: "joined-subagent",
                      controlSurface: "collaboration",
                      primaryId: "agentPath",
                      agentPath: receipt.agentPath,
                      threadId: member.threadId,
                      turnId: receipt.turnId,
                    }
                  : {
                      sliceId: member.sliceId,
                      lifecycle: "spinoff",
                      memberKind: "spinoff",
                      controlSurface: "codex-task",
                      primaryId: "threadId",
                      threadId: member.threadId,
                      turnId: receipt.turnId,
                    };
              }),
              after: "read-results",
            }
          : titleMismatch && expectedTitle
            ? {
                schemaVersion: 1,
                kind: "native-set-title",
                actionId:
                  `plan-title:${args.planRunId.slice(4)}:` +
                  `wave-${args.waveIndex}:${titleMismatch.sliceId}`,
                threadId: titleMismatch.threadId,
                title: expectedTitle,
                verify: true,
                after: "repeat-launch-verify-batch",
              }
          : {
              schemaVersion: 1,
              kind: "attention",
              reason: "launch-batch-verification-failed",
              sliceIds: verification.members
                .filter(({ verified }) => !verified)
                .map(({ sliceId }) => sliceId),
            },
      };
    },
  },
  {
    name: "nelos_execution_map_refresh",
    description:
      "Refresh the visible execution map from bounded current native-turn " +
      "evidence after launched workers run. Use this after a wait or result " +
      "read so completed workers do not remain visually launch-pending.",
    inputSchema: EXECUTION_MAP_REFRESH_INPUT_SCHEMA,
    annotations: READ_ONLY_ANNOTATIONS,
    async run(args, { appServerBridge }) {
      return refreshExecutionMapStatusV1(args, { appServerBridge });
    },
  },
  {
    name: "nelos_thread_inspect",
    description:
      "Read bounded metadata for one Codex task through the MCP-owned " +
      "app-server bridge. Returns no prompts, previews, turns, or transcripts.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: {
          type: "string",
          minLength: 1,
          maxLength: 512,
          description: "Explicit task/thread ID",
        },
      },
      required: ["threadId"],
      additionalProperties: false,
    },
    async run(args, { appServerBridge }) {
      return {
        command: "thread inspect",
        thread: await appServerBridge.inspect({
          threadId: args.threadId,
        }),
      };
    },
  },
  {
    name: "nelos_thread_inventory",
    description:
      "Inspect up to 16 explicit Codex tasks concurrently and optionally " +
      "project authoritative direct parent edges. Partial read failures are " +
      "bounded per task; no turns, prompts, previews, or transcripts are returned.",
    inputSchema: {
      type: "object",
      properties: {
        threadIds: {
          type: "array",
          minItems: 1,
          maxItems: MCP_APP_SERVER_MAX_BATCH_THREADS,
          uniqueItems: true,
          items: { type: "string", minLength: 1, maxLength: 512 },
          description: "Unique task/thread IDs in desired output order",
        },
        includeTopology: {
          type: "boolean",
          description: "Include direct parent edges among successful tasks",
        },
      },
      required: ["threadIds"],
      additionalProperties: false,
    },
    async run(args, { appServerBridge }) {
      return {
        command: "thread inventory",
        inventory: await appServerBridge.inspectMany({
          threadIds: args.threadIds,
          includeTopology: args.includeTopology ?? true,
        }),
      };
    },
  },
  {
    name: "nelos_web_inspect",
    description:
      "Inspect one persisted Nelos web through a single bounded read-only " +
      "workflow. Combines current work-unit bindings, orchestration state, " +
      "paged native task status, topology, and content-free bridge health " +
      "without returning prompts, turns, transcripts, or result text.",
    inputSchema: WEB_INSPECTION_INPUT_SCHEMA,
    async run(args, { appServerBridge, webInspector, webRegistry }) {
      return {
        command: "web inspect",
        inspection: await webInspector.inspect(args, {
          appServerBridge,
          webRegistry,
        }),
      };
    },
  },
  {
    name: "nelos_thread_wait",
    description:
      "Perform bounded current-state polling for up to eight Codex tasks. " +
      "Nelos snapshot cursors suppress unchanged snapshots; they are not " +
      "native event cursors and do not prove completion or result provenance.",
    inputSchema: {
      type: "object",
      properties: {
        targets: {
          type: "array",
          minItems: 1,
          maxItems: MCP_APP_SERVER_MAX_WAIT_THREADS,
          items: {
            type: "object",
            properties: {
              threadId: {
                type: "string",
                minLength: 1,
                maxLength: 512,
              },
              afterCursor: {
                type: ["string", "null"],
                minLength: 1,
                maxLength: 512,
              },
            },
            required: ["threadId"],
            additionalProperties: false,
          },
        },
        timeoutMs: {
          type: "integer",
          minimum: 0,
          maximum: MCP_APP_SERVER_MAX_WAIT_MS,
        },
        pollIntervalMs: {
          type: "integer",
          minimum: 50,
          maximum: 5_000,
        },
      },
      required: ["targets"],
      additionalProperties: false,
    },
    async run(args, { appServerBridge }) {
      return {
        command: "thread wait",
        wait: await appServerBridge.waitForThreads({
          targets: args.targets,
          timeoutMs: args.timeoutMs ?? 0,
          pollIntervalMs: args.pollIntervalMs ?? 250,
        }),
      };
    },
  },
  {
    name: "nelos_app_server_health",
    description:
      "Report bounded, content-free compatibility and connection telemetry " +
      "for Nelos's Codex app-server bridge. An optional probe performs only " +
      "the initialization handshake.",
    inputSchema: {
      type: "object",
      properties: {
        probe: {
          type: "boolean",
          description: "Initialize the bridge before reporting health",
        },
      },
      additionalProperties: false,
    },
    async run(args, { appServerBridge }) {
      return {
        command: "app-server health",
        health: await appServerBridge.health({ probe: args.probe === true }),
      };
    },
  },
  {
    name: "nelos_intelligence_route",
    description:
      "Route a task shape to a reviewed model-and-reasoning profile, with " +
      "optional explicit overrides. Use this bundled tool in installed-plugin workflows.",
    inputSchema: {
      type: "object",
      properties: {
        taskShape: {
          type: "string",
          description:
            "complex/open-ended, everyday, or clear/repeatable",
        },
        profile: { type: "string", description: "Explicit profile override" },
        model: { type: "string", description: "Explicit catalog model override" },
        effort: {
          type: "string",
          description: "Explicit supported reasoning-effort override",
        },
        allowNativeFanout: {
          type: "boolean",
          description: "Permit an explicit Ultra effort override",
        },
        launchSurface: {
          type: "string",
          enum: ["durable-task", "joined-subagent"],
          description: "Native surface that will launch the work",
        },
      },
      required: ["launchSurface"],
      additionalProperties: false,
    },
    async run(args) {
      const input = {};
      if (args.taskShape !== undefined) input.taskShape = args.taskShape;
      if (args.profile !== undefined) {
        input.profileOverride = String(args.profile).toLowerCase();
      }
      if (args.model !== undefined) input.modelOverride = args.model;
      if (args.effort !== undefined) input.effortOverride = args.effort;
      if (args.allowNativeFanout === true) input.nativeFanoutAllowed = true;
      input.launchSurface = args.launchSurface;
      return withNextAction({
        command: "intelligence route",
        route: routeIntelligenceProfile(input),
      });
    },
  },
  {
    name: "nelos_intelligence_verify",
    description:
      "Verify from bounded local turn-context metadata that a launched task " +
      "runs the exact expected model and reasoning effort. Fails closed on " +
      "any mismatch. Use this bundled tool in installed-plugin workflows.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string", description: "Launched task/thread ID" },
        model: { type: "string", description: "Expected model" },
        effort: { type: "string", description: "Expected reasoning effort" },
        turnId: {
          type: "string",
          description: "Restrict verification to one turn, when known",
        },
      },
      required: ["threadId", "model", "effort"],
      additionalProperties: false,
    },
    async run(args) {
      const verification = await verifyRuntimeIntelligenceV1({
        threadId: args.threadId,
        turnId: args.turnId ?? null,
        model: args.model,
        effort: args.effort,
      });
      const output = withNextAction({
        command: "intelligence verify",
        ...verification,
      });
      return {
        ...output,
        // Mirrors the CLI, which exits nonzero for an unverified route.
        isError: verification.verified !== true,
      };
    },
  },
  {
    name: "nelos_intelligence_resolve_subagent",
    description:
      "Resolve a native child task ID from one exact parent task and canonical " +
      "subagent path using bounded local session metadata, then return the " +
      "exact current-launch-turn route-verification action. Reads no prompts " +
      "or task results.",
    inputSchema: {
      type: "object",
      properties: {
        parentThreadId: { type: "string" },
        agentPath: { type: "string" },
        model: { type: "string" },
        effort: { type: "string" },
      },
      required: ["parentThreadId", "agentPath", "model", "effort"],
      additionalProperties: false,
    },
    async run(args) {
      const resolved = await resolveNativeSubagentThreadV1({
        parentThreadId: args.parentThreadId,
        agentPath: args.agentPath,
      });
      return withNextAction({
        command: "intelligence resolve subagent",
        ...resolved,
        expected: { model: args.model, effort: args.effort },
      });
    },
  },
  {
    name: "nelos_orchestrate_create",
    description:
      "Durably advance one spinoff or joined-subagent work unit to " +
      "launch-pending and return one lifecycle-specific native-create effect, " +
      "or validate a host create receipt and bind its member thread ID. Joined " +
      "subagent launches accept only Sol or Terra; Luna is durable-task-only. " +
      "This tool never contacts the app server.",
    inputSchema: MCP_ORCHESTRATE_INPUT_SCHEMA,
    annotations: STATEFUL_ANNOTATIONS,
    async run(args, { orchestrationAdapter }) {
      return orchestrationAdapter.orchestrate(args);
    },
  },
  {
    name: "nelos_orchestrate_advance",
    description:
      "Advance the durable callback-only title/wait/result join checkpoint. " +
      "Also consumes typed correction-follow-up and legacy-member repair receipts. " +
      "Returns typed effects and, after all required results are " +
      "accepted, gates the next wave or returns an exact cleanup action. Never starts or " +
      "discovers an app server.",
    inputSchema: MCP_OBSERVATION_ADVANCE_INPUT_SCHEMA,
    annotations: STATEFUL_ANNOTATIONS,
    async run(args, { joinAdapter }) {
      return joinAdapter.advance(args);
    },
  },
  {
    name: "nelos_queen_decide",
    description:
      "Record an accepted or rejected queen decision for one exact current " +
      "orchestration result. Requires consumed result provenance and fresh " +
      "latest-turn evidence; exact persisted replays are idempotent.",
    inputSchema: MCP_QUEEN_DECISION_INPUT_SCHEMA,
    annotations: STATEFUL_ANNOTATIONS,
    async run(args, { appServerBridge, queenDecisionAdapter }) {
      return queenDecisionAdapter.decide(args, { appServerBridge });
    },
  },
  {
    name: "nelos_config_get",
    description:
      "Read the installed plugin's effective Nelos configuration, including " +
      "the resolved machine-local TOML path and whether the value comes from " +
      "TOML or the built-in default. The first call can migrate an exact legacy " +
      "preference into TOML; it never invokes the optional CLI.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    annotations: STATEFUL_ANNOTATIONS,
    async run(_args, { configuration }) {
      return configuration.get();
    },
  },
  {
    name: "nelos_config_set",
    description:
      "Set one validated machine-local Nelos preference after an explicit user " +
      "request and return the resulting effective configuration. Writes the " +
      "resolved TOML file atomically and never invokes or installs the optional CLI.",
    inputSchema: {
      type: "object",
      properties: {
        key: CONFIGURATION_KEY_SCHEMA,
        value: {
          type: "string",
          enum: [...NELOS_CLEANUP_POLICIES],
        },
        userIntentConfirmed: {
          const: true,
          description:
            "Confirm that the user explicitly requested this global preference change",
        },
      },
      required: ["key", "value", "userIntentConfirmed"],
      additionalProperties: false,
    },
    annotations: STATEFUL_ANNOTATIONS,
    async run(args, { configuration }) {
      return configuration.set(args);
    },
  },
  {
    name: "nelos_config_reset",
    description:
      "Reset one machine-local Nelos preference to its built-in default after " +
      "an explicit user request. Retires any legacy preference idempotently and " +
      "never invokes or installs the optional CLI.",
    inputSchema: {
      type: "object",
      properties: {
        key: CONFIGURATION_KEY_SCHEMA,
        userIntentConfirmed: {
          const: true,
          description:
            "Confirm that the user explicitly requested this global preference change",
        },
      },
      required: ["key", "userIntentConfirmed"],
      additionalProperties: false,
    },
    annotations: DESTRUCTIVE_STATEFUL_ANNOTATIONS,
    async run(args, { configuration }) {
      return configuration.reset(args);
    },
  },
  {
    name: "nelos_spinoff_complete",
    description:
      "Persist one bound spin-off completion and return one host-owned native " +
      "send-message effect, or validate the exact threadId-only host result. " +
      "Replays return a non-sending reconciliation effect instead of " +
      "duplicating the wake.",
    inputSchema: SPINOFF_COMPLETE_INPUT_SCHEMA,
    annotations: STATEFUL_ANNOTATIONS,
    async run(args, { lifecycleAdapter }) {
      return lifecycleAdapter.complete(args);
    },
  },
  {
    name: "nelos_spinoff_cleanup",
    description:
      "Derive accepted spin-offs eligible for cleanup and apply one per-web " +
      "auto/ask/keep policy snapshot; the built-in default is auto. Ask returns " +
      "an exact named candidate list. Remembering a policy globally requires " +
      "an explicit policy and userIntentConfirmed true. " +
      "Confirmed archives are returned as host-owned effects and become durable " +
      "only after exact native receipts. Wave-scoped completion is persisted; " +
      "replay this same tool with its exact launchAuthorization receipt to emit " +
      "the next dependency wave.",
    inputSchema: SPINOFF_CLEANUP_INPUT_SCHEMA,
    annotations: DESTRUCTIVE_STATEFUL_ANNOTATIONS,
    async run(args, { lifecycleAdapter }) {
      return lifecycleAdapter.cleanup(args);
    },
  },
];

export function listNelosMcpTools() {
  return TOOLS.map(({
    name,
    description,
    inputSchema,
    annotations,
  }) => {
    const uiMetadata = executionMapToolMetadataV1(name);
    const protocolMetadata = MCP_PROTOCOL_TOOL_CONTRACTS_V1[name];
    const outputSchema =
      executionMapOutputSchemaForToolV1(name) ??
      MCP_PROTOCOL_TOOL_OUTPUT_SCHEMAS_V1[name] ??
      null;
    return {
      name,
      description,
      inputSchema,
      ...(outputSchema ? { outputSchema } : {}),
      annotations: annotations ?? READ_ONLY_ANNOTATIONS,
      ...(protocolMetadata || uiMetadata
        ? {
            _meta: {
              ...(protocolMetadata
                ? {
                    "nelos/protocolContract": {
                      schemaVersion: 1,
                      ...protocolMetadata,
                    },
                  }
                : {}),
              ...(uiMetadata ?? {}),
            },
          }
        : {}),
    };
  });
}

function assertToolArguments(tool, value) {
  const args = value ?? {};
  if (typeof args !== "object" || Array.isArray(args)) {
    throw new Error(`${tool.name} arguments must be an object`);
  }
  const allowed = new Set(Object.keys(tool.inputSchema.properties));
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      throw new Error(`${tool.name} does not accept argument ${key}`);
    }
  }
  for (const key of tool.inputSchema.required ?? []) {
    if (args[key] === undefined) {
      throw new Error(`${tool.name} requires argument ${key}`);
    }
  }
  return args;
}

export function startNelosMcpServer({
  input = process.stdin,
  output = process.stdout,
  serverVersion = "0.0.0-dev",
  onExit = (code) => process.exit(code),
  orchestrationAdapter = new McpOrchestrationAdapterV1(),
  joinAdapter = new McpJoinAdapterV1(),
  queenDecisionAdapter = new McpQueenDecisionAdapterV1(),
  configuration = new NelosConfigurationV1(),
  lifecycleAdapter = new SpinoffLifecycleAdapterV1({ configuration }),
  appServerBridge = new CodexAppServerBridgeV1(),
  planRunStore = new PlanRunStoreV1(),
  webRegistry = DEFAULT_WEB_REGISTRY,
  planningLifecycle = new PlanningLifecycleCoordinatorV1(),
  exceptionReplanning = new ExceptionReplanningCoordinatorV1({
    planningLifecycle,
    planRunStore,
  }),
  launchBatchVerifier = verifyLaunchBatchV1,
  webInspector = new NelosWebInspectorV1(),
} = {}) {
  let initialized = false;
  let negotiatedVersion = null;

  function send(payload) {
    output.write(JSON.stringify(payload) + "\n");
  }

  function sendError(code, message, id) {
    send({
      jsonrpc: "2.0",
      ...(isRequestId(id) ? { id } : {}),
      error: { code, message },
    });
  }

  async function callTool(params) {
    const tool = TOOLS.find((candidate) => candidate.name === params?.name);
    if (!tool) {
      const error = new Error(`unknown tool: ${params?.name}`);
      error.jsonRpcCode = -32602;
      throw error;
    }
    let result;
    let args;
    try {
      args = assertToolArguments(tool, params.arguments);
      result = await tool.run(args, {
        appServerBridge,
        exceptionReplanning,
        launchBatchVerifier,
        orchestrationAdapter,
        planningLifecycle,
        planRunStore,
        webRegistry,
        joinAdapter,
        queenDecisionAdapter,
        lifecycleAdapter,
        configuration,
        webInspector,
      });
    } catch (error) {
      const body = { error: error.message };
      if (error instanceof PlanningLifecycleProtocolError) {
        body.code = error.code;
        body.retryable = error.retryable;
        body.protocolError = error.protocolError;
        if (error.recoveryCommand !== null) {
          body.recoveryCommand = error.recoveryCommand;
        }
      }
      return {
        content: [{ type: "text", text: JSON.stringify(body) }],
        isError: true,
      };
    }
    const { isError = false, ...body } = result;
    const structuredContent = await projectExecutionMapForToolResultV1(
      tool.name,
      args,
      body,
      { webRegistry },
    ) ?? (
      MCP_PROTOCOL_TOOL_OUTPUT_SCHEMAS_V1[tool.name]
        ? structuredClone(body)
        : null
    );
    return {
      ...(structuredContent ? { structuredContent } : {}),
      content: [{ type: "text", text: JSON.stringify(body) }],
      isError,
    };
  }

  async function handle(message) {
    const { id, method, params } = message;
    const isRequest = Object.hasOwn(message, "id");
    if (method === "initialize") {
      if (!isRequest) {
        // Even an invalidly shaped MCP notification must not receive a
        // response under JSON-RPC notification semantics.
        return;
      }
      if (initialized) {
        sendError(-32600, "server is already initialized", id);
        return;
      }
      if (
        !isObject(params) ||
        typeof params.protocolVersion !== "string" ||
        !isObject(params.capabilities) ||
        !isObject(params.clientInfo) ||
        typeof params.clientInfo.name !== "string" ||
        typeof params.clientInfo.version !== "string"
      ) {
        sendError(-32602, "invalid initialize parameters", id);
        return;
      }
      const selectedProtocolVersion = negotiatedProtocolVersion(
        params.protocolVersion,
      );
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: selectedProtocolVersion,
          capabilities: {
            tools: { listChanged: false },
            resources: { listChanged: false, subscribe: false },
          },
          serverInfo: { name: MCP_SERVER_NAME, version: serverVersion },
        },
      });
      negotiatedVersion = selectedProtocolVersion;
      initialized = true;
      return;
    }
    if (method === "notifications/initialized") {
      if (isRequest) {
        sendError(-32600, "notifications/initialized must be a notification", id);
      }
      // Initialization is complete from the client's perspective. Nelos does
      // not initiate requests, so no additional capability state is needed.
      return;
    }
    if (!isRequest) return; // notifications require no response
    if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    if (!initialized || negotiatedVersion === null) {
      sendError(-32002, "server is not initialized", id);
      return;
    }
    if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: listNelosMcpTools() } });
      return;
    }
    if (method === "tools/call") {
      try {
        send({ jsonrpc: "2.0", id, result: await callTool(params) });
      } catch (error) {
        send({
          jsonrpc: "2.0",
          id,
          error: {
            code: error.jsonRpcCode ?? -32603,
            message: error.message,
          },
        });
      }
      return;
    }
    if (method === "resources/list") {
      send({
        jsonrpc: "2.0",
        id,
        result: { resources: listExecutionMapResourcesV1() },
      });
      return;
    }
    if (method === "resources/read") {
      try {
        send({
          jsonrpc: "2.0",
          id,
          result: readExecutionMapResourceV1(params?.uri),
        });
      } catch (error) {
        send({
          jsonrpc: "2.0",
          id,
          error: {
            code: -32602,
            message: error.message,
          },
        });
      }
      return;
    }
    if (method === "resources/templates/list") {
      send({ jsonrpc: "2.0", id, result: { resourceTemplates: [] } });
      return;
    }
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `method not found: ${method}` },
    });
  }

  function validateMessage(message) {
    if (!isObject(message) || message.jsonrpc !== "2.0") {
      return "message must be a JSON-RPC 2.0 object";
    }
    if (Object.hasOwn(message, "id") && !isRequestId(message.id)) {
      return "request id must be a string or integer";
    }
    if (Object.hasOwn(message, "method")) {
      if (typeof message.method !== "string") return "method must be a string";
      if (Object.hasOwn(message, "result") || Object.hasOwn(message, "error")) {
        return "request or notification must not contain response fields";
      }
      if (Object.hasOwn(message, "params") && !isObject(message.params)) {
        return "params must be an object";
      }
      return null;
    }
    const isResult = Object.hasOwn(message, "result");
    const isError = Object.hasOwn(message, "error");
    if (!Object.hasOwn(message, "id") || isResult === isError) {
      return "message is not a request, notification, or response";
    }
    if (isResult && !isObject(message.result)) {
      return "result response is malformed";
    }
    if (
      isError &&
      (!isObject(message.error) ||
        !Number.isInteger(message.error.code) ||
        typeof message.error.message !== "string")
    ) {
      return "error response is malformed";
    }
    return null;
  }

  let buffer = Buffer.alloc(0);
  let discardingOversizedFrame = false;
  let finished = false;
  let processing = Promise.resolve();
  let waitProcessing = Promise.resolve();

  function scheduleError(code, message, id) {
    processing = processing
      .then(() => sendError(code, message, id))
      .catch(() => {
        process.stderr.write("nelos-mcp: error response failed unexpectedly\n");
      });
  }

  function schedule(message) {
    // Responses are only relevant when the server has issued a request. Nelos
    // never does so, and JSON-RPC responses never receive responses themselves.
    if (!Object.hasOwn(message, "method")) return;
    if (
      message.method === "tools/call" &&
      message.params?.name === "nelos_thread_wait"
    ) {
      // A bounded wait may run beside later requests. JSON-RPC permits
      // out-of-order responses, while stateful non-wait operations retain
      // their existing serialized ordering. Waits serialize with each other
      // so their per-call read bounds cannot multiply without limit.
      const waitPrerequisites = Promise.all([processing, waitProcessing]);
      waitProcessing = waitPrerequisites
        .then(
          () => handle(message),
          () => {
            if (Object.hasOwn(message, "id") && isRequestId(message.id)) {
              sendError(-32603, "internal wait scheduling failure", message.id);
            }
          },
        )
        .catch(() => {
          if (Object.hasOwn(message, "id") && isRequestId(message.id)) {
            sendError(-32603, "internal error", message.id);
          }
          process.stderr.write("nelos-mcp: wait request failed unexpectedly\n");
        });
      return;
    }
    processing = processing
      .then(() => handle(message))
      .catch(() => {
        if (Object.hasOwn(message, "id") && isRequestId(message.id)) {
          sendError(-32603, "internal error", message.id);
        }
        process.stderr.write("nelos-mcp: request failed unexpectedly\n");
      });
  }

  function acceptFrame(rawFrame) {
    const frame = rawFrame.at(-1) === 0x0d
      ? rawFrame.subarray(0, rawFrame.length - 1)
      : rawFrame;
    if (frame.length > MCP_MAX_MESSAGE_BYTES) {
      scheduleError(-32600, `message exceeds ${MCP_MAX_MESSAGE_BYTES} bytes`);
      return;
    }
    let text;
    try {
      text = UTF8_DECODER.decode(frame);
    } catch {
      scheduleError(-32700, "invalid UTF-8 in stdio frame");
      return;
    }
    if (!text.trim()) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      scheduleError(-32700, "parse error");
      return;
    }
    const validationError = validateMessage(message);
    if (validationError) {
      scheduleError(-32600, validationError, message?.id);
      return;
    }
    schedule(message);
  }

  function finish(code) {
    if (finished) return;
    finished = true;
    Promise.allSettled([processing, waitProcessing])
      .then(() => appServerBridge.close?.())
      .catch((error) => {
        process.stderr.write(
          `nelos-mcp: shutdown cleanup failed: ${error.message}\n`,
        );
      })
      .then(() => onExit(code));
  }

  input.on("data", (chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    buffer = buffer.length === 0 ? bytes : Buffer.concat([buffer, bytes]);
    let newline;
    while ((newline = buffer.indexOf(0x0a)) !== -1) {
      const frame = buffer.subarray(0, newline);
      buffer = buffer.subarray(newline + 1);
      if (discardingOversizedFrame) {
        discardingOversizedFrame = false;
        continue;
      }
      acceptFrame(frame);
    }
    if (discardingOversizedFrame) {
      buffer = Buffer.alloc(0);
    } else if (buffer.length > MCP_MAX_MESSAGE_BYTES) {
      buffer = Buffer.alloc(0);
      discardingOversizedFrame = true;
      scheduleError(-32600, `message exceeds ${MCP_MAX_MESSAGE_BYTES} bytes`);
    }
  });
  input.on("end", () => {
    if (!discardingOversizedFrame && buffer.length > 0) {
      scheduleError(-32700, "incomplete stdio frame");
    }
    buffer = Buffer.alloc(0);
    discardingOversizedFrame = false;
    finish(0);
  });
  input.on("error", (error) => {
    process.stderr.write(`nelos-mcp: input failed: ${error.message}\n`);
    finish(1);
  });
}
