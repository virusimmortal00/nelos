export const RUNTIME_UPGRADE_RECOVERY_ACTION =
  "Quit and relaunch Codex, then open a fresh task.";

export const RUNTIME_UPGRADE_MATRIX_V1 = Object.freeze([
  "old-worker-replacement",
  "same-version-concurrency",
  "mixed-generations",
  "missing-backing-files",
  "ambiguous-install",
  "pid-reuse",
  "crash-recovery",
  "compatible-rollback",
  "owner-client-reload",
  "full-restart",
]);

/**
 * Reload an MCP server only through the app-server client that owns that
 * connection. Host-owned sibling connections are deliberately out of scope:
 * the plugin cannot prove ownership and must never signal them.
 */
export async function reloadOwnedMcpServerV1({
  client,
  ownsAppServer,
  reloadSupported,
  serverName = "nelos",
  waitForOwnedChildren,
} = {}) {
  if (ownsAppServer !== true || reloadSupported !== true) {
    return {
      state: "restart-required",
      reloaded: false,
      recovery: RUNTIME_UPGRADE_RECOVERY_ACTION,
    };
  }
  if (!client || typeof client.request !== "function" || typeof waitForOwnedChildren !== "function") {
    throw new Error("owned MCP reload requires a client and bounded child verifier");
  }
  await client.request("config/mcpServer/reload", { name: serverName });
  const closed = await waitForOwnedChildren();
  if (closed !== true) {
    throw new Error("owned MCP children did not close after reload");
  }
  return { state: "reloaded", reloaded: true, serverName };
}
