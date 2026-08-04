import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROVENANCE_FILENAME,
  SOURCE_REPOSITORY,
  computeDistributionIntegrity,
  findPluginProvenance,
  pluginCacheIdentity,
  selectPluginProvenance,
  validateProvenance,
} from "./distribution-provenance.mjs";

// Runtime generation identity for a loaded Nelos MCP worker, per issue #88.
//
// A worker keeps serving from the JavaScript it imported at bootstrap even
// after the plugin cache underneath it has been replaced by a newer release.
// The identity derived here is captured once, from the bytes that were actually
// imported, and is compared against the currently installed plugin on demand.
// Neither the environment-provided version nor the self-reported MCP
// `serverInfo.version` is authoritative on its own: both travel with the old
// worker and would agree with themselves forever.
//
// This module is read-only, offline, and deterministic. It never signals a
// sibling process and never mutates installed state.

export const RUNTIME_HEALTH_STATES = Object.freeze([
  "healthy",
  "degraded",
  "restart-required",
  "ambiguous-install",
  "integrity-failure",
]);

// States in which a worker may still begin a new durable mutation. `degraded`
// is permissive on purpose: it means the installed generation could not be
// determined at all (a source checkout, or a host with no plugin cache), which
// is not evidence of staleness. The fence in #91 consumes this field; failing
// closed on absence would brick every non-plugin install.
const MUTABLE_STATES = new Set(["healthy", "degraded"]);

const RECOVERY_BY_STATE = Object.freeze({
  healthy: "None required.",
  degraded:
    "No installed Nelos plugin was found to compare against. If this host " +
    "runs the marketplace plugin, reinstall it; a source checkout needs no action.",
  "restart-required":
    "Quit and relaunch Codex, then open a fresh task.",
  "ambiguous-install":
    "Keep exactly one installed Nelos plugin copy, then quit and relaunch " +
    "Codex and open a fresh task.",
  "integrity-failure":
    "Reinstall the Nelos plugin from a trusted release, then quit and " +
    "relaunch Codex and open a fresh task.",
});

const DEFAULT_MODULE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export class RuntimeIdentityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RuntimeIdentityError";
    this.code = code;
  }
}

async function readJsonIfPresent(path) {
  let text;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new RuntimeIdentityError(
      "IDENTITY_SOURCE_UNREADABLE",
      `invalid JSON at ${path}: ${error.message}`,
    );
  }
}

/**
 * Collapse the identity-defining fields into one comparable token.
 *
 * Derived from the provenance that ships inside the distribution rather than
 * stamped separately at release time, so it adds no information that
 * `sourceRevision` and `integrity` do not already carry. Its value is that a
 * single opaque string can be compared and logged without callers re-deriving
 * the precedence between semver, commit, and digest.
 */
export function deriveBuildIdentityV1({
  version,
  sourceRevision = null,
  sourceRevisionType = null,
  integrity = null,
  cacheIdentity = null,
} = {}) {
  // A JSON array is an unambiguous encoding: no separator character is
  // needed, and no field value can straddle a boundary into the next.
  const hash = createHash("sha256").update(JSON.stringify([
    version ?? null,
    sourceRevision ?? null,
    sourceRevisionType ?? null,
    integrity ?? null,
    cacheIdentity ?? null,
  ]));
  return `nelos-build:${hash.digest("hex").slice(0, 32)}`;
}

/**
 * Read and cross-validate the five identity sources under `moduleRoot`.
 *
 * Throws `RuntimeIdentityError` when the sources disagree, so a caller can
 * refuse to import a server whose manifest, package, and provenance describe
 * different releases.
 */
