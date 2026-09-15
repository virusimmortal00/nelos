import { ExecutorAppServerSessionV1 } from "../src/executor-app-server-session.mjs";
import { probeAppServerExecutionV1 } from "../src/app-server-execution-profile.mjs";

// An explicit, bounded read-only check using the same session as the executor.
// Reuses Codex-managed authentication without starting threads or model turns.
const [command, cwd, codexHome, model = "gpt-6-astra", reasoningEffort = "medium"] = process.argv.slice(2);
if (!command || !cwd || !codexHome || process.argv.length > 7) {
  throw new Error("usage: node scripts/probe-owned-execution.mjs <absolute-codex> <absolute-cwd> <absolute-codex-home> [model] [effort]");
}
const session = new ExecutorAppServerSessionV1({ command, cwd, codexHome });
try {
  await session.open();
  const report = await probeAppServerExecutionV1({
    observedVersion: session.status().observedVersion,
    request: (...args) => session.request(...args),
    options: { cwd, model, reasoningEffort, permissionProfile: ":read-only", approvalPolicy: "never" },
  });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.state !== "discovery-complete") process.exitCode = 1;
} finally {
  session.close();
  await session.stopped;
}
