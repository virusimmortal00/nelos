import { createHash } from "node:crypto";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const VMID = /^[1-9][0-9]{2,8}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const STATES = new Set(["active", "cleanup-only", "revoked", "completed"]);

export class ProxmoxLeaseAuthorityError extends Error {
  constructor(code, message, path = null) {
    super(message);
    this.name = "ProxmoxLeaseAuthorityError";
    this.code = code;
    this.path = path;
  }
}

function fail(code, message, path) {
  throw new ProxmoxLeaseAuthorityError(code, message, path);
}

function closed(value, fields, path) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) {
    fail("INVALID_LEASE_AUTHORITY_OBSERVATION", "object fields differ from the closed lease-authority contract", path);
  }
  return value;
}

function integer(value, path, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) fail("INVALID_LEASE_AUTHORITY_OBSERVATION", "integer is outside its bound", path);
  return value;
}

function identity(value, path, pattern = ID) {
  if (typeof value !== "string" || !pattern.test(value)) fail("INVALID_LEASE_AUTHORITY_OBSERVATION", "identity is invalid", path);
  return value;
}

function time(value, path) {
  if (typeof value !== "string" || !UTC.test(value) || !Number.isFinite(Date.parse(value))) {
    fail("INVALID_LEASE_AUTHORITY_OBSERVATION", "timestamp is not millisecond UTC", path);
  }
  return Date.parse(value);
}

function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]));
  }
  return value;
}

export function canonicalLeaseAuthorityBytesV1(value) {
  return Buffer.from(`${JSON.stringify(sortDeep(value))}\n`, "utf8");
}