export async function deriveRuntimeIdentityV1({
  moduleRoot = DEFAULT_MODULE_ROOT,
  declaredVersion = null,
} = {}) {
  const root = resolve(moduleRoot);
  const [packageJson, pluginManifest, mcpConfig, provenanceRaw] =
    await Promise.all([
      readJsonIfPresent(join(root, "package.json")),
      readJsonIfPresent(join(root, ".codex-plugin", "plugin.json")),
      readJsonIfPresent(join(root, ".mcp.json")),
      readJsonIfPresent(join(root, PROVENANCE_FILENAME)),
    ]);

  if (!packageJson) {
    throw new RuntimeIdentityError(
      "IDENTITY_SOURCE_MISSING",
      `package.json is missing under ${root}`,
    );
  }
  if (!pluginManifest) {
    throw new RuntimeIdentityError(
      "IDENTITY_SOURCE_MISSING",
      `.codex-plugin/plugin.json is missing under ${root}`,
    );
  }
  if (!provenanceRaw) {
    throw new RuntimeIdentityError(
      "IDENTITY_SOURCE_MISSING",
      `${PROVENANCE_FILENAME} is missing under ${root}`,
    );
  }

  let provenance;
  try {
    provenance = validateProvenance(provenanceRaw, join(root, PROVENANCE_FILENAME));
  } catch (error) {
    throw new RuntimeIdentityError("IDENTITY_INVALID_PROVENANCE", error.message);
  }

  // Every source that carries a version must name the same release. A missing
  // source is tolerated (a packed distribution need not ship `.mcp.json`); a
  // present source that disagrees is not.
  const observed = [
    { source: "package.json", version: packageJson.version ?? null },
    { source: ".codex-plugin/plugin.json", version: pluginManifest?.version ?? null },
    {
      source: ".mcp.json",
      version: mcpConfig?.mcpServers?.nelos?.env?.NELOS_PLUGIN_VERSION ?? null,
    },
    { source: PROVENANCE_FILENAME, version: provenance.revision },
    ...(declaredVersion === null
      ? []
      : [{ source: "bootstrap", version: declaredVersion }]),
  ].filter(({ version }) => version !== null);

  const versions = [...new Set(observed.map(({ version }) => version))];
  if (versions.length !== 1) {
    const detail = observed
      .map(({ source, version }) => `${source}=${version}`)
      .join(", ");
    throw new RuntimeIdentityError(
      "IDENTITY_SOURCES_DISAGREE",
      `identity sources disagree on the loaded release: ${detail}`,
    );
  }
  const version = versions[0];

  const embeddedBuildIdentity = pluginManifest.releaseBuildIdentity ?? null;
  const mcpBuildIdentity =
    mcpConfig?.mcpServers?.nelos?.env?.NELOS_RELEASE_BUILD_IDENTITY ?? null;
  if (
    typeof embeddedBuildIdentity !== "string" ||
    !/^nelos-release-v1:\d+\.\d+\.\d+(?:\+codex\.[a-z0-9-]+)?$/u.test(embeddedBuildIdentity) ||
    embeddedBuildIdentity !== mcpBuildIdentity ||
    embeddedBuildIdentity !== `nelos-release-v1:${version}`
  ) {
    throw new RuntimeIdentityError(
      "IDENTITY_SOURCES_DISAGREE",
      "embedded release-time build identity disagrees between .codex-plugin/plugin.json, .mcp.json, and the release version",
    );
  }

  // `cacheIdentity` is optional in the schema, but when present it must be the
  // canonical form for this exact version. `validateProvenance` already checks
  // this; recomputing here keeps the failure attributable to identity rather
  // than to a generic provenance read.
  const expectedCacheIdentity = pluginCacheIdentity({
    sourceRepository: provenance.sourceRepository ?? SOURCE_REPOSITORY,
    version,
  });
  if (
    provenance.cacheIdentity !== undefined &&
    provenance.cacheIdentity !== expectedCacheIdentity
  ) {
    throw new RuntimeIdentityError(
      "IDENTITY_SOURCES_DISAGREE",
      `cache identity ${provenance.cacheIdentity} does not match ${expectedCacheIdentity}`,
    );
  }

  const identity = {
    version,
    sourceRepository: provenance.sourceRepository ?? SOURCE_REPOSITORY,
    // Absent in a source checkout; only release builds stamp a commit. Callers
    // must treat a null revision as "cannot prove exactness", never as a match.
    sourceRevision: provenance.sourceRevision ?? null,
    sourceRevisionType: provenance.sourceRevisionType ?? null,
    integrity: provenance.integrity ?? null,
    skillIntegrity: provenance.skillIntegrity ?? null,
    cacheIdentity: provenance.cacheIdentity ?? expectedCacheIdentity,
    modulePath: root,
    embeddedBuildIdentity,
  };
  identity.buildIdentity = deriveBuildIdentityV1({
    ...identity,
    releaseBuildIdentity: embeddedBuildIdentity,
  });
  return Object.freeze(identity);
}

