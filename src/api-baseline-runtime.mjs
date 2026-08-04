import { execFile } from "node:child_process";
import { mkdir, mkdtemp, open, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
export const APPROVED_API_KEY_FILE = "/Users/bobby.sayers/src/nelos/.env.local";

export class ApiCredentialError extends Error {
  constructor(code) {
    super(code);
    this.name = "ApiCredentialError";
    this.code = code;
  }
}

const SAFE_RUNTIME_ERRORS = new Set(["UNKNOWN_SEALED_TASK", "SEALED_REQUEST_MISMATCH", "ROUTE_CONTROL_REQUIRED", "UNAPPROVED_CREDENTIAL_PATH", "API_CREDENTIAL_UNAVAILABLE", "API_CREDENTIAL_PERMISSIONS_UNSAFE", "API_CREDENTIAL_NOT_GIT_EXCLUDED", "API_CREDENTIAL_DECLARATION_INVALID", "API_CODEX_PROCESS_FAILED", "ATTEMPT_CONTROL_INVALID", "ATTEMPT_REPLAY_REJECTED", "RUNTIME_PROVENANCE_MISMATCH", "RUNTIME_RECEIPT_MISSING", "RUNTIME_RECEIPT_INVALID", "RUNTIME_ROUTE_MISMATCH", "PROVIDER_EXPOSURE_EXCEEDED", "PROXY_CONFIGURATION_INVALID", "PROXY_ROUTE_INVALID", "PROXY_MULTIPLE_REQUESTS", "PROXY_REQUEST_REJECTED", "PROXY_AUTH_REJECTED", "PROXY_REQUEST_TOO_LARGE", "PROXY_REQUEST_INVALID", "PROXY_ROUTE_MISMATCH", "PROXY_FORWARD_FAILED", "PROXY_REQUEST_NOT_OBSERVED", "PROXY_UPSTREAM_NOT_OBSERVED", "PROXY_UPSTREAM_REJECTED", "PROXY_UPSTREAM_RESPONSE_INVALID", "PROXY_UPSTREAM_RESPONSE_TOO_LARGE", "PROXY_RECEIPT_INCOMPLETE", "PROXY_OBSERVED_MODEL_MISMATCH"]);
export function safeApiRuntimeError(error) { return SAFE_RUNTIME_ERRORS.has(error?.code) ? error.code : "API_BASELINE_ADAPTER_FAILED"; }

function reject(code) { throw new ApiCredentialError(code); }

export async function readApprovedApiKey({ keyFile = APPROVED_API_KEY_FILE, git = executeFile } = {}) {
  if (resolve(keyFile) !== APPROVED_API_KEY_FILE) reject("UNAPPROVED_CREDENTIAL_PATH");
  let metadata;
  try { metadata = await stat(keyFile); } catch { reject("API_CREDENTIAL_UNAVAILABLE"); }
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || (typeof process.getuid === "function" && metadata.uid !== process.getuid())) reject("API_CREDENTIAL_PERMISSIONS_UNSAFE");
  try {
    const { stdout } = await git("git", ["-C", dirname(keyFile), "check-ignore", "--quiet", "--", keyFile]);
    void stdout;
  } catch { reject("API_CREDENTIAL_NOT_GIT_EXCLUDED"); }
  let bytes;
  try { bytes = await readFile(keyFile); } catch { reject("API_CREDENTIAL_UNAVAILABLE"); }
  const text = bytes.toString("utf8");
  bytes.fill(0);
  const matches = [...text.matchAll(/^OPENAI_API_KEY=(?:'([^']*)'|"([^"]*)"|([^\r\n#]*))\s*$/gmu)];
  if (matches.length !== 1) reject("API_CREDENTIAL_DECLARATION_INVALID");
  const value = (matches[0][1] ?? matches[0][2] ?? matches[0][3] ?? "").trim();
  if (!/^sk-[A-Za-z0-9_-]{16,}$/u.test(value)) reject("API_CREDENTIAL_DECLARATION_INVALID");
  return value;
}

export async function withDisposableApiAttempt({ keyFile = APPROVED_API_KEY_FILE, loadCredential = () => readApprovedApiKey({ keyFile }), execute }) {
  if (typeof execute !== "function") throw new TypeError("execute callback is required");
  const root = await mkdtemp(resolve(tmpdir(), "nelos-api-baseline-attempt-"));
  const home = resolve(root, "home");
  const workspace = resolve(root, "workspace");
  const temporary = resolve(root, "tmp");
  await Promise.all([home, workspace, temporary].map((path) => mkdir(path, { mode: 0o700 })));
  let apiKey;
  try {
    apiKey = await loadCredential();
    const env = Object.freeze({
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      LANG: "C.UTF-8",
      HOME: home,
      CODEX_HOME: resolve(home, ".codex"),
      XDG_CACHE_HOME: resolve(home, ".cache"),
      XDG_CONFIG_HOME: resolve(home, ".config"),
      XDG_DATA_HOME: resolve(home, ".local", "share"),
      TMPDIR: temporary,
      OPENAI_API_KEY: apiKey,
    });
    return await execute({ root, home, workspace, temporary, env });
  } finally {
    apiKey = undefined;
    await rm(root, { recursive: true, force: true });
  }
}

export async function resolveExecutable(command, pathValue = process.env.PATH ?? "/usr/bin:/bin") {
  if (command.includes("/")) return realpath(command);
  for (const directory of pathValue.split(":")) {
    if (!directory.startsWith("/")) continue;
    try {
      const candidate = await realpath(resolve(directory, command));
      const metadata = await stat(candidate);
      if (metadata.isFile() && (metadata.mode & 0o111) !== 0) return candidate;
    } catch (error) { if (!["ENOENT", "EACCES", "ENOTDIR"].includes(error.code)) throw error; }
  }
  reject("API_CODEX_PROCESS_FAILED");
}

export async function claimApiOperation(request, { ledgerRoot }) {
  if (typeof ledgerRoot !== "string" || !ledgerRoot.startsWith("/")) reject("ATTEMPT_CONTROL_INVALID");
  await mkdir(ledgerRoot, { recursive: true, mode: 0o700 });
  const path = resolve(ledgerRoot, request.operationId.slice(3));
  let handle;
  try { handle = await open(path, "wx", 0o400); } catch (error) { if (error.code === "EEXIST") reject("ATTEMPT_REPLAY_REJECTED"); throw error; }
  try { await handle.writeFile(JSON.stringify({ operationId: request.operationId, trialId: request.trialId, attempt: request.attempt, leaseId: request.lease.leaseId, fencingToken: request.lease.fencingToken })); await handle.sync(); } finally { await handle.close(); }
}
