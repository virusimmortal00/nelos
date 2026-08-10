import { dirname } from "node:path";

const UPID = /^UPID:[A-Za-z0-9._-]+:[A-Fa-f0-9]+:[A-Fa-f0-9]+:[A-Fa-f0-9]+:[^:]*:[^:]*:[^:]*:$/u;
const SAFE_NODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SAFE_GUEST_PATH = /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u;

export class ProxmoxApiError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "ProxmoxApiError";
    this.code = code;
    if (Number.isInteger(options.status)) this.status = options.status;
  }
}

function fail(code, message, options) {
  throw new ProxmoxApiError(code, message, options);
}

function assertNode(node) {
  if (!SAFE_NODE.test(node)) fail("api.invalid-node", "Proxmox node has an invalid format");
  return node;
}

function assertVmid(vmid) {
  if (!Number.isInteger(vmid) || vmid < 100 || vmid > 999_999_999) {
    fail("api.invalid-vmid", "Proxmox VMID is outside the supported range");
  }
  return vmid;
}

function encodePathSegment(value) {
  return encodeURIComponent(String(value));
}

function appendParameters(parameters, values = {}) {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "boolean") parameters.set(key, value ? "1" : "0");
    else if (Array.isArray(value)) {
      for (const item of value) parameters.append(key, String(item));
    } else if (typeof value === "object") parameters.set(key, JSON.stringify(value));
    else parameters.set(key, String(value));
  }
  return parameters;
}

function asUpid(value, operation) {
  if (typeof value !== "string" || !UPID.test(value)) {
    fail("api.mutation-missing-upid", `${operation} did not return a Proxmox task identifier`);
  }
  return value;
}

function assertGuestPath(path) {
  if (!SAFE_GUEST_PATH.test(path) || path.includes("..")) {
    fail("api.invalid-guest-path", "QGA destination path is not an absolute safe path");
  }
  return path;
}

export class ProxmoxApiClient {
  #baseUrl;
  #authorization;
  #fetch;
  #requestTimeoutMs;
  #sleep;