function comparableIdentity(identity) {
  if (!identity) return null;
  return {
    version: identity.version ?? null,
    sourceRevision: identity.sourceRevision ?? null,
    integrity: identity.integrity ?? null,
  };
}

/**
 * Decide whether two identities describe the same generation.
 *
 * Exactness is required where it is available: when both sides carry a source
 * revision or an integrity digest, those must match, and a semver match alone
 * never substitutes for them. When only one side carries the stronger field the
 * comparison is inconclusive rather than equal.
 */
export function compareRuntimeIdentitiesV1(loaded, installed) {
  const left = comparableIdentity(loaded);
  const right = comparableIdentity(installed);
  if (!left || !right) return "indeterminate";
  if (left.version !== right.version) return "mismatch";
  if (left.sourceRevision !== null && right.sourceRevision !== null) {
    if (left.sourceRevision !== right.sourceRevision) return "mismatch";
    if (left.integrity !== null && right.integrity !== null) {
      return left.integrity === right.integrity ? "match" : "mismatch";
    }
    return "match";
  }
  if (left.integrity !== null && right.integrity !== null) {
    return left.integrity === right.integrity ? "match" : "mismatch";
  }
  // Same version, but at least one side carries no exact field to confirm it
  // with. That is not proof of the same generation and not evidence of a stale
  // one either, so it is reported separately from both.
  return "indeterminate";
}

export function runtimeIdentitiesMatchV1(loaded, installed) {
  return compareRuntimeIdentitiesV1(loaded, installed) === "match";
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return false;
    throw error;
  }
}

/**
 * Resolve the currently installed Nelos generation from the plugin cache.
 *
 * Returns `{ identity, ambiguous, detail }`. A host with no plugin cache yields
 * a null identity without error: that is a source checkout, not a fault.
 */
export async function resolveInstalledIdentityV1({
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
  findProvenance = findPluginProvenance,
} = {}) {
  let matches;
  try {
    matches = await findProvenance(codexHome);
  } catch (error) {
    return { identity: null, ambiguous: false, detail: error.message };
  }
  if (!matches || matches.length === 0) {
    return { identity: null, identities: [], ambiguous: false, detail: null };
  }
  const identities = matches
    .filter(({ provenance }) => provenance)
    .map(({ provenance, path }) => {
      const identity = {
        version: provenance.revision,
        sourceRepository: provenance.sourceRepository ?? SOURCE_REPOSITORY,
        sourceRevision: provenance.sourceRevision ?? null,
        sourceRevisionType: provenance.sourceRevisionType ?? null,
        integrity: provenance.integrity ?? null,
        skillIntegrity: provenance.skillIntegrity ?? null,
        cacheIdentity: provenance.cacheIdentity ?? null,
        modulePath: dirname(path),
      };
      identity.buildIdentity = deriveBuildIdentityV1(identity);
      return Object.freeze(identity);
    });
  const selected = selectPluginProvenance(matches);
  if (!selected || selected.installed === "ambiguous") {
    return {
      identity: null,
      identities,
      ambiguous: true,
      detail: selected?.error ?? "multiple installed Nelos plugins",
    };
  }
  if (!selected.provenance) {
    return {
      identity: null,
      identities: [],
      ambiguous: false,
      detail: selected.error ?? `unreadable provenance at ${selected.path}`,
    };
  }
  const identity = identities.find(({ modulePath }) =>
    modulePath === dirname(selected.path)
  );
  return {
    identity,
    identities: [identity],
    ambiguous: false,
    detail: null,
    activeVersions: [
      ...new Set(
        matches
          .map(({ provenance: candidate }) => candidate?.revision)
          .filter((value) => typeof value === "string"),
      ),
    ].sort(),
  };
}

/**
 * Compare a worker's boot identity against the installed generation.
 *
 * Remains callable when the backing cache path has been deleted underneath the
 * worker: that condition is exactly what this reports, so it must not throw.
 * `verifyIntegrity` recomputes the distribution digest, which walks the whole
 * distribution and is therefore opt-in rather than run at every bootstrap.
 */
