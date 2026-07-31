import { SHA256_PATTERN } from "./identity.mjs";
import { contractFailure, errorContext } from "./errors.mjs";
import { appendJsonPointer } from "./canonical-json.mjs";

function context(options) {
  return {
    path: options.path ?? "",
    ...errorContext(options),
  };
}

export function assertClosedObject(value, fields, options = {}) {
  const ctx = context(options);
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype &&
    Object.getPrototypeOf(value) !== null
  ) {
    contractFailure("invalid_type", "value must be a plain object", ctx);
  }
  const allowed = fields instanceof Set ? fields : new Set(fields);
  for (const field of Object.keys(value)) {
    if (!allowed.has(field)) {
      contractFailure("unknown_field", "field is not allowed by this contract", {
        ...ctx,
        path: appendJsonPointer(ctx.path, field),
      });
    }
  }
  return value;
}

export function assertRequired(value, fields, options = {}) {
  const ctx = context(options);
  for (const field of fields) {
    if (!Object.hasOwn(value, field)) {
      contractFailure("required_field", "required field is missing", {
        ...ctx,
        path: appendJsonPointer(ctx.path, field),
      });
    }
  }
  return value;
}

export function assertString(
  value,
  { minLength = 0, maxLength = 4096, pattern, ...options } = {},
) {
  const ctx = context(options);
  if (typeof value !== "string") {
    contractFailure("invalid_type", "value must be a string", ctx);
  }
  if (value.length < minLength || value.length > maxLength) {
    contractFailure(
      "out_of_bounds",
      `string length must be between ${minLength} and ${maxLength}`,
      ctx,
    );
  }
  if (pattern && !pattern.test(value)) {
    contractFailure("invalid_format", "string does not match the required format", ctx);
  }
  return value;
}

export function assertInteger(
  value,
  { minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER, ...options } = {},
) {
  const ctx = context(options);
  if (!Number.isSafeInteger(value)) {
    contractFailure("invalid_type", "value must be a safe integer", ctx);
  }
  if (value < minimum || value > maximum) {
    contractFailure(
      "out_of_bounds",
      `integer must be between ${minimum} and ${maximum}`,
      ctx,
    );
  }
  return value;
}

export function assertNumber(
  value,
  { minimum = -Number.MAX_VALUE, maximum = Number.MAX_VALUE, ...options } = {},
) {
  const ctx = context(options);
  if (typeof value !== "number" || !Number.isFinite(value) || Object.is(value, -0)) {
    contractFailure(
      "invalid_type",
      "value must be a finite canonical number",
      ctx,
    );
  }
  if (value < minimum || value > maximum) {
    contractFailure(
      "out_of_bounds",
      `number must be between ${minimum} and ${maximum}`,
      ctx,
    );
  }
  return value;
}

export function assertEnum(value, allowed, options = {}) {
  const ctx = context(options);
  if (!allowed.includes(value)) {
    contractFailure(
      "invalid_enum",
      `value must be one of: ${allowed.join(", ")}`,
      ctx,
    );
  }
  return value;
}

export function assertArray(
  value,
  { minItems = 0, maxItems = 1024, ...options } = {},
) {
  const ctx = context(options);
  if (!Array.isArray(value)) {
    contractFailure("invalid_type", "value must be an array", ctx);
  }
  if (value.length < minItems || value.length > maxItems) {
    contractFailure(
      "out_of_bounds",
      `array length must be between ${minItems} and ${maxItems}`,
      ctx,
    );
  }
  return value;
}

export function assertDigest(value, options = {}) {
  const ctx = context(options);
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    contractFailure(
      "invalid_digest",
      "digest must use sha256 followed by 64 lowercase hexadecimal characters",
      ctx,
    );
  }
  return value;
}

export function assertUniqueIdentities(
  values,
  identity = (value) => value,
  options = {},
) {
  const ctx = context(options);
  assertArray(values, options);
  const seen = new Set();
  for (let index = 0; index < values.length; index += 1) {
    let id;
    try {
      id = identity(values[index], index);
    } catch {
      contractFailure(
        "identity_projection_failed",
        "identity projection could not be evaluated",
        { ...ctx, path: appendJsonPointer(ctx.path, index) },
      );
    }
    if (seen.has(id)) {
      contractFailure("duplicate_identity", "identity must be unique", {
        ...ctx,
        path: appendJsonPointer(ctx.path, index),
      });
    }
    seen.add(id);
  }
  return values;
}

export function createVersionDispatcher({ contractKind, versions }) {
  const validators =
    versions instanceof Map
      ? new Map(versions)
      : new Map(Object.entries(versions).map(([version, validator]) => [
          Number(version),
          validator,
        ]));
  if (
    typeof contractKind !== "string" ||
    contractKind.length === 0 ||
    validators.size === 0 ||
    [...validators].some(
      ([version, validator]) =>
        !Number.isSafeInteger(version) ||
        version < 1 ||
        typeof validator !== "function",
    )
  ) {
    throw new TypeError("version dispatcher configuration is invalid");
  }

  return function validateVersioned(value) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      contractFailure("invalid_type", "contract must be a plain object", {
        path: "",
        contractKind,
      });
    }
    if (!Object.hasOwn(value, "schemaVersion")) {
      contractFailure("required_field", "required field is missing", {
        path: "/schemaVersion",
        contractKind,
      });
    }
    const schemaVersion = value.schemaVersion;
    if (!Number.isSafeInteger(schemaVersion)) {
      contractFailure(
        "invalid_schema_version",
        "schemaVersion must be a positive integer",
        { path: "/schemaVersion", contractKind },
      );
    }
    const validator = validators.get(schemaVersion);
    if (!validator) {
      contractFailure(
        "unsupported_schema_version",
        "schemaVersion is not supported; explicit migration is required",
        {
          path: "/schemaVersion",
          contractKind,
          schemaVersion,
        },
      );
    }
    return validator(value, { contractKind, schemaVersion });
  };
}

export const versionedValidator = createVersionDispatcher;