  constructor(options) {
    const {
      baseUrl,
      tokenId,
      tokenSecret,
      fetchImpl = globalThis.fetch,
      requestTimeoutMs = 30_000,
      sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    } = options ?? {};
    let parsed;
    try {
      parsed = new URL(baseUrl);
    } catch {
      fail("api.invalid-url", "PROXMOX_URL must be a valid HTTPS URL");
    }
    if (parsed.protocol !== "https:") fail("api.insecure-url", "PROXMOX_URL must use HTTPS");
    if (parsed.username || parsed.password || parsed.search || parsed.hash) {
      fail("api.invalid-url", "PROXMOX_URL cannot contain credentials, a query, or a fragment");
    }
    const normalizedPath = parsed.pathname.replace(/\/+$/u, "");
    parsed.pathname = normalizedPath.endsWith("/api2/json")
      ? normalizedPath
      : `${normalizedPath}/api2/json`.replace(/\/{2,}/gu, "/");
    if (typeof tokenId !== "string" || !/^[^\s=]+@[^\s=!]+![^\s=]+$/u.test(tokenId)) {
      fail("api.invalid-token-id", "PROXMOX_USERNAME must be a separated API token identifier");
    }
    if (typeof tokenSecret !== "string" || tokenSecret.length < 16 || /[\r\n]/u.test(tokenSecret)) {
      fail("api.invalid-token-secret", "PROXMOX_TOKEN is missing or malformed");
    }
    if (typeof fetchImpl !== "function") fail("api.fetch-unavailable", "Fetch implementation is unavailable");
    if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1_000) {
      fail("api.invalid-timeout", "API request timeout must be at least one second");
    }
    this.#baseUrl = parsed.toString().replace(/\/$/u, "");
    this.#authorization = `PVEAPIToken=${tokenId}=${tokenSecret}`;
    this.#fetch = fetchImpl;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#sleep = sleep;
  }

  async request(method, path, options = {}) {
    if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/u.test(path) || path.includes("..")) {
      fail("api.invalid-path", "Proxmox API path is unsafe");
    }
    const url = new URL(`${this.#baseUrl}${path}`);
    appendParameters(url.searchParams, options.query);
    const headers = {
      Accept: "application/json",
      Authorization: this.#authorization,
    };
    const request = {
      method,
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? this.#requestTimeoutMs),
    };
    if (options.body !== undefined) {
      headers["Content-Type"] = "application/x-www-form-urlencoded;charset=UTF-8";
      request.body = appendParameters(new URLSearchParams(), options.body).toString();
    }
    let response;
    try {
      response = await this.#fetch(url, request);
    } catch (error) {
      fail("api.request-failed", `Proxmox API request failed for ${method} ${path}`, { cause: error });
    }
    if (!response.ok) {
      fail("api.http-error", `Proxmox API returned HTTP ${response.status} for ${method} ${path}`, {
        status: response.status,
      });
    }
    let envelope;
    try {
      envelope = JSON.parse(await response.text());
    } catch (error) {
      fail("api.invalid-response", `Proxmox API returned invalid JSON for ${method} ${path}`, { cause: error });
    }
    if (envelope === null || typeof envelope !== "object" || !("data" in envelope)) {
      fail("api.invalid-response", `Proxmox API response omitted data for ${method} ${path}`);
    }
    return envelope.data;
  }

  listClusterVms() {
    return this.request("GET", "/cluster/resources", { query: { type: "vm" } });
  }

  async isClusterVmidFree(vmid) {
    assertVmid(vmid);
    try {
      const result = await this.request("GET", "/cluster/nextid", { query: { vmid } });
      if (Number(result) !== vmid) {
        fail("api.nextid-mismatch", "Proxmox nextid response did not echo the requested free VMID");
      }
      return true;
    } catch (error) {
      if (
        error instanceof ProxmoxApiError &&
        error.code === "api.http-error" &&
        error.status >= 400 &&
        error.status < 500 &&
        ![401, 403, 429].includes(error.status)
      ) {
        return false;
      }
      throw error;
    }
  }

  getVersion() {
    return this.request("GET", "/version");
  }

  getVmConfig(node, vmid) {
    assertNode(node);
    assertVmid(vmid);
    return this.request(
      "GET",
      `/nodes/${encodePathSegment(node)}/qemu/${vmid}/config`,
      { query: { current: true } },
    );
  }

  getVmStatus(node, vmid) {
    assertNode(node);
    assertVmid(vmid);
    return this.request(
      "GET",
      `/nodes/${encodePathSegment(node)}/qemu/${vmid}/status/current`,
    );
  }

  async cloneLinkedVm(options) {
    const { node, sourceVmid, newVmid, name, description, pool } = options;
    assertNode(node);
    assertVmid(sourceVmid);
    assertVmid(newVmid);
    const result = await this.request(
      "POST",
      `/nodes/${encodePathSegment(node)}/qemu/${sourceVmid}/clone`,
      {
        body: {
          newid: newVmid,
          name,
          description,
          full: false,
          target: node,
          pool,
        },
      },
    );
    return asUpid(result, "linked clone");
  }

  async updateVmConfig(node, vmid, changes) {
    assertNode(node);
    assertVmid(vmid);
    const result = await this.request(
      "POST",
      `/nodes/${encodePathSegment(node)}/qemu/${vmid}/config`,
      { body: changes },
    );
    if (result === null || result === undefined) return null;
    return asUpid(result, "VM configuration update");
  }

  async startVm(node, vmid) {
    assertNode(node);
    assertVmid(vmid);
    const result = await this.request(
      "POST",
      `/nodes/${encodePathSegment(node)}/qemu/${vmid}/status/start`,
    );
    return asUpid(result, "VM start");
  }

  async stopVm(node, vmid) {
    assertNode(node);
    assertVmid(vmid);
    const result = await this.request(
      "POST",
      `/nodes/${encodePathSegment(node)}/qemu/${vmid}/status/stop`,
    );
    return asUpid(result, "VM stop");
  }

  async destroyVm(node, vmid) {
    assertNode(node);
    assertVmid(vmid);
    const result = await this.request(
      "DELETE",
      `/nodes/${encodePathSegment(node)}/qemu/${vmid}`,
    );
    return asUpid(result, "VM destroy");
  }

  async waitForTask(node, upid, options = {}) {
    assertNode(node);
    asUpid(upid, "task wait");
    const timeoutMs = options.timeoutMs ?? 15 * 60_000;
    const pollMs = options.pollMs ?? 1_000;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const status = await this.request(
        "GET",
        `/nodes/${encodePathSegment(node)}/tasks/${encodePathSegment(upid)}/status`,
      );
      if (status?.status === "stopped") {
        if (status.exitstatus !== "OK") {
          fail("api.task-failed", "Proxmox task completed unsuccessfully");
        }
        return status;
      }
      await this.#sleep(pollMs);
    }
    fail("api.task-timeout", "Proxmox task did not finish before the deadline");
  }

  async pingGuestAgent(node, vmid) {
    assertNode(node);
    assertVmid(vmid);
    await this.request(
      "POST",
      `/nodes/${encodePathSegment(node)}/qemu/${vmid}/agent/ping`,
      { timeoutMs: 10_000 },
    );
    return true;
  }

  async guestExec(node, vmid, command, options = {}) {
    assertNode(node);
    assertVmid(vmid);
    if (!Array.isArray(command) || command.length === 0 || command.some((item) => typeof item !== "string")) {
      fail("api.invalid-command", "QGA command must be a non-empty string array");
    }
    const started = await this.request(
      "POST",
      `/nodes/${encodePathSegment(node)}/qemu/${vmid}/agent/exec`,
      {
        body: {
          command,
          "input-data": options.inputData,
        },
        timeoutMs: options.requestTimeoutMs,
      },
    );
    if (!Number.isInteger(started?.pid) || started.pid < 0) {
      fail("api.qga-invalid-pid", "QGA exec did not return a valid process identifier");
    }
    const timeoutMs = options.timeoutMs ?? 5 * 60_000;
    const pollMs = options.pollMs ?? 500;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() <= deadline) {
      const status = await this.request(
        "GET",
        `/nodes/${encodePathSegment(node)}/qemu/${vmid}/agent/exec-status`,
        { query: { pid: started.pid } },
      );
      if (status?.exited) {
        if (status["out-truncated"] || status["err-truncated"]) {
          fail("api.qga-output-truncated", "QGA command output was truncated");
        }
        return {
          exitCode: Number.isInteger(status.exitcode) ? status.exitcode : null,
          signal: status.signal ?? null,
          stdout: status["out-data"] ?? "",
          stderr: status["err-data"] ?? "",
        };
      }
      await this.#sleep(pollMs);
    }
    fail("api.qga-timeout", "QGA command did not finish before the deadline");
  }

  async writeGuestFile(node, vmid, remotePath, content, options = {}) {
    assertGuestPath(remotePath);
    if (!Buffer.isBuffer(content)) fail("api.invalid-file-content", "QGA file content must be a Buffer");
    const chunkBytes = options.chunkBytes ?? 32 * 1024;
    if (!Number.isInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 40 * 1024) {
      fail("api.invalid-chunk-size", "QGA file chunk size is outside the supported range");
    }
    const parent = dirname(remotePath);
    let result = await this.guestExec(node, vmid, ["/usr/bin/install", "-d", "-m", "0700", parent]);
    if (result.exitCode !== 0) fail("api.qga-file-prepare-failed", "QGA could not create the file parent");
    result = await this.guestExec(node, vmid, ["/usr/bin/install", "-m", "0600", "/dev/null", remotePath]);
    if (result.exitCode !== 0) fail("api.qga-file-prepare-failed", "QGA could not initialize the file");
    for (let offset = 0; offset < content.length; offset += chunkBytes) {
      const encoded = content.subarray(offset, offset + chunkBytes).toString("base64");
      result = await this.guestExec(
        node,
        vmid,
        [
          "/bin/sh",
          "-ceu",
          'base64 -d >> "$1"',
          "nelos-qga-write",
          remotePath,
        ],
        { inputData: encoded },
      );
      if (result.exitCode !== 0) fail("api.qga-file-write-failed", "QGA could not append a file chunk");
    }
    return { bytesWritten: content.length };
  }
}
