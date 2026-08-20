import { canonicalJsonV1, sha256V1, validateGoldenImageReservationV1 } from "./build-golden-image.mjs";

const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const SSH_FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/u;
const OPERATIONS = new Set(["apply", "confirm-restored", "observe", "preflight", "restore"]);
const MUTATIONS = new Set(["apply", "restore"]);
const HTTPS_HOSTS = Object.freeze(["persistent.oaistatic.com", "snapshot.ubuntu.com"]);

export class GoldenBuilderGatewayPolicyError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "GoldenBuilderGatewayPolicyError";
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details = null) { throw new GoldenBuilderGatewayPolicyError(code, message, details); }
function plain(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, fields, label) {
  if (!plain(value) || Object.keys(value).sort().join("\0") !== [...fields].sort().join("\0")) fail("INVALID_CONTRACT", `${label} fields differ from the closed contract`);
  return value;
}
function iso(value, label) {
  const parsed = Date.parse(value);
  if (typeof value !== "string" || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) fail("INVALID_CONTRACT", `${label} must be canonical ISO time`);
  return parsed;
}
function ipv4(value) {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/u.test(value)) return null;
  const bytes = value.split(".").map(Number);
  return bytes.every((item) => item <= 255) ? bytes : null;
}
function publicIpv4(value) {
  const bytes = ipv4(value);
  if (!bytes) return false;
  const [a, b] = bytes;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 0) ||
    (a === 192 && b === 168) || (a === 198 && [18, 19, 51].includes(b)) || (a === 203 && b === 0));
}

function validateDestination(value, host, policyExpiry, now) {
  exact(value, ["addresses", "expiresAt", "host", "resolvedAt", "ttlSeconds"], `gateway destination ${host}`);
  if (value.host !== host || !Number.isSafeInteger(value.ttlSeconds) || value.ttlSeconds < 30 || value.ttlSeconds > 3_600 ||
      !Array.isArray(value.addresses) || value.addresses.length < 1 || value.addresses.length > 16 ||
      value.addresses.some((address) => !publicIpv4(address)) || [...new Set(value.addresses)].sort().join("\0") !== value.addresses.join("\0")) {
    fail("INVALID_CONTRACT", `${host} resolution is not one sorted public IPv4 set with a bounded TTL`);
  }
  const resolvedAt = iso(value.resolvedAt, `${host}.resolvedAt`); const expiresAt = iso(value.expiresAt, `${host}.expiresAt`);
  if (resolvedAt > now + 1_000 || expiresAt !== resolvedAt + value.ttlSeconds * 1_000 || now >= expiresAt || expiresAt > policyExpiry) {
    fail("GATEWAY_RESOLUTION_EXPIRED", `${host} resolution is stale or outlives the policy`);
  }
  return value;
}

export function createGoldenBuilderGatewayPolicyBindingV1({ reservation: inputReservation, originalRulesetDigest, helperDigest, gatewayConfigDigest, destinations }, { now = Date.now() } = {}) {
  const reservation = validateGoldenImageReservationV1(inputReservation, { now });
  if (!SHA256.test(originalRulesetDigest ?? "") || !SHA256.test(helperDigest ?? "") || !SHA256.test(gatewayConfigDigest ?? "") || !Array.isArray(destinations) || destinations.length !== 2) {
    fail("INVALID_CONTRACT", "gateway ruleset, helper, or destination identity is invalid");
  }
  const policyExpiry = Date.parse(reservation.expiresAt);
  const normalized = HTTPS_HOSTS.map((host) => structuredClone(validateDestination(destinations.find((item) => item?.host === host), host, policyExpiry, now)));
  if (new Set(normalized.flatMap(({ addresses }) => addresses)).size !== normalized.reduce((sum, { addresses }) => sum + addresses.length, 0)) {
    fail("INVALID_CONTRACT", "gateway package-host address sets must be disjoint");
  }
  const unsigned = {
    schemaVersion: 1,
    kind: "nelos-golden-builder-gateway-policy",
    reservationDigest: sha256V1(reservation),
    buildNonce: reservation.buildNonce,
    expiresAt: reservation.expiresAt,
    gateway: { providerId: "proxmox-lab", hostId: "prox2", vmId: 9023, configDigest: gatewayConfigDigest },
    helper: { path: "/usr/libexec/nelos-golden-gateway-policy", digest: helperDigest },
    nft: { family: "inet", table: "nelosbld", forwardChain: "forward", approvedIpv4Set: "approved_ipv4", sourceCidr: "10.77.77.0/24" },
    apiAllow: { address: "192.168.1.110", port: 8006, protocol: "tcp" },
    httpsAllow: { port: 443, protocol: "tcp", destinations: normalized },
    originalRulesetDigest,
  };
  return { ...unsigned, bindingDigest: sha256V1(unsigned) };
}

