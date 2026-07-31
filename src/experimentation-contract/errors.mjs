const DEFAULT_PATH = "";
const MAX_MESSAGE_LENGTH = 256;
const MAX_DETAIL_KEYS = 16;
const MAX_DETAIL_STRING_LENGTH = 128;

export const CONTRACT_ERROR_CODES_V1 = Object.freeze({
  ACCESSOR_PROPERTY: "ACCESSOR_PROPERTY",
  CYCLIC_VALUE: "CYCLIC_VALUE",
  DUPLICATE_IDENTITY: "DUPLICATE_IDENTITY",
  DUPLICATE_OBJECT_KEY: "DUPLICATE_OBJECT_KEY",
  IDENTITY_PROJECTION_FAILED: "IDENTITY_PROJECTION_FAILED",
  IDENTITY_PROJECTION_REQUIRED: "IDENTITY_PROJECTION_REQUIRED",
  INVALID_DIGEST: "INVALID_DIGEST",
  INVALID_DIGEST_INPUT: "INVALID_DIGEST_INPUT",
  INVALID_ENUM: "INVALID_ENUM",
  INVALID_FORMAT: "INVALID_FORMAT",
  INVALID_IDENTITY_PROJECTION: "INVALID_IDENTITY_PROJECTION",
  INVALID_IDENTITY_SOURCE: "INVALID_IDENTITY_SOURCE",
  INVALID_JSON_SYNTAX: "INVALID_JSON_SYNTAX",
  INVALID_LINEAGE: "INVALID_LINEAGE",
  INVALID_REVISION: "INVALID_REVISION",
  INVALID_SCHEMA_VERSION: "INVALID_SCHEMA_VERSION",
  INVALID_TYPE: "INVALID_TYPE",
  INVALID_UNICODE: "INVALID_UNICODE",
  INVALID_UTF8: "INVALID_UTF8",
  MISSING_IDENTITY_FIELD: "MISSING_IDENTITY_FIELD",
  NON_CANONICAL_JSON: "NON_CANONICAL_JSON",
  NON_CANONICAL_NUMBER: "NON_CANONICAL_NUMBER",
  NON_FINITE_NUMBER: "NON_FINITE_NUMBER",
  OUT_OF_BOUNDS: "OUT_OF_BOUNDS",
  REPEATED_REFERENCE: "REPEATED_REFERENCE",
  REQUIRED_FIELD: "REQUIRED_FIELD",
  REVISION_DIGEST_MISMATCH: "REVISION_DIGEST_MISMATCH",
  REVISION_DIGEST_UNCHANGED: "REVISION_DIGEST_UNCHANGED",
  REVISION_WITHOUT_SEMANTIC_CHANGE: "REVISION_WITHOUT_SEMANTIC_CHANGE",
  RECORD_NOT_SEALED: "RECORD_NOT_SEALED",
  SPARSE_ARRAY: "SPARSE_ARRAY",
  TERMINAL_TRANSITION: "TERMINAL_TRANSITION",
  TRAILING_DATA: "TRAILING_DATA",
  UNKNOWN_FIELD: "UNKNOWN_FIELD",
  UNKNOWN_LIFECYCLE_STATE: "UNKNOWN_LIFECYCLE_STATE",
  UNSAFE_INTEGER: "UNSAFE_INTEGER",
  UNSUPPORTED_ARRAY_PROPERTY: "UNSUPPORTED_ARRAY_PROPERTY",
  UNSUPPORTED_JSON_OBJECT: "UNSUPPORTED_JSON_OBJECT",
  UNSUPPORTED_JSON_PROPERTY: "UNSUPPORTED_JSON_PROPERTY",
  UNSUPPORTED_JSON_TYPE: "UNSUPPORTED_JSON_TYPE",
  UNSUPPORTED_SCHEMA_VERSION: "UNSUPPORTED_SCHEMA_VERSION",
  UTF8_BOM: "UTF8_BOM",
  UNAUTHORIZED_TRANSITION: "UNAUTHORIZED_TRANSITION",
});

export const LEGACY_CONTRACT_ERROR_CODE_MAP = Object.freeze(
  Object.fromEntries(
    Object.values(CONTRACT_ERROR_CODES_V1).map((code) => [
      code.toLowerCase(),
      code,
    ]),
  ),
);

function normalizeDetails(details) {
  if (details === undefined || details === null) return null;
  if (
    typeof details !== "object" ||
    Array.isArray(details) ||
    Object.keys(details).length > MAX_DETAIL_KEYS
  ) {
    throw new TypeError("contract error details must be a bounded object");
  }
  const normalized = {};
  for (const [key, value] of Object.entries(details)) {
    if (
      key.length === 0 ||
      key.length > 64 ||
      !(
        value === null ||
        typeof value === "boolean" ||
        (typeof value === "number" && Number.isFinite(value)) ||
        (typeof value === "string" && value.length <= MAX_DETAIL_STRING_LENGTH)
      )
    ) {
      throw new TypeError("contract error details contain an unbounded value");
    }
    normalized[key] = value;
  }
  return Object.freeze(normalized);
}

/**
 * A stable, non-sensitive failure returned by the experimentation contracts.
 */
export class ContractError extends Error {
  constructor({
    code,
    path = DEFAULT_PATH,
    contractKind,
    schemaVersion = null,
    message,
    details = null,
  }) {
    if (
      !Object.values(CONTRACT_ERROR_CODES_V1).includes(code) ||
      typeof path !== "string" ||
      (path !== "" && !path.startsWith("/")) ||
      typeof contractKind !== "string" ||
      contractKind.length === 0 ||
      typeof message !== "string" ||
      message.length === 0 ||
      message.length > MAX_MESSAGE_LENGTH
    ) {
      throw new TypeError("contract error fields are invalid");
    }
    super(message);
    const fields = {
      name: "ContractError",
      code,
      path,
      contractKind,
      schemaVersion,
      message,
      details: normalizeDetails(details),
    };
    for (const [key, value] of Object.entries(fields)) {
      Object.defineProperty(this, key, {
        value,
        enumerable: true,
        configurable: false,
        writable: false,
      });
    }
    Object.freeze(this);
  }

  toJSON() {
    return {
      code: this.code,
      path: this.path,
      contractKind: this.contractKind,
      schemaVersion: this.schemaVersion,
      message: this.message,
      details: this.details,
    };
  }
}

export function contractFailure(
  code,
  message,
  {
    path = DEFAULT_PATH,
    contractKind = "contract",
    schemaVersion = null,
    details,
  } = {},
) {
  const normalizedCode = LEGACY_CONTRACT_ERROR_CODE_MAP[code] ?? code;
  throw new ContractError({
    code: normalizedCode,
    path,
    contractKind,
    schemaVersion,
    message,
    details,
  });
}

export function errorContext(options = {}) {
  return {
    contractKind: options.contractKind ?? "contract",
    schemaVersion: options.schemaVersion ?? null,
  };
}
