import { createHash } from "node:crypto";

const SUCCESS = new Set(["OK", "completed"]);
const MAC_ADDRESS = /^02(?::[0-9A-F]{2}){5}$/u;

function encode(value) {
  return encodeURIComponent(String(value));
}

function bindingDescription(binding, extra = {}) {
  return `nelos-desktop-v1:${Buffer.from(JSON.stringify({ ...binding, ...extra })).toString("base64url")}`;
}

function decodeBinding(description) {
  if (typeof description !== "string" || !description.startsWith("nelos-desktop-v1:")) return null;
  try {
    const encoded = description.slice("nelos-desktop-v1:".length);
    if (!/^[A-Za-z0-9_-]{1,21846}$/u.test(encoded)) return null;
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.length > 16_384 || bytes.toString("base64url") !== encoded) return null;
    const value = JSON.parse(bytes.toString("utf8"));
    const common = ["fencingToken", "gatewayId", "hostId", "imageId", "leaseId", "macAddress", "networkId", "networkPolicyDigest", "providerId", "state", "vmId"];
    const fields = value?.state === "created" ? common
      : value?.state === "configured" ? [...common, "automationUser", "runId", "stateRoot"]
        : value?.state === "quarantined" ? [...common, "quarantined", "reason"] : [];
    return fields.length > 0 && exactFields(value, fields) ? value : null;
  } catch {
    return null;
  }
}

