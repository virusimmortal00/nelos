const SUCCESS = new Set(["OK", "completed"]);

function encode(value) {
  return encodeURIComponent(String(value));
}

function bindingDescription(binding, extra = {}) {
  return `nelos-desktop-v1:${Buffer.from(JSON.stringify({ ...binding, ...extra })).toString("base64url")}`;
}

function decodeBinding(description) {
  if (typeof description !== "string" || !description.startsWith("nelos-desktop-v1:")) return null;
  try {
    return JSON.parse(Buffer.from(description.slice("nelos-desktop-v1:".length), "base64url").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Proxmox VE v1 provider adapter. The injected transport owns TLS and token
 * handling and exposes request({method,path,body}). No live endpoint or secret
 * is accepted by this class, which keeps offline fixtures and production I/O
 * behind the same narrow boundary.
 */
export class ProxmoxVeDesktopAdapterV1 {
  constructor({ transport, receiptStore, providerId, qgaAttempts = 12, taskAttempts = 120, taskPollMs = 1_000, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    if (typeof transport?.request !== "function") throw new TypeError("transport.request is required");
    if (typeof receiptStore?.commit !== "function") throw new TypeError("receiptStore.commit is required");
    if (typeof providerId !== "string" || providerId.length === 0) throw new TypeError("providerId is required");
    if (!Number.isSafeInteger(qgaAttempts) || qgaAttempts < 1 || qgaAttempts > 120) throw new TypeError("qgaAttempts is invalid");
    if (!Number.isSafeInteger(taskAttempts) || taskAttempts < 1 || taskAttempts > 600) throw new TypeError("taskAttempts is invalid");
    if (!Number.isSafeInteger(taskPollMs) || taskPollMs < 1 || taskPollMs > 10_000) throw new TypeError("taskPollMs is invalid");
    if (typeof wait !== "function") throw new TypeError("wait is invalid");
    this.transport = transport;
    this.receiptStore = receiptStore;
    this.providerId = providerId;
    this.qgaAttempts = qgaAttempts;
    this.taskAttempts = taskAttempts;
    this.taskPollMs = taskPollMs;
    this.wait = wait;
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
        imageId: "unowned", state: data?.status ?? "unknown",
      };
      return {
        providerId: owned.providerId,
        hostId: owned.hostId,
        vmId: String(owned.vmId),
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
    if (owned === null) return null;
    return {
      providerId: owned.providerId, hostId: owned.hostId, vmId: String(owned.vmId),
      leaseId: owned.leaseId, fencingToken: owned.fencingToken, imageId: owned.imageId,
      runId: owned.runId, automationUser: owned.automationUser, stateRoot: owned.stateRoot,
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

  destroyVm({ binding }) {
    return this.mutate("DELETE", `/nodes/${encode(binding.hostId)}/qemu/${encode(binding.vmId)}`, {
      node: binding.hostId, purge: 1, "destroy-unreferenced-disks": 1,
    });
  }

  quarantineVm({ binding, reason }) {
    return this.mutate("PUT", `/nodes/${encode(binding.hostId)}/qemu/${encode(binding.vmId)}/config`, {
      node: binding.hostId,
      protection: 1,
      onboot: 0,
      net0: "virtio,link_down=1,firewall=1",
      tags: "nelos-desktop;quarantined;do-not-reuse",
      description: bindingDescription(binding, { imageId: "preserved", quarantined: true, reason, state: "quarantined" }),
    });
  }

  async reconcileMutation({ binding, mutation, providerOperationId }) {
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
    const observed = await this.inspectVm(binding);
    const committed = mutation === "destroy" ? observed === null : observed !== null;
    return { status: committed ? "committed" : "ambiguous", providerOperationId: null };
  }

  async waitForQga({ binding, runtimeBinding = null, expectedUser, expectedSession }) {
    for (let attempt = 0; attempt < this.qgaAttempts; attempt += 1) {
      try {
        await this.qgaControl({ control: "guest-ping", binding, command: null, arguments: [] });
        if (runtimeBinding) {
          const encoded = Buffer.from(JSON.stringify(runtimeBinding)).toString("base64");
          const started = await this.qgaControl({ control: "guest-exec", binding, command: "/usr/libexec/nelos-bind-runtime", arguments: [encoded] });
          const pid = started?.data?.pid ?? started?.pid ?? started?.data;
          if (!Number.isSafeInteger(pid)) throw Object.assign(new Error("binding helper did not start"), { code: "QGA_BINDING_FAILED" });
          let completed = false;
          for (let poll = 0; poll < this.qgaAttempts; poll += 1) {
            const response = await this.call("GET", `/nodes/${encode(binding.hostId)}/qemu/${encode(binding.vmId)}/agent/exec-status?pid=${pid}`);
            const status = response?.data ?? response;
            if (status?.exited === 1 || status?.exited === true) { if (status.exitcode !== 0) throw Object.assign(new Error("binding helper failed"), { code: "QGA_BINDING_FAILED" }); completed = true; break; }
            await this.wait(this.taskPollMs);
          }
          if (!completed) throw Object.assign(new Error("binding helper timed out"), { code: "QGA_BINDING_FAILED" });
          runtimeBinding = null;
        }
        const users = await this.qgaControl({ control: "guest-get-users", binding, command: null, arguments: [] });
        const sessions = Array.isArray(users?.data) ? users.data : [];
        if (sessions.some((user) => user.user === expectedUser) && expectedSession === "graphical") {
          return { ready: true, user: expectedUser, session: expectedSession };
        }
      } catch (error) {
        if (attempt === this.qgaAttempts - 1) return { ready: false, errorCode: error?.code ?? "QGA_UNAVAILABLE", user: null, session: null };
      }
    }
    return { ready: false, user: null, session: null };
  }

  async qgaControl({ control, binding, command, arguments: args }) {
    if (control === "guest-exec") {
      return this.call("POST", `/nodes/${encode(binding.hostId)}/qemu/${encode(binding.vmId)}/agent/exec`, {
        command, "extra-args": args,
      });
    }
    const commandName = {
      "guest-ping": "ping",
      "guest-get-osinfo": "get-osinfo",
      "guest-get-users": "get-users",
    }[control];
    return this.call("POST", `/nodes/${encode(binding.hostId)}/qemu/${encode(binding.vmId)}/agent/${commandName}`);
  }

  async attestVmAbsent(binding) {
    const exact = await this.inspectVm(binding);
    const resourcesResponse = await this.call("GET", "/cluster/resources?type=vm");
    const resources = resourcesResponse?.data ?? resourcesResponse;
    const clusterAbsent = Array.isArray(resources) && !resources.some((item) => String(item.vmid) === String(binding.vmId));
    return { ...binding, absent: exact === null && clusterAbsent };
  }

  commitReceipt(receipt) {
    return this.receiptStore.commit(receipt);
  }
}