export function leaseAuthoritySha256V1(value) {
  const bytes = Buffer.isBuffer(value) ? value : canonicalLeaseAuthorityBytesV1(value);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function decodedCanonical(value, record) {
  if (typeof value !== "string" || value.length === 0 || value.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    fail("INVALID_LEASE_AUTHORITY_OBSERVATION", "record bytes are not canonical base64", "/authorityObservation/recordBytesBase64");
  }
  const decoded = Buffer.from(value, "base64");
  const expected = canonicalLeaseAuthorityBytesV1(record);
  try {
    if (decoded.length < 2 || decoded.length > 65_536 || decoded.toString("base64") !== value || !decoded.equals(expected)) {
      fail("LEASE_AUTHORITY_DIGEST_MISMATCH", "record bytes differ from the parsed canonical record", "/authorityObservation/recordBytesBase64");
    }
    return Buffer.from(decoded);
  } finally {
    decoded.fill(0);
    expected.fill(0);
  }
}

function validateRecord(value) {
  closed(value, ["authority", "epoch", "kind", "lease", "previousRecordDigest", "recordDigest", "resource", "revision", "schemaVersion", "state", "transition"], "/authorityObservation/record");
  if (value.schemaVersion !== 1 || value.kind !== "nelos.proxmox-desktop.lease-authority-record.v1" || !STATES.has(value.state)) {
    fail("INVALID_LEASE_AUTHORITY_OBSERVATION", "record kind, schema, or state differs", "/authorityObservation/record");
  }
  closed(value.authority, ["authorityId", "trustDigest"], "/authorityObservation/record/authority");
  identity(value.authority.authorityId, "/authorityObservation/record/authority/authorityId");
  identity(value.authority.trustDigest, "/authorityObservation/record/authority/trustDigest", SHA256);
  closed(value.resource, ["hostId", "providerId", "vmid"], "/authorityObservation/record/resource");
  identity(value.resource.hostId, "/authorityObservation/record/resource/hostId");
  identity(value.resource.providerId, "/authorityObservation/record/resource/providerId");
  identity(value.resource.vmid, "/authorityObservation/record/resource/vmid", VMID);
  closed(value.lease, ["cleanupExpiresAt", "expiresAt", "fencingToken", "holderId", "issuedAt", "leaseId", "runId"], "/authorityObservation/record/lease");
  for (const field of ["fencingToken", "holderId", "leaseId", "runId"]) identity(value.lease[field], `/authorityObservation/record/lease/${field}`);
  const issuedAt = time(value.lease.issuedAt, "/authorityObservation/record/lease/issuedAt");
  const expiresAt = time(value.lease.expiresAt, "/authorityObservation/record/lease/expiresAt");
  const cleanupExpiresAt = time(value.lease.cleanupExpiresAt, "/authorityObservation/record/lease/cleanupExpiresAt");
  if (!(issuedAt < expiresAt && expiresAt <= cleanupExpiresAt)) fail("INVALID_LEASE_AUTHORITY_OBSERVATION", "lease timestamps are not ordered", "/authorityObservation/record/lease");
  integer(value.epoch, "/authorityObservation/record/epoch");
  integer(value.revision, "/authorityObservation/record/revision");
  if (value.previousRecordDigest !== null) identity(value.previousRecordDigest, "/authorityObservation/record/previousRecordDigest", SHA256);
  closed(value.transition, ["at", "operation", "reason"], "/authorityObservation/record/transition");
  time(value.transition.at, "/authorityObservation/record/transition/at");
  if (!["issue", "cleanup-only", "revoke", "complete"].includes(value.transition.operation) || typeof value.transition.reason !== "string" || value.transition.reason.length < 1 || value.transition.reason.length > 256) {
    fail("INVALID_LEASE_AUTHORITY_OBSERVATION", "record transition is invalid", "/authorityObservation/record/transition");
  }
  identity(value.recordDigest, "/authorityObservation/record/recordDigest", SHA256);
  const unsigned = structuredClone(value); delete unsigned.recordDigest;
  if (leaseAuthoritySha256V1(unsigned) !== value.recordDigest) fail("LEASE_AUTHORITY_DIGEST_MISMATCH", "record digest differs", "/authorityObservation/record/recordDigest");
  return value;
}

export function validateLeaseAuthorityObservationV1(value, {
  expected = null,
  maxObservationAgeMs = null,
  requireIssue = false,
  requireState = null,
  now = null,
  marginMs = 0,
} = {}) {
  closed(value, ["authorityId", "kind", "observedAt", "record", "recordBytesBase64", "recordDigest", "recordFileDigest", "resourceKey", "schemaVersion", "trustDigest"], "/authorityObservation");
  if (value.schemaVersion !== 1 || value.kind !== "nelos.proxmox-desktop.lease-authority-observation.v1") {
    fail("INVALID_LEASE_AUTHORITY_OBSERVATION", "observation kind or schema differs", "/authorityObservation");
  }
  identity(value.authorityId, "/authorityObservation/authorityId");
  identity(value.trustDigest, "/authorityObservation/trustDigest", SHA256);
  identity(value.recordDigest, "/authorityObservation/recordDigest", SHA256);
  identity(value.recordFileDigest, "/authorityObservation/recordFileDigest", SHA256);
  const observedAt = time(value.observedAt, "/authorityObservation/observedAt");
  if (typeof value.resourceKey !== "string" || !/^[0-9a-f]{64}$/u.test(value.resourceKey)) fail("INVALID_LEASE_AUTHORITY_OBSERVATION", "resource key is invalid", "/authorityObservation/resourceKey");
  const record = validateRecord(value.record);
  if (observedAt < Date.parse(record.transition.at)) {
    fail("INVALID_LEASE_AUTHORITY_OBSERVATION", "observation predates the authoritative transition", "/authorityObservation/observedAt");
  }
  const bytes = decodedCanonical(value.recordBytesBase64, record);
  try {
    const mismatches = [
      ...(leaseAuthoritySha256V1(bytes) !== value.recordFileDigest ? ["recordBytes"] : []),
      ...(value.recordDigest !== record.recordDigest ? ["recordDigest"] : []),
      ...(value.authorityId !== record.authority.authorityId ? ["authorityId"] : []),
      ...(value.trustDigest !== record.authority.trustDigest ? ["trustDigest"] : []),
      ...(value.resourceKey !== leaseAuthoritySha256V1(record.resource).slice(7) ? ["resourceKey"] : []),
    ];
    if (mismatches.length > 0) {
      fail("LEASE_AUTHORITY_DIGEST_MISMATCH", `observation and authoritative record identities differ: ${mismatches.join(",")}`, "/authorityObservation");
    }
  } finally { bytes.fill(0); }
  if (requireIssue && (record.transition.operation !== "issue" || record.state !== "active")) {
    fail("LEASE_AUTHORITY_NOT_ISSUED", "composition requires the active issue record, not a later transition", "/authorityObservation/record");
  }
  if (requireState !== null && record.state !== requireState) fail("LEASE_AUTHORITY_STATE_MISMATCH", "authority state differs", "/authorityObservation/record/state");
  if (now !== null) {
    integer(now, "/now", 0); integer(marginMs, "/marginMs", 0);
    if (maxObservationAgeMs !== null) {
      integer(maxObservationAgeMs, "/maxObservationAgeMs", 0);
      if (observedAt > now + 5_000 || now - observedAt > maxObservationAgeMs) {
        fail("STALE_LEASE_AUTHORITY_OBSERVATION", "authority observation is outside its freshness window", "/authorityObservation/observedAt");
      }
    }
    const deadline = record.state === "cleanup-only" ? Date.parse(record.lease.cleanupExpiresAt) : Date.parse(record.lease.expiresAt);
    if (record.state !== "active" && record.state !== "cleanup-only") fail("LEASE_MANUAL_RECONCILIATION_REQUIRED", "revoked or completed authority state requires manual reconciliation", "/authorityObservation/record/state");
    if (now + marginMs >= deadline) fail(record.state === "active" ? "LEASE_NOT_ACTIVE" : "CLEANUP_LEASE_EXPIRED", "authority record lacks the required remaining margin", "/authorityObservation/record/lease");
  }
  if (expected !== null) {
    const actual = {
      authorityId: record.authority.authorityId,
      epoch: record.epoch,
      fencingToken: record.lease.fencingToken,
      holderId: record.lease.holderId,
      hostId: record.resource.hostId,
      leaseId: record.lease.leaseId,
      providerId: record.resource.providerId,
      runId: record.lease.runId,
      trustDigest: record.authority.trustDigest,
      vmid: record.resource.vmid,
    };
    for (const [field, expectedValue] of Object.entries(expected)) {
      if (actual[field] !== expectedValue) fail("LEASE_SUPERSEDED", `authority identity differs at ${field}`, `/authorityObservation/record/${field}`);
    }
  }
  return Object.freeze(structuredClone(value));
}

export function leaseAuthorityBindingFromObservationV1(value, options = {}) {
  const observation = validateLeaseAuthorityObservationV1(value, { ...options, requireIssue: true });
  return Object.freeze({
    authorityId: observation.authorityId,
    epoch: observation.record.epoch,
    issuedRecordDigest: observation.recordDigest,
    issuedRecordFileDigest: observation.recordFileDigest,
    issuedRevision: observation.record.revision,
    trustDigest: observation.trustDigest,
  });
}

export function expectedLeaseAuthorityIdentityV1({ authorityBinding, run }) {
  return Object.freeze({
    authorityId: authorityBinding.authorityId,
    epoch: authorityBinding.epoch,
    fencingToken: run.lease.fencingToken,
    holderId: run.lease.holderId,
    hostId: run.provider.hostId,
    leaseId: run.lease.leaseId,
    providerId: run.provider.providerId,
    runId: run.runId,
    trustDigest: authorityBinding.trustDigest,
    vmid: String(run.provider.vmId),
  });
}