export function validateGoldenBuilderGatewayPolicyBindingV1(value, reservation, { now = Date.now(), allowExpired = false } = {}) {
  exact(value, ["apiAllow", "bindingDigest", "buildNonce", "expiresAt", "gateway", "helper", "httpsAllow", "kind", "nft", "originalRulesetDigest", "reservationDigest", "schemaVersion"], "gateway policy binding");
  exact(value.gateway, ["configDigest", "hostId", "providerId", "vmId"], "gateway policy gateway");
  exact(value.helper, ["digest", "path"], "gateway policy helper");
  exact(value.nft, ["approvedIpv4Set", "family", "forwardChain", "sourceCidr", "table"], "gateway nft identity");
  exact(value.apiAllow, ["address", "port", "protocol"], "gateway API allow");
  exact(value.httpsAllow, ["destinations", "port", "protocol"], "gateway HTTPS allow");
  const expiry = Date.parse(reservation?.expiresAt);
  const destinationValidationCeiling = Array.isArray(value.httpsAllow.destinations)
    ? Math.min(...value.httpsAllow.destinations.map(({ expiresAt }) => Date.parse(expiresAt) - 1))
    : Number.NaN;
  const validationNow = allowExpired && Number.isFinite(expiry) && Number.isSafeInteger(reservation?.maxBuildMs) && Number.isFinite(destinationValidationCeiling)
    ? Math.min(now, expiry - reservation.maxBuildMs - 120_001, destinationValidationCeiling)
    : now;
  const expected = createGoldenBuilderGatewayPolicyBindingV1({
    reservation,
    originalRulesetDigest: value.originalRulesetDigest,
    helperDigest: value.helper.digest,
    gatewayConfigDigest: value.gateway.configDigest,
    destinations: value.httpsAllow.destinations,
  }, { now: validationNow });
  if (canonicalJsonV1(value) !== canonicalJsonV1(expected)) fail("INVALID_CONTRACT", "gateway policy binding identity or digest differs");
  return value;
}

function operationId(binding, operation) {
  return sha256V1({ schemaVersion: 1, kind: "nelos-golden-builder-gateway-operation", bindingDigest: binding.bindingDigest, operation });
}

function envelope(binding, role, operation, requestedAt, deadlineAt) {
  return {
    schemaVersion: 1,
    kind: "nelos-golden-builder-gateway-request",
    role,
    operation,
    operationId: operationId(binding, operation),
    binding,
    requestedAt: new Date(requestedAt).toISOString(),
    deadlineAt: new Date(deadlineAt).toISOString(),
  };
}

function validateReceipt(value, request) {
  exact(value, ["bindingDigest", "kind", "observedAt", "operation", "operationId", "payload", "payloadDigest", "providerOperationId", "receiptDigest", "role", "schemaVersion", "status"], "gateway policy receipt");
  const { receiptDigest, ...unsigned } = value;
  if (value.schemaVersion !== 1 || value.kind !== "nelos-golden-builder-gateway-receipt" || value.role !== request.role || value.operation !== request.operation ||
      value.operationId !== request.operationId || value.bindingDigest !== request.binding.bindingDigest || !plain(value.payload) || value.payloadDigest !== sha256V1(value.payload) ||
      receiptDigest !== sha256V1(unsigned) || !SHA256.test(receiptDigest ?? "") || !Number.isFinite(Date.parse(value.observedAt))) {
    fail("GATEWAY_RECEIPT_INVALID", "gateway policy receipt identity, payload, or digest differs");
  }
  if (Date.parse(value.observedAt) > Date.parse(request.deadlineAt) + 1_000 || (MUTATIONS.has(request.operation) && !new Set(["ambiguous", "committed", "failed"]).has(value.status)) ||
      (!MUTATIONS.has(request.operation) && (value.status !== "observed" || value.providerOperationId !== null)) ||
      (value.status === "committed" && (typeof value.providerOperationId !== "string" || value.providerOperationId.length < 1 || value.providerOperationId.length > 512))) {
    fail("GATEWAY_RECEIPT_INVALID", "gateway policy receipt state or deadline differs");
  }
  return value;
}

function expectedAddresses(binding) { return binding.httpsAllow.destinations.flatMap(({ addresses }) => addresses).sort(); }

