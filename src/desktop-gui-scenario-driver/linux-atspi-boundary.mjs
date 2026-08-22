import { spawn } from "node:child_process";

import { DesktopGuiDriverError } from "./index.mjs";

const HELPER = "/usr/libexec/nelos-desktop-atspi";
const OPERATIONS = new Set([
  "list_tasks", "activate_expected_task", "active_task", "click", "keypress", "scroll", "select_menu",
  "type_text", "wait_for", "accessibility_tree", "window_state", "query_element", "task_state",
  "text_present", "window_count", "protected_capture_regions", "capture_screenshot", "health",
]);

/**
 * Fixed Linux AT-SPI helper boundary. The helper is provisioned with the golden
 * image and has no generic command operation; this class never invokes a shell.
 */
export class LinuxAtspiBoundary {
  async #request(operation, payload = {}, bytes = null, signal) {
    if (!OPERATIONS.has(operation)) throw new DesktopGuiDriverError("FORBIDDEN_ACTION", "unsupported accessibility operation");
    return new Promise((resolve, reject) => {
      const child = spawn(HELPER, [operation], { shell: false, stdio: ["pipe", "pipe", "ignore"], signal });
      const chunks = [];
      let size = 0;
      let overflow = false;
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > 8_388_608) { overflow = true; child.kill("SIGKILL"); }
        else chunks.push(chunk);
      });
      child.once("error", (error) => reject(new DesktopGuiDriverError(error.name === "AbortError" ? "ACTION_TIMEOUT" : "GUI_BOUNDARY_UNAVAILABLE", "Linux AT-SPI helper failed")));
      child.once("close", (code) => {
        if (overflow) return reject(new DesktopGuiDriverError("INVALID_GUI_OBSERVATION", "Linux AT-SPI helper output exceeded its bound"));
        if (code !== 0) return reject(new DesktopGuiDriverError(code === 70 ? "DESKTOP_CRASH" : code === 71 ? "TASK_STALLED" : "ACTION_ERROR", "Linux AT-SPI operation failed"));
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(value?.bytesBase64 === undefined ? value : Buffer.from(value.bytesBase64, "base64"));
        } catch {
          reject(new DesktopGuiDriverError("INVALID_GUI_OBSERVATION", "Linux AT-SPI helper returned invalid data"));
        }
      });
      child.stdin.on("error", () => reject(new DesktopGuiDriverError("GUI_BOUNDARY_UNAVAILABLE", "Linux AT-SPI helper input failed")));
      const header = Buffer.from(`${JSON.stringify(payload)}\n`, "utf8");
      child.stdin.write(header, () => {
        header.fill(0);
        if (bytes !== null) child.stdin.write(bytes);
        child.stdin.end();
      });
    });
  }

  listTasks({ signal }) { return this.#request("list_tasks", {}, null, signal); }
  activateExpectedTask({ scenarioId, taskId, title, signal }) { return this.#request("activate_expected_task", { scenarioId, taskId, title }, null, signal); }
  activeTask({ signal }) { return this.#request("active_task", {}, null, signal); }
  click({ target, signal }) { return this.#request("click", { target }, null, signal); }
  keypress({ target, key, signal }) { return this.#request("keypress", { target, key }, null, signal); }
  scroll({ target, direction, amount, signal }) { return this.#request("scroll", { target, direction, amount }, null, signal); }
  selectMenu({ target, menuPath, signal }) { return this.#request("select_menu", { target, menuPath }, null, signal); }
  typeText({ target, bytes, signal }) { return this.#request("type_text", { target, byteLength: bytes.length }, bytes, signal); }
  waitFor({ target, condition, signal }) { return this.#request("wait_for", { target, condition }, null, signal); }
  accessibilityTree({ signal }) { return this.#request("accessibility_tree", {}, null, signal); }
  windowState({ signal }) { return this.#request("window_state", {}, null, signal); }
  queryElement({ target, signal }) { return this.#request("query_element", { target }, null, signal); }
  taskState({ target, expected, signal }) { return this.#request("task_state", { target, expected }, null, signal); }
  textPresent({ target, bytes, signal }) { return this.#request("text_present", { target, byteLength: bytes.length }, bytes, signal); }
  windowCount({ target, signal }) { return this.#request("window_count", { target }, null, signal); }
  protectedCaptureRegions({ kinds, signal }) { return this.#request("protected_capture_regions", { kinds }, null, signal); }
  captureScreenshot({ exclude, signal }) { return this.#request("capture_screenshot", { exclude }, null, signal); }
  health({ signal }) { return this.#request("health", {}, null, signal); }
}
