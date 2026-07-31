import { appendJsonPointer, canonicalBytes } from "./canonical-json.mjs";
import {
  SHA256_PATTERN,
  canonicalDigest,
  deriveIdentity,
} from "./identity.mjs";
import { contractFailure, errorContext } from "./errors.mjs";

function deepClone(value) {
  return structuredClone(value);
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

export function sealRecord(record, options = {}) {
  if (
    record === null ||
    typeof record !== "object" ||
    Array.isArray(record) ||
    Object.getPrototypeOf(record) !== Object.prototype &&
    Object.getPrototypeOf(record) !== null
  ) {
    contractFailure("invalid_type", "record must be a plain object", {
      path: "",
      ...errorContext(options),
    });
  }
  // Validate before cloning so accessors, cycles, and non-JSON values fail
  // without being evaluated or admitted to an immutable contract record.
  canonicalBytes(record, options);
  return deepFreeze(deepClone(record));
}

function revisionMaterial(record, options) {
  const {
    revisionField = "revision",
    digestField = "digest",
    previousDigestField = "previousDigest",
  } = options;
  const material = { ...record };
  delete material[revisionField];
  delete material[digestField];
  delete material[previousDigestField];
  return material;
}

/**
 * Create an immutable successor while retaining the predecessor digest.
 */
export function reviseRecord(previous, update, options = {}) {
  const {
    revisionField = "revision",
    digestField = "digest",
    previousDigestField = "previousDigest",
    identityProjection = (value) => revisionMaterial(value, options),
  } = options;
  const ctx = errorContext(options);

  if (!Object.isFrozen(previous)) {
    contractFailure(
      "record_not_sealed",
      "the prior record must be sealed before it can be revised",
      { path: "", ...ctx },
    );
  }
  if (!Number.isSafeInteger(previous[revisionField]) || previous[revisionField] < 1) {
    contractFailure("invalid_revision", "prior revision must be a positive integer", {
      path: appendJsonPointer("", revisionField),
      ...ctx,
    });
  }
  if (
    typeof previous[digestField] !== "string" ||
    !SHA256_PATTERN.test(previous[digestField])
  ) {
    contractFailure("invalid_digest", "prior record digest is required", {
      path: appendJsonPointer("", digestField),
      ...ctx,
    });
  }
  const expectedPreviousDigest = canonicalDigest(
    revisionMaterial(previous, options),
    options,
  );
  if (previous[digestField] !== expectedPreviousDigest) {
    contractFailure(
      "revision_digest_mismatch",
      "prior record digest is invalid",
      { path: appendJsonPointer("", digestField), ...ctx },
    );
  }

  const changes =
    typeof update === "function" ? update(deepClone(previous)) : update;
  if (
    changes === null ||
    typeof changes !== "object" ||
    Array.isArray(changes)
  ) {
    contractFailure("invalid_revision", "revision update must be an object", {
      path: "",
      ...ctx,
    });
  }

  const candidate = {
    ...deepClone(previous),
    ...deepClone(changes),
    [revisionField]: previous[revisionField] + 1,
    [previousDigestField]: previous[digestField],
  };
  delete candidate[digestField];

  const oldIdentity = deriveIdentity(previous, identityProjection, options);
  const newIdentity = deriveIdentity(candidate, identityProjection, options);
  if (oldIdentity === newIdentity) {
    contractFailure(
      "revision_without_semantic_change",
      "a new revision requires a semantic identity change",
      { path: "", ...ctx },
    );
  }

  candidate[digestField] = canonicalDigest(revisionMaterial(candidate, options), options);
  if (candidate[digestField] === previous[digestField]) {
    contractFailure(
      "revision_digest_unchanged",
      "a new revision must have a new digest",
      { path: appendJsonPointer("", digestField), ...ctx },
    );
  }
  return sealRecord(candidate, options);
}

export function verifyRevision(previous, next, options = {}) {
  const {
    revisionField = "revision",
    digestField = "digest",
    previousDigestField = "previousDigest",
    identityProjection = (value) => revisionMaterial(value, options),
  } = options;
  const ctx = errorContext(options);

  if (!Object.isFrozen(previous) || !Object.isFrozen(next)) {
    contractFailure(
      "record_not_sealed",
      "both revision records must be sealed",
      { path: "", ...ctx },
    );
  }
  if (
    previous[digestField] !==
    canonicalDigest(revisionMaterial(previous, options), options)
  ) {
    contractFailure(
      "revision_digest_mismatch",
      "prior record digest is invalid",
      { path: appendJsonPointer("", digestField), ...ctx },
    );
  }
  if (next[revisionField] !== previous[revisionField] + 1) {
    contractFailure(
      "invalid_revision",
      "revision must advance exactly once",
      { path: appendJsonPointer("", revisionField), ...ctx },
    );
  }
  if (next[previousDigestField] !== previous[digestField]) {
    contractFailure(
      "invalid_lineage",
      "revision must reference the prior record digest",
      { path: appendJsonPointer("", previousDigestField), ...ctx },
    );
  }
  if (
    deriveIdentity(previous, identityProjection, options) ===
    deriveIdentity(next, identityProjection, options)
  ) {
    contractFailure(
      "revision_without_semantic_change",
      "a new revision requires a semantic identity change",
      { path: "", ...ctx },
    );
  }
  const expected = canonicalDigest(revisionMaterial(next, options), options);
  if (next[digestField] !== expected) {
    contractFailure("revision_digest_mismatch", "revision digest is invalid", {
      path: appendJsonPointer("", digestField),
      ...ctx,
    });
  }
  return next;
}
