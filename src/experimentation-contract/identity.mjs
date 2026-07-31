import { createHash } from "node:crypto";

import { appendJsonPointer, canonicalBytes } from "./canonical-json.mjs";
import { contractFailure, errorContext } from "./errors.mjs";

export const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;

export function sha256Bytes(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    contractFailure("invalid_digest_input", "digest input must be bytes", {
      path: "",
      contractKind: "identity",
    });
  }
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function canonicalDigest(value, options = {}) {
  return sha256Bytes(canonicalBytes(value, options));
}

function projectionFromFields(value, fields, options) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    contractFailure("invalid_identity_source", "identity source must be an object", {
      path: "",
      ...errorContext(options),
    });
  }

  const projection = {};
  for (const field of fields) {
    if (typeof field !== "string" || field.length === 0) {
      contractFailure(
        "invalid_identity_projection",
        "identity projection fields must be non-empty strings",
        { path: "", ...errorContext(options) },
      );
    }
    if (!Object.hasOwn(value, field)) {
      contractFailure(
        "missing_identity_field",
        "identity source is missing a projected field",
        { path: appendJsonPointer("", field), ...errorContext(options) },
      );
    }
    projection[field] = value[field];
  }
  return projection;
}

/**
 * Derive an identity only from caller-selected material.
 *
 * projection may be a function returning JSON identity material, an array of
 * top-level field names, or already-built identity material.
 */
export function deriveIdentity(value, projection, options = {}) {
  if (projection === undefined || projection === null) {
    contractFailure(
      "identity_projection_required",
      "an explicit identity projection is required",
      { path: "", ...errorContext(options) },
    );
  }

  let material;
  if (typeof projection === "function") {
    try {
      material = projection(value);
    } catch {
      contractFailure(
        "identity_projection_failed",
        "identity projection could not be evaluated",
        { path: "", ...errorContext(options) },
      );
    }
  } else if (Array.isArray(projection)) {
    material = projectionFromFields(value, projection, options);
  } else {
    material = projection;
  }

  return canonicalDigest(material, options);
}

export const digestCanonical = canonicalDigest;