function validatePreflight(payload, binding) {
  exact(payload, ["approvedSetEmpty", "forwardPolicy", "gatewayVmId", "helperDigest", "rulesetDigest", "unexpectedForwardAccepts"], "gateway preflight payload");
  if (payload.gatewayVmId !== 9023 || payload.helperDigest !== binding.helper.digest || payload.rulesetDigest !== binding.originalRulesetDigest ||
      payload.forwardPolicy !== "drop" || payload.approvedSetEmpty !== true || payload.unexpectedForwardAccepts !== 0) {
    fail("GATEWAY_PREFLIGHT_MISMATCH", "gateway baseline identity or deny policy differs");
  }
  return payload;
}

function validateActive(payload, binding) {
  exact(payload, ["active", "allowedHttpsAddresses", "apiAddress", "apiPort", "marker", "rulesetDigest"], "gateway active payload");
  if (payload.active !== true || payload.apiAddress !== binding.apiAllow.address || payload.apiPort !== binding.apiAllow.port ||
      payload.marker !== `nelos-golden:${binding.bindingDigest.slice(7, 23)}` || !SHA256.test(payload.rulesetDigest ?? "") ||
      !Array.isArray(payload.allowedHttpsAddresses) || payload.allowedHttpsAddresses.join("\0") !== expectedAddresses(binding).join("\0")) {
    fail("GATEWAY_POLICY_MISMATCH", "active gateway egress differs from the sealed package/API policy");
  }
  return payload;
}

function validateRestored(payload, binding, { independent = false } = {}) {
  exact(payload, independent ? ["independentInventoryDigest", "restored", "rulesetDigest"] : ["restored", "rulesetDigest"], "gateway restore payload");
  if (payload.restored !== true || payload.rulesetDigest !== binding.originalRulesetDigest || (independent && !SHA256.test(payload.independentInventoryDigest ?? ""))) {
    fail("GATEWAY_RESTORE_UNPROVEN", "gateway did not return to the exact original ruleset digest");
  }
  return payload;
}

export class GoldenBuilderGatewayPolicyAdapterV1 {
  constructor({ binding, reservation, providerTransport, attestorTransport, receiptStore, clock = Date, operationTimeoutMs = 120_000, transportAttempts = 2, allowExpiredBinding = false } = {}) {
    if (typeof allowExpiredBinding !== "boolean") fail("INVALID_ADAPTER", "gateway cleanup admission flag is invalid");
    this.binding = validateGoldenBuilderGatewayPolicyBindingV1(binding, reservation, { now: clock.now(), allowExpired: allowExpiredBinding });
    if (typeof providerTransport?.invoke !== "function" || typeof attestorTransport?.invoke !== "function" || providerTransport === attestorTransport ||
        !SSH_FINGERPRINT.test(providerTransport?.identityFingerprint ?? "") || !SSH_FINGERPRINT.test(attestorTransport?.identityFingerprint ?? "") ||
        providerTransport.identityFingerprint === attestorTransport.identityFingerprint) fail("INDEPENDENT_ATTESTOR_REQUIRED", "distinct gateway provider and attestor transports are required");
    if (typeof receiptStore?.commit !== "function" || typeof clock?.now !== "function" || !Number.isSafeInteger(operationTimeoutMs) || operationTimeoutMs < 1_000 || operationTimeoutMs > 300_000 ||
        !Number.isSafeInteger(transportAttempts) || transportAttempts < 1 || transportAttempts > 3) fail("INVALID_ADAPTER", "gateway transport boundary or budget is invalid");
    Object.assign(this, { providerTransport, attestorTransport, receiptStore, clock, operationTimeoutMs, transportAttempts });
  }