function exactFields(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  return value;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(`${JSON.stringify(canonicalValue(value))}\n`).digest("hex")}`;
}

function sameProviderBinding(value, binding) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    value.providerId === binding.providerId && value.hostId === binding.hostId &&
    String(value.vmId) === String(binding.vmId) && value.macAddress === binding.macAddress && value.networkId === binding.networkId &&
    value.gatewayId === binding.gatewayId && value.networkPolicyDigest === binding.networkPolicyDigest && value.leaseId === binding.leaseId &&
    value.fencingToken === binding.fencingToken;
}

function networkIdentity(config, { quarantined = false } = {}) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) return null;
  const interfaces = Object.keys(config).filter((key) => /^net[0-9]+$/u.test(key));
  if (interfaces.length !== 1 || interfaces[0] !== "net0" || typeof config.net0 !== "string") return null;
  const tokens = config.net0.split(",");
  const expectedCount = quarantined ? 4 : 3;
  if (tokens.length !== expectedCount || new Set(tokens).size !== tokens.length) return null;
  const model = /^(?:virtio)=((?:[0-9A-F]{2}:){5}[0-9A-F]{2})$/u.exec(tokens[0]);
  const bridge = tokens.find((token) => token.startsWith("bridge="));
  if (model === null || !MAC_ADDRESS.test(model[1]) || typeof bridge !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(bridge.slice(7)) ||
      !tokens.includes("firewall=1") || tokens.includes("link_down=1") !== quarantined) return null;
  const allowed = new Set([tokens[0], bridge, "firewall=1", ...(quarantined ? ["link_down=1"] : [])]);
  if (tokens.some((token) => !allowed.has(token))) return null;
  return { macAddress: model[1], networkId: bridge.slice(7) };
}

function parseDeviceAuthResponse(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) < 2 || Buffer.byteLength(text) > 4_096) throw Object.assign(new Error("device-auth response is invalid"), { code: "DEVICE_AUTH_FAILED" });
  let value;
  try { value = JSON.parse(text); } catch { throw Object.assign(new Error("device-auth response is invalid"), { code: "DEVICE_AUTH_FAILED" }); }
  if (value.status === "authorization_required") {
    if (!exactFields(value, ["status", "type", "userCode", "verificationUrl"]) || value.type !== "chatgptDeviceCode" ||
        typeof value.userCode !== "string" || !/^[A-Za-z0-9-]{4,32}$/u.test(value.userCode) ||
        typeof value.verificationUrl !== "string" || !value.verificationUrl.startsWith("https://")) throw Object.assign(new Error("device-auth challenge is invalid"), { code: "DEVICE_AUTH_FAILED" });
    return value;
  }
  if (value.status === "authenticated") {
    const fields = value.authenticated === undefined ? ["status", "accountType", "credentialStore"] : ["status", "authenticated", "accountType", "credentialStore"];
    if (!exactFields(value, fields) || (value.authenticated !== undefined && value.authenticated !== true) || value.accountType !== "chatgpt" || value.credentialStore !== "file") throw Object.assign(new Error("device-auth completion is invalid"), { code: "DEVICE_AUTH_FAILED" });
    return value;
  }
  if (["pending", "not_started"].includes(value.status)) {
    if (!exactFields(value, ["status", "authenticated", "accountType", "credentialStore"]) || value.authenticated !== false || value.accountType !== null || value.credentialStore !== "file") throw Object.assign(new Error("device-auth pending status is invalid"), { code: "DEVICE_AUTH_FAILED" });
    return value;
  }
  throw Object.assign(new Error("device-auth state is not allowlisted"), { code: "DEVICE_AUTH_FAILED" });
}

function parseCredentialBoundaryResponse(text, binding) {
  if (typeof text !== "string" || Buffer.byteLength(text) < 2 || Buffer.byteLength(text) > 16_384) {
    throw Object.assign(new Error("credential-boundary response is invalid"), { code: "CREDENTIAL_BOUNDARY_UNATTESTED" });
  }
  let value;
  try { value = JSON.parse(text); } catch { throw Object.assign(new Error("credential-boundary response is invalid"), { code: "CREDENTIAL_BOUNDARY_UNATTESTED" }); }
  if (!exactFields(value, [
    "attestationDigest", "bootIdDigest", "codexHome", "fencingToken", "filesystemType", "imageId", "mountOptions", "runId",
    "schemaVersion", "secretBytesIncluded", "swapActive", "type", "vmId", "volatile",
  ]) || value.schemaVersion !== 1 || value.type !== "nelos.credential-volatility.v1" || value.runId !== binding.runId ||
      value.fencingToken !== binding.fencingToken || value.vmId !== binding.vmId || value.imageId !== binding.imageId || value.codexHome !== "/home/nelosauto/.codex" ||
      value.filesystemType !== "tmpfs" || JSON.stringify(value.mountOptions) !== JSON.stringify(["nodev", "noexec", "nosuid", "rw"]) ||
      value.swapActive !== false || value.volatile !== true || value.secretBytesIncluded !== false ||
      !/^sha256:[0-9a-f]{64}$/u.test(value.bootIdDigest ?? "") || !/^sha256:[0-9a-f]{64}$/u.test(value.attestationDigest ?? "")) {
    throw Object.assign(new Error("credential-boundary identity or volatility proof differs"), { code: "CREDENTIAL_BOUNDARY_UNATTESTED" });
  }
  const { attestationDigest, ...unsigned } = value;
  if (sha256(unsigned) !== attestationDigest) {
    throw Object.assign(new Error("credential-boundary digest differs"), { code: "CREDENTIAL_BOUNDARY_UNATTESTED" });
  }
  return Object.freeze(structuredClone(value));
}

function parseInstalledDesktopIdentity(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) < 2 || Buffer.byteLength(text) > 65_536) throw Object.assign(new Error("installed Desktop identity response is invalid"), { code: "DESKTOP_IDENTITY_MISMATCH" });
  let value;
  try { value = JSON.parse(text); } catch { throw Object.assign(new Error("installed Desktop identity response is invalid"), { code: "DESKTOP_IDENTITY_MISMATCH" }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("installed Desktop identity response is invalid"), { code: "DESKTOP_IDENTITY_MISMATCH" });
  return value;
}

/**
 * Proxmox VE v1 provider adapter. The injected transport owns TLS and token
 * handling and exposes request({method,path,body}). No live endpoint or secret
 * is accepted by this class, which keeps offline fixtures and production I/O
 * behind the same narrow boundary.
 */
export class ProxmoxVeDesktopAdapterV1 {
  constructor({ transport, receiptStore, providerId, qgaAttempts = 120, authAttempts = 900, taskAttempts = 120, taskPollMs = 1_000, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), authChallengeSink = (text) => process.stderr.write(text), clock = Date } = {}) {
    if (typeof transport?.request !== "function") throw new TypeError("transport.request is required");
    if (typeof receiptStore?.commit !== "function") throw new TypeError("receiptStore.commit is required");
    if (typeof providerId !== "string" || providerId.length === 0) throw new TypeError("providerId is required");
    if (!Number.isSafeInteger(qgaAttempts) || qgaAttempts < 1 || qgaAttempts > 120) throw new TypeError("qgaAttempts is invalid");
    if (!Number.isSafeInteger(authAttempts) || authAttempts < 1 || authAttempts > 900) throw new TypeError("authAttempts is invalid");
    if (!Number.isSafeInteger(taskAttempts) || taskAttempts < 1 || taskAttempts > 600) throw new TypeError("taskAttempts is invalid");
    if (!Number.isSafeInteger(taskPollMs) || taskPollMs < 1 || taskPollMs > 10_000) throw new TypeError("taskPollMs is invalid");
    if (typeof wait !== "function") throw new TypeError("wait is invalid");
    if (typeof authChallengeSink !== "function") throw new TypeError("authChallengeSink is invalid");
    if (typeof clock?.now !== "function") throw new TypeError("clock is invalid");
    this.transport = transport;
    this.receiptStore = receiptStore;
    this.providerId = providerId;
    this.qgaAttempts = qgaAttempts;
    this.authAttempts = authAttempts;
    this.taskAttempts = taskAttempts;
    this.taskPollMs = taskPollMs;
    this.wait = wait;
    this.authChallengeSink = authChallengeSink;
    this.clock = clock;
  }

  assertDeadline(deadlineAt, code = "QGA_DEADLINE_EXPIRED") {
    if (!Number.isFinite(deadlineAt) || this.clock.now() >= deadlineAt) throw Object.assign(new Error("bounded graphical provisioning deadline expired"), { code });
    return deadlineAt - this.clock.now();
  }

  async boundedWait(deadlineAt) {
    const remaining = this.assertDeadline(deadlineAt);
    await this.wait(Math.min(this.taskPollMs, remaining));
  }

  async call(method, path, body = undefined, options = undefined) {
    return this.transport.request({ method, path, ...(body === undefined ? {} : { body }) }, options);
  }

  async inspectVm({ hostId, vmId }) {
    try {
      const response = await this.call("GET", `/nodes/${encode(hostId)}/qemu/${encode(vmId)}/config`);
      const data = response?.data ?? response;
      const owned = decodeBinding(data?.description);
      if (owned === null) return {
        providerId: this.providerId, hostId, vmId: String(vmId), leaseId: "unowned", fencingToken: "unowned",
        macAddress: "network-invalid", networkId: "network-invalid", gatewayId: "network-invalid", networkPolicyDigest: "network-invalid",
        imageId: "unowned", state: data?.status ?? "unknown",
      };
      const network = networkIdentity(data, { quarantined: owned.quarantined === true });
      return {
        providerId: owned.providerId,
        hostId: owned.hostId,
        vmId: String(owned.vmId),
        macAddress: network?.macAddress ?? "network-invalid",
        networkId: network?.networkId ?? "network-invalid",
        gatewayId: owned.gatewayId,
        networkPolicyDigest: owned.networkPolicyDigest,
        leaseId: owned.leaseId,
        fencingToken: owned.fencingToken,
        imageId: owned.imageId,
        state: data?.status ?? owned.state ?? "unknown",
        ...(owned.quarantined === true ? { quarantined: true } : {}),
      };
    } catch (error) {
      if (error?.status === 404 || error?.code === "PVE_NOT_FOUND") return null;
      throw error;
    }
  }

  async inspectRuntimeBinding({ hostId, vmId }) {
    const response = await this.call("GET", `/nodes/${encode(hostId)}/qemu/${encode(vmId)}/config`);
    const data = response?.data ?? response;
    const owned = decodeBinding(data?.description);
    const network = owned === null ? null : networkIdentity(data, { quarantined: owned.quarantined === true });
    if (owned === null || network === null || owned.macAddress !== network.macAddress || owned.networkId !== network.networkId) return null;
    return {
      providerId: owned.providerId, hostId: owned.hostId, vmId: String(owned.vmId),
      macAddress: network.macAddress, networkId: network.networkId, gatewayId: owned.gatewayId, networkPolicyDigest: owned.networkPolicyDigest,
      leaseId: owned.leaseId, fencingToken: owned.fencingToken, imageId: owned.imageId,
      runId: owned.runId, automationUser: owned.automationUser, stateRoot: owned.stateRoot,
    };
  }

  async inspectGoldenImage({ hostId, templateVmId }) {
    const [configResponse, statusResponse] = await Promise.all([
      this.call("GET", `/nodes/${encode(hostId)}/qemu/${encode(templateVmId)}/config`),
      this.call("GET", `/nodes/${encode(hostId)}/qemu/${encode(templateVmId)}/status/current`),
    ]);
    const config = configResponse?.data ?? configResponse;
    const status = statusResponse?.data ?? statusResponse;
    if (!config || typeof config !== "object" || Array.isArray(config) || !status || typeof status !== "object" || Array.isArray(status)) {
      throw Object.assign(new Error("golden-image provider observation is invalid"), { code: "GOLDEN_IMAGE_ATTESTATION_MISMATCH" });
    }
    return {
      providerId: this.providerId,
      hostId,
      templateVmId: String(templateVmId),
      config: Object.fromEntries(Object.entries(config).filter(([key]) => key !== "digest")),
      status: status.status,
      template: Number(config.template) === 1,
    };
  }

  async mutate(method, path, body) {
    const response = await this.call(method, path, body);
    const upid = response?.data ?? response?.upid ?? null;
    if (typeof upid !== "string" || upid.length === 0) return { status: "ambiguous", providerOperationId: null };
    for (let attempt = 0; attempt < this.taskAttempts; attempt += 1) {
      const task = await this.call("GET", `/nodes/${encode(body.node)}/tasks/${encode(upid)}/status`);
      const status = task?.data ?? task;
      if (status?.status === "stopped") {
        return { status: SUCCESS.has(status.exitstatus) ? "committed" : "failed", providerOperationId: upid };
      }
      if (typeof status?.status !== "string") return { status: "ambiguous", providerOperationId: upid };
      if (attempt + 1 < this.taskAttempts) await this.wait(this.taskPollMs);
    }
    return { status: "timed_out", providerOperationId: upid };
  }

  cloneVm({ binding, configuration, goldenImage }) {
    return this.mutate("POST", `/nodes/${encode(binding.hostId)}/qemu/${encode(goldenImage.templateVmId)}/clone`, {
      node: binding.hostId,
      newid: Number(binding.vmId),
      target: binding.hostId,
      full: configuration.cloneMode === "linked" ? 0 : 1,
      name: `nelos-desktop-${binding.vmId}`,
      description: bindingDescription(binding, { imageId: goldenImage.imageId, state: "created" }),
    });
  }

  configureVm({ binding, configuration }) {
    return this.mutate("PUT", `/nodes/${encode(binding.hostId)}/qemu/${encode(binding.vmId)}/config`, {
      node: binding.hostId,
      agent: "enabled=1,fstrim_cloned_disks=1",
      net0: `virtio=${binding.macAddress},bridge=${binding.networkId},firewall=1`,
      onboot: 0,
      protection: 0,
      tags: "nelos-desktop;disposable;automation-only",
      ciuser: configuration.automation.user,
      cipassword: undefined,
      sshkeys: undefined,
      description: bindingDescription(binding, {
        imageId: configuration.goldenImageId,
        state: "configured",
        stateRoot: configuration.writableState.root,
        runId: configuration.writableState.root.split("/").at(-1),
        automationUser: configuration.automation.user,
      }),
    });
  }

  startVm({ binding }) {
    return this.mutate("POST", `/nodes/${encode(binding.hostId)}/qemu/${encode(binding.vmId)}/status/start`, { node: binding.hostId });
  }

  stopVm({ binding }) {
    return this.mutate("POST", `/nodes/${encode(binding.hostId)}/qemu/${encode(binding.vmId)}/status/stop`, { node: binding.hostId });
  }

  async attestVmStopped(binding) {
    const response = await this.call("GET", `/nodes/${encode(binding.hostId)}/qemu/${encode(binding.vmId)}/status/current`);
    const status = response?.data ?? response;
    const exact = await this.inspectVm(binding);
    const identityMatches = sameProviderBinding(exact, binding);
    return {
      ...binding,
      poweredOff: identityMatches && status?.status === "stopped",
      powerState: typeof status?.status === "string" ? status.status : "unknown",
    };
  }

  destroyVm({ binding }) {
    return this.mutate("DELETE", `/nodes/${encode(binding.hostId)}/qemu/${encode(binding.vmId)}`, {
      node: binding.hostId, purge: 1, "destroy-unreferenced-disks": 1,
    });
  }

  quarantineVm({ binding, imageId, reason }) {
    return this.mutate("PUT", `/nodes/${encode(binding.hostId)}/qemu/${encode(binding.vmId)}/config`, {
      node: binding.hostId,
      protection: 1,
      onboot: 0,
      net0: `virtio=${binding.macAddress},bridge=${binding.networkId},link_down=1,firewall=1`,
      tags: "nelos-desktop;quarantined;do-not-reuse",
      description: bindingDescription(binding, { imageId, quarantined: true, reason, state: "quarantined" }),
    });
  }

  async reconcileMutation({ binding, mutation, providerOperationId, expected }) {
    if (providerOperationId) {
      for (let attempt = 0; attempt < this.taskAttempts; attempt += 1) {
        const task = await this.call("GET", `/nodes/${encode(binding.hostId)}/tasks/${encode(providerOperationId)}/status`);
        const status = task?.data ?? task;
        if (status?.status === "stopped") return { status: SUCCESS.has(status.exitstatus) ? "committed" : "failed", providerOperationId };
        if (typeof status?.status !== "string") return { status: "ambiguous", providerOperationId };
        if (attempt + 1 < this.taskAttempts) await this.wait(this.taskPollMs);
      }
      return { status: "timed_out", providerOperationId };
    }
    if (!expected || typeof expected !== "object" || Array.isArray(expected)) return { status: "ambiguous", providerOperationId: null };
    let config = null;
    try {
      const response = await this.call("GET", `/nodes/${encode(binding.hostId)}/qemu/${encode(binding.vmId)}/config`);
      config = response?.data ?? response;
    } catch (error) {
      if (error?.status !== 404 && error?.code !== "PVE_NOT_FOUND") throw error;
    }
    if (mutation === "destroy") {
      return { status: config === null && expected.state === "absent" ? "committed" : "ambiguous", providerOperationId: null };
    }
    const owned = decodeBinding(config?.description);
    if (!sameProviderBinding(owned, binding)) return { status: "ambiguous", providerOperationId: null };
    if (mutation === "clone") {
      const committed = exactFields(expected, ["imageId", "state"]) && expected.state === "created" &&
        owned.imageId === expected.imageId && owned.state === expected.state;
      return { status: committed ? "committed" : "ambiguous", providerOperationId: null };
    }
    if (mutation === "configure") {
      const network = networkIdentity(config);
      const committed = exactFields(expected, ["automationUser", "imageId", "macAddress", "networkId", "runId", "state", "stateRoot"]) && expected.state === "configured" &&
        owned.automationUser === expected.automationUser && owned.imageId === expected.imageId && owned.runId === expected.runId &&
        owned.state === expected.state && owned.stateRoot === expected.stateRoot && config.agent === "enabled=1,fstrim_cloned_disks=1" &&
        network?.macAddress === expected.macAddress && network?.networkId === expected.networkId &&
        Number(config.onboot) === 0 && Number(config.protection) === 0 && config.tags === "nelos-desktop;disposable;automation-only" && config.ciuser === expected.automationUser;
      return { status: committed ? "committed" : "ambiguous", providerOperationId: null };
    }
    if (mutation === "quarantine") {
      const network = networkIdentity(config, { quarantined: true });
      const statusResponse = await this.call("GET", `/nodes/${encode(binding.hostId)}/qemu/${encode(binding.vmId)}/status/current`);
      const power = statusResponse?.data ?? statusResponse;
      const committed = exactFields(expected, ["imageId", "reason", "state"]) && expected.state === "quarantined" &&
        owned.imageId === expected.imageId && owned.quarantined === true && owned.reason === expected.reason && owned.state === expected.state &&
        Number(config.onboot) === 0 && Number(config.protection) === 1 && config.tags === "nelos-desktop;quarantined;do-not-reuse" &&
        network?.macAddress === binding.macAddress && network?.networkId === binding.networkId && power?.status === "stopped";
      return { status: committed ? "committed" : "ambiguous", providerOperationId: null };
    }
    if (["start", "stop"].includes(mutation) && exactFields(expected, ["state"])) {
      const response = await this.call("GET", `/nodes/${encode(binding.hostId)}/qemu/${encode(binding.vmId)}/status/current`);
      const status = response?.data ?? response;
      const wanted = mutation === "start" ? "running" : "stopped";
      return { status: expected.state === wanted && status?.status === wanted ? "committed" : "ambiguous", providerOperationId: null };
    }
    return { status: "ambiguous", providerOperationId: null };
  }

  async waitForQga({ binding, runtimeBinding = null, expectedUser, expectedSession, deadlineAt = Number.MAX_SAFE_INTEGER, hardDeadlineAt = deadlineAt }) {
    if (!Number.isFinite(deadlineAt) || !Number.isFinite(hardDeadlineAt) || deadlineAt > hardDeadlineAt) return { ready: false, errorCode: "QGA_DEADLINE_EXPIRED", user: null, session: null };
    let pingError = null;
    let pingReady = false;
    for (let attempt = 0; attempt < this.qgaAttempts; attempt += 1) {
      try {
        this.assertDeadline(deadlineAt);
        await this.qgaControl({ control: "guest-ping", binding, command: null, arguments: [] });
        pingReady = true;
        break;
      } catch (error) {
        pingError = error;
        if (attempt + 1 < this.qgaAttempts) {
          try { await this.boundedWait(deadlineAt); }
          catch (deadlineError) {
            return { ready: false, errorCode: deadlineError?.code ?? "QGA_UNAVAILABLE", user: null, session: null };
          }
        }
      }
    }
    if (!pingReady) return { ready: false, errorCode: pingError?.code ?? "QGA_UNAVAILABLE", user: null, session: null };

    let authStarted = false;
    let authenticated = false;
    const cancelPendingAuth = async () => {
      if (!authStarted || authenticated) return;
      try {
        await this.execGuestAndWait({ binding, command: "/usr/libexec/nelos-device-auth", arguments: ["cancel"], attempts: this.qgaAttempts, errorCode: "DEVICE_AUTH_CANCEL_FAILED", allowFailure: true, deadlineAt: hardDeadlineAt });
      } catch { /* cancellation is best-effort; the caller still quarantines */ }
    };
    try {
      if (runtimeBinding) {
        const encoded = Buffer.from(JSON.stringify(runtimeBinding)).toString("base64");
        await this.execGuestAndWait({ binding, command: "/usr/libexec/nelos-bind-runtime", arguments: [encoded], attempts: this.qgaAttempts, errorCode: "QGA_BINDING_FAILED", deadlineAt });
      }
      const boundaryResult = await this.execGuestAndWait({
        binding, command: "/usr/libexec/nelos-credential-boundary", arguments: ["prepare"],
        attempts: this.qgaAttempts, errorCode: "CREDENTIAL_BOUNDARY_UNATTESTED", deadlineAt,
      });
      const credentialBoundary = parseCredentialBoundaryResponse(boundaryResult.stdout, runtimeBinding ?? {
        ...binding,
        runId: (await this.inspectRuntimeBinding({ hostId: binding.hostId, vmId: binding.vmId }))?.runId,
      });
      const identityResult = await this.execGuestAndWait({ binding, command: "/usr/libexec/nelos-desktop-identity", arguments: [], attempts: this.qgaAttempts, errorCode: "DESKTOP_IDENTITY_MISMATCH", deadlineAt });
      const installedDesktopIdentity = parseInstalledDesktopIdentity(identityResult.stdout);
      const startedAuth = await this.execGuestAndWait({ binding, command: "/usr/libexec/nelos-device-auth", arguments: ["start"], attempts: this.qgaAttempts, errorCode: "DEVICE_AUTH_FAILED", deadlineAt });
      authStarted = true;
      let authState = parseDeviceAuthResponse(startedAuth.stdout);
      if (authState.status === "authorization_required") {
        this.authChallengeSink(`\n[nelos isolated ChatGPT device authentication]\nOpen ${authState.verificationUrl} and enter ${authState.userCode}.\n`);
      }
      authenticated = authState.status === "authenticated";
      for (let poll = 0; !authenticated && poll < this.authAttempts; poll += 1) {
        try {
          this.assertDeadline(deadlineAt);
          const observed = await this.execGuestAndWait({ binding, command: "/usr/libexec/nelos-device-auth", arguments: ["status"], attempts: this.qgaAttempts, errorCode: "DEVICE_AUTH_FAILED", allowFailure: true, deadlineAt });
          if (observed.exitcode === 0) {
            authState = parseDeviceAuthResponse(observed.stdout);
            authenticated = authState.status === "authenticated";
          }
        } catch { /* a bounded transient QGA read may be retried as status only */ }
        if (!authenticated && poll + 1 < this.authAttempts) await this.boundedWait(deadlineAt);
      }
      if (!authenticated) {
        await cancelPendingAuth();
        return { ready: false, errorCode: "DEVICE_AUTH_TIMEOUT", user: null, session: null };
      }
      for (let attempt = 0; attempt < this.qgaAttempts; attempt += 1) {
        try {
          this.assertDeadline(deadlineAt);
          const users = await this.qgaControl({ control: "guest-get-users", binding, command: null, arguments: [] });
          const sessions = Array.isArray(users?.data) ? users.data : [];
          if (sessions.some((user) => user.user === expectedUser) && expectedSession === "graphical") {
            return { ready: true, credentialBoundary, installedDesktopIdentity, user: expectedUser, session: expectedSession };
          }
        } catch { /* retry only the read-only session observation */ }
        if (attempt + 1 < this.qgaAttempts) await this.boundedWait(deadlineAt);
      }
      return { ready: false, errorCode: "GRAPHICAL_SESSION_UNAVAILABLE", user: null, session: null };
    } catch (error) {
      await cancelPendingAuth();
      return { ready: false, errorCode: error?.code ?? "QGA_UNAVAILABLE", user: null, session: null };
    }
  }

  async execGuestAndWait({ binding, command, arguments: args, attempts, errorCode = "QGA_EXEC_FAILED", allowFailure = false, deadlineAt = Number.MAX_SAFE_INTEGER }) {
    this.assertDeadline(deadlineAt, errorCode);
    const started = await this.qgaControl({ control: "guest-exec", binding, command, arguments: args });
    const pid = started?.data?.pid ?? started?.pid ?? started?.data;
    if (!Number.isSafeInteger(pid)) throw Object.assign(new Error(`${command} did not start`), { code: errorCode });
    for (let poll = 0; poll < attempts; poll += 1) {
      this.assertDeadline(deadlineAt, errorCode);
      const response = await this.call("GET", `/nodes/${encode(binding.hostId)}/qemu/${encode(binding.vmId)}/agent/exec-status?pid=${pid}`);
      const status = response?.data ?? response;
      if (status?.exited === 1 || status?.exited === true) {
        const result = {
          exitcode: status.exitcode,
          stdout: Buffer.from(status["out-data"] ?? "", "base64").toString("utf8"),
          stderr: Buffer.from(status["err-data"] ?? "", "base64").toString("utf8"),
        };
        if (!allowFailure && result.exitcode !== 0) throw Object.assign(new Error(`${command} failed`), { code: errorCode });
        return result;
      }
      await this.boundedWait(deadlineAt);
    }
    throw Object.assign(new Error(`${command} timed out`), { code: errorCode });
  }

  async qgaControl({ control, binding, command, arguments: args }) {
    if (control === "guest-exec") {
      return this.call("POST", `/nodes/${encode(binding.hostId)}/qemu/${encode(binding.vmId)}/agent/exec`, {
        command, "extra-args": args, "capture-output": 1,
      });
    }
    const commandName = {
      "guest-ping": "ping",
      "guest-get-osinfo": "get-osinfo",
      "guest-get-users": "get-users",
    }[control];
    return this.call("POST", `/nodes/${encode(binding.hostId)}/qemu/${encode(binding.vmId)}/agent/${commandName}`);
  }

  async attestNetworkPolicy() {
    const response = await this.call("GET", "/nelos/network/policy");
    return response?.data ?? response;
  }

  async attestVmAbsent(binding) {
    const exact = await this.inspectVm(binding);
    const resourcesResponse = await this.call("GET", "/cluster/resources?type=vm");
    const resources = resourcesResponse?.data ?? resourcesResponse;
    const clusterAbsent = Array.isArray(resources) && !resources.some((item) => String(item.vmid) === String(binding.vmId));
    const networkResponse = await this.call("GET", "/nelos/network/mac-absence");
    const network = networkResponse?.data ?? networkResponse;
    const networkInventoryComplete = network?.schemaVersion === 1 && network?.kind === "nelos.proxmox-desktop.mac-absence.v1" &&
      network?.complete === true && Number.isSafeInteger(network?.scannedQemuCount) && network.scannedQemuCount >= 0 &&
      network.macAddress === binding.macAddress && network.networkId === binding.networkId;
    const macAbsent = networkInventoryComplete && network.absent === true;
    return { ...binding, absent: exact === null && clusterAbsent && macAbsent, macAbsent, networkInventoryComplete };
  }

  commitReceipt(receipt) {
    return this.receiptStore.commit(receipt);
  }
}
