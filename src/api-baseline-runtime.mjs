import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
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

const SAFE_RUNTIME_ERRORS = new Set(["UNKNOWN_SEALED_TASK", "SEALED_REQUEST_MISMATCH", "ROUTE_CONTROL_REQUIRED", "UNAPPROVED_CREDENTIAL_PATH", "API_CREDENTIAL_UNAVAILABLE", "API_CREDENTIAL_PERMISSIONS_UNSAFE", "API_CREDENTIAL_NOT_GIT_EXCLUDED", "API_CREDENTIAL_DECLARATION_INVALID", "API_CODEX_PROCESS_FAILED"]);
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

export async function withDisposableApiAttempt({ keyFile = APPROVED_API_KEY_FILE, execute }) {
  if (typeof execute !== "function") throw new TypeError("execute callback is required");
  const root = await mkdtemp(resolve(tmpdir(), "nelos-api-baseline-attempt-"));
  const home = resolve(root, "home");
  const workspace = resolve(root, "workspace");
  const temporary = resolve(root, "tmp");
  await Promise.all([home, workspace, temporary].map((path) => mkdir(path, { mode: 0o700 })));
  let apiKey;
  try {
    apiKey = await readApprovedApiKey({ keyFile });
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