  async #invoke(role, operation) {
    if (!OPERATIONS.has(operation) || (role === "attestor") !== (operation === "confirm-restored")) fail("INVALID_OPERATION", "gateway role cannot perform this operation");
    const requestedAt = this.clock.now(); const expiry = Date.parse(this.binding.expiresAt);
    const deadlineAt = operation === "restore" || operation === "confirm-restored" ? requestedAt + this.operationTimeoutMs : Math.min(expiry, requestedAt + this.operationTimeoutMs);
    if (!Number.isFinite(deadlineAt) || deadlineAt <= requestedAt) fail("GATEWAY_POLICY_EXPIRED", "gateway policy is expired");
    const request = envelope(this.binding, role, operation, requestedAt, deadlineAt); const transport = role === "provider" ? this.providerTransport : this.attestorTransport;
    let lastError = null;
    for (let attempt = 0; attempt < this.transportAttempts; attempt += 1) {
      try {
        const receipt = validateReceipt(await transport.invoke(request), request);
        await this.receiptStore.commit(receipt);
        if (MUTATIONS.has(operation) && new Set(["ambiguous", "failed"]).has(receipt.status) && attempt + 1 < this.transportAttempts) { lastError = receipt; continue; }
        return receipt;
      } catch (error) {
        if (error instanceof GoldenBuilderGatewayPolicyError && ["GATEWAY_RECEIPT_INVALID", "INVALID_CONTRACT"].includes(error.code)) throw error;
        lastError = error;
        if (!MUTATIONS.has(operation) || attempt + 1 >= this.transportAttempts) break;
      }
    }
    throw new GoldenBuilderGatewayPolicyError(MUTATIONS.has(operation) ? "GATEWAY_MUTATION_UNCERTAIN" : "GATEWAY_TRANSPORT_FAILED", "gateway transport did not return one verified receipt", { operation, operationId: request.operationId, cause: lastError?.code ?? "TRANSPORT_FAILED" });
  }

  async preflight() { return validatePreflight((await this.#invoke("provider", "preflight")).payload, this.binding); }
  async apply() {
    const receipt = await this.#invoke("provider", "apply");
    if (receipt.status !== "committed") fail("GATEWAY_MUTATION_UNCERTAIN", "gateway policy apply is not committed");
    return { providerOperationId: receipt.providerOperationId, ...validateActive(receipt.payload, this.binding) };
  }
  async observe() { return validateActive((await this.#invoke("provider", "observe")).payload, this.binding); }
  async restore() {
    const receipt = await this.#invoke("provider", "restore");
    if (receipt.status !== "committed") fail("GATEWAY_MUTATION_UNCERTAIN", "gateway policy restore is not committed");
    return { providerOperationId: receipt.providerOperationId, ...validateRestored(receipt.payload, this.binding) };
  }
  async confirmRestored() { return validateRestored((await this.#invoke("attestor", "confirm-restored")).payload, this.binding, { independent: true }); }
}

export async function restoreGoldenBuilderGatewayPolicyV1({ binding, adapter, journal }) {
  const restored = await adapter.restore(binding);
  const confirmed = await adapter.confirmRestored(binding);
  await journal.record("gateway-policy-restored", { bindingDigest: binding.bindingDigest, providerOperationId: restored.providerOperationId, originalRulesetDigest: confirmed.rulesetDigest, independentInventoryDigest: confirmed.independentInventoryDigest });
  return confirmed;
}

export async function activateGoldenBuilderGatewayPolicyV1({ binding, adapter, journal }) {
  if (!plain(adapter) || !plain(journal) || typeof journal.record !== "function" || ["preflight", "apply", "observe", "restore", "confirmRestored"].some((method) => typeof adapter[method] !== "function")) {
    fail("INVALID_ADAPTER", "gateway policy adapter or journal is invalid");
  }
  await adapter.preflight(binding);
  await journal.record("gateway-policy-preflighted", { bindingDigest: binding.bindingDigest, originalRulesetDigest: binding.originalRulesetDigest });
  let applyAttempted = false;
  try {
    applyAttempted = true;
    const applied = await adapter.apply(binding);
    const observed = await adapter.observe(binding);
    await journal.record("gateway-policy-active", { bindingDigest: binding.bindingDigest, providerOperationId: applied.providerOperationId, rulesetDigest: observed.rulesetDigest });
    return observed;
  } catch (error) {
    if (applyAttempted) {
      try { await restoreGoldenBuilderGatewayPolicyV1({ binding, adapter, journal }); }
      catch (restoreError) {
        throw new GoldenBuilderGatewayPolicyError("GATEWAY_RECONCILIATION_REQUIRED", "gateway apply failed and exact original restoration is unproven", { cause: error?.code ?? "GATEWAY_APPLY_FAILED", restoreCause: restoreError?.code ?? "GATEWAY_RESTORE_FAILED" });
      }
    }
    throw error;
  }
}

export async function runGatewayProtectedGoldenBuilderV1({ binding, adapter, journal, runBuilder }) {
  if (typeof runBuilder !== "function") fail("INVALID_ADAPTER", "gateway-protected builder callback is invalid");
  await activateGoldenBuilderGatewayPolicyV1({ binding, adapter, journal });
  let result; let builderError = null;
  try { result = await runBuilder(); } catch (error) { builderError = error; }
  try { await restoreGoldenBuilderGatewayPolicyV1({ binding, adapter, journal }); }
  catch (restoreError) {
    throw new GoldenBuilderGatewayPolicyError("GATEWAY_RECONCILIATION_REQUIRED", "builder terminated but the exact original gateway ruleset is not independently proven", { builderCause: builderError?.code ?? null, restoreCause: restoreError?.code ?? "GATEWAY_RESTORE_FAILED" });
  }
  if (builderError) throw builderError;
  return result;
}

export const GOLDEN_BUILDER_GATEWAY_CONSTANTS_V1 = Object.freeze({ HTTPS_HOSTS, gatewayVmId: 9023, apiAddress: "192.168.1.110", apiPort: 8006 });