export async function resolveRuntimeHealthV1({
  loaded,
  identityError = null,
  codexHome = process.env.CODEX_HOME || join(homedir(), ".codex"),
  findProvenance = findPluginProvenance,
  verifyIntegrity = false,
  computeIntegrity = computeDistributionIntegrity,
} = {}) {
  if (!loaded) {
    // A worker that could not derive its own identity cannot prove it is
    // current, so it reports the strongest failure rather than a soft state.
    return {
      state: "integrity-failure",
      loaded: null,
      installed: null,
      installedIdentities: [],
      activeVersions: [],
      backingPathPresent: false,
      mutationAllowed: false,
      detail:
        identityError?.message ?? "the worker has no derived runtime identity",
      ...(identityError?.code ? { code: identityError.code } : {}),
      recovery: RECOVERY_BY_STATE["integrity-failure"],
    };
  }

  let backingPathPresent = false;
  let integrityDetail = null;
  let integrityFailed = false;
  try {
    backingPathPresent = await pathExists(loaded.modulePath);
  } catch (error) {
    integrityFailed = true;
    integrityDetail =
      `the loaded distribution path could not be verified: ${error.message}`;
  }
  if (verifyIntegrity && backingPathPresent && loaded.integrity) {
    try {
      const recomputed = await computeIntegrity(loaded.modulePath, {
        allowLegacyWithoutCorpus: true,
      });
      if (recomputed !== loaded.integrity) {
        integrityFailed = true;
        integrityDetail =
          `loaded distribution digest ${recomputed} does not match the ` +
          `recorded ${loaded.integrity}`;
      }
    } catch (error) {
      integrityFailed = true;
      integrityDetail = `distribution digest could not be recomputed: ${error.message}`;
    }
  }

  const installedResult = await resolveInstalledIdentityV1({
    codexHome,
    findProvenance,
  });
  const installed = installedResult.identity;
  const installedIdentities = installedResult.identities ?? [];
  const activeVersions = [
    ...new Set([
      loaded.version,
      ...(installedResult.activeVersions ?? []),
    ].filter((value) => typeof value === "string")),
  ].sort();

  let state;
  let detail = integrityDetail;
  if (integrityFailed) {
    state = "integrity-failure";
  } else if (installedResult.ambiguous) {
    state = "ambiguous-install";
    detail = installedResult.detail;
  } else if (!installed) {
    // No installed plugin to compare against. If the worker's own backing path
    // is also gone it was certainly replaced; otherwise this is a checkout.
    state = backingPathPresent ? "degraded" : "restart-required";
    detail =
      installedResult.detail ??
      (backingPathPresent
        ? "no installed Nelos plugin was found to compare against"
        : "the loaded plugin path no longer exists and no installed plugin was found");
  } else if (!backingPathPresent) {
    state = "restart-required";
    detail = `the loaded plugin path ${loaded.modulePath} no longer exists`;
  } else {
    // Only a proven mismatch denies mutation. Inability to prove a match is
    // reported as degraded: a version string alone never establishes the same
    // generation, but it is not evidence of a stale one either.
    const comparison = compareRuntimeIdentitiesV1(loaded, installed);
    if (comparison === "match") {
      state = "healthy";
    } else if (comparison === "indeterminate") {
      state = "degraded";
      detail =
        "the loaded and installed records do not both carry a source " +
        "revision or integrity digest, so the loaded generation cannot be " +
        "proven exact from the version alone";
    } else {
      state = "restart-required";
      detail =
        `loaded ${loaded.version} (${loaded.sourceRevision ?? "no revision"}) ` +
        `does not match installed ${installed.version} ` +
        `(${installed.sourceRevision ?? "no revision"})`;
    }
  }

  return {
    state,
    loaded: {
      version: loaded.version,
      sourceRevision: loaded.sourceRevision,
      integrity: loaded.integrity,
      buildIdentity: loaded.buildIdentity,
      modulePath: loaded.modulePath,
    },
    installed: installed
      ? {
          version: installed.version,
          sourceRevision: installed.sourceRevision,
          integrity: installed.integrity,
          buildIdentity: installed.buildIdentity,
          modulePath: installed.modulePath,
        }
      : null,
    installedIdentities: installedIdentities.map((identity) => ({
      version: identity.version,
      sourceRevision: identity.sourceRevision,
      integrity: identity.integrity,
      buildIdentity: identity.buildIdentity,
      modulePath: identity.modulePath,
    })),
    activeVersions,
    backingPathPresent,
    mutationAllowed: MUTABLE_STATES.has(state),
    ...(detail ? { detail } : {}),
    recovery: RECOVERY_BY_STATE[state],
  };
}
