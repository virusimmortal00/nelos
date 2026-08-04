#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalBytes, sha256Bytes } from "../src/experimentation-contract/index.mjs";
import { candidateTaskEnvelope, createStarterTaskPackage, gradeTaskAttempt, STARTER_TASK_FAMILIES } from "../src/experimentation-corpus/index.mjs";
import { safeApiRuntimeError, withDisposableApiAttempt } from "../src/api-baseline-runtime.mjs";
import { parseCodexJsonl } from "../src/signed-in-pilot-telemetry.mjs";

const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;

async function requestFromStdin() { let text = ""; for await (const chunk of process.stdin) text += chunk; return JSON.parse(text); }
function taskPackage(taskId) {
  for (const family of STARTER_TASK_FAMILIES) { const value = createStarterTaskPackage(family.id); if (value.task.taskId === taskId) return value; }
  throw Object.assign(new Error("UNKNOWN_SEALED_TASK"), { code: "UNKNOWN_SEALED_TASK" });
}

async function stage(workspace, value) {
  const envelope = candidateTaskEnvelope(value);
  await mkdir(resolve(workspace, "assets"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(workspace, "candidate-task.json"), canonicalBytes(envelope), { mode: 0o600 });
  for (const asset of envelope.assets) await writeFile(resolve(workspace, "assets", `${asset.assetId.split(":").at(-1)}.json`), Buffer.from(asset.bytes, "base64"), { mode: 0o600 });
  await writeFile(resolve(workspace, "output-schema.json"), canonicalBytes({ type: "object", additionalProperties: false, required: ["answer", "family"], properties: { answer: { type: "string" }, family: { type: "string" } } }), { mode: 0o600 });
  await writeFile(resolve(workspace, "task-prompt.txt"), `${value.task.prompt.text}\nUse only candidate-task.json and assets/. Return only the required JSON object. Do not access paths outside this disposable workspace.\n`, { mode: 0o600 });
}

function run(command, args, { env, cwd, input, timeoutMs }) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    const stdout = []; const stderr = []; let captured = 0; let timedOut = false;
    const capture = (target) => (chunk) => { captured += chunk.byteLength; if (captured > MAX_CAPTURE_BYTES) child.kill("SIGTERM"); else target.push(chunk); };
    child.stdout.on("data", capture(stdout)); child.stderr.on("data", capture(stderr));
    child.once("error", () => reject(Object.assign(new Error("API_CODEX_PROCESS_FAILED"), { code: "API_CODEX_PROCESS_FAILED" })));
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, timeoutMs);
    child.once("close", (code) => { clearTimeout(timer); resolveRun({ code, timedOut, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }); });
    child.stdin.end(input);
  });
}

const request = await requestFromStdin();
let response;
try {
  response = await withDisposableApiAttempt({ execute: async ({ workspace, env }) => {
    const sealed = taskPackage(request.declaredInputs.taskId);
    if (sealed.task.digest !== request.declaredInputs.taskDigest || request.budget.networkRequests !== 0) throw Object.assign(new Error("SEALED_REQUEST_MISMATCH"), { code: "SEALED_REQUEST_MISMATCH" });
    if (request.requestedRoute.modelId === "model:product-default" || request.requestedRoute.adapter !== "direct-codex") throw Object.assign(new Error("ROUTE_CONTROL_REQUIRED"), { code: "ROUTE_CONTROL_REQUIRED" });
    await stage(workspace, sealed);
    await run("git", ["init", "-q"], { env, cwd: workspace, input: "", timeoutMs: 10_000 });
    const outputPath = resolve(workspace, "result.json");
    const model = request.requestedRoute.modelId.slice("model:".length);
    const args = ["exec", "--json", "--ephemeral", "--ignore-user-config", "--ignore-rules", "--sandbox", "workspace-write", "--skip-git-repo-check", "-C", workspace, "-m", model, "-c", `model_reasoning_effort=\"${request.requestedRoute.reasoningEffort}\"`, "--output-schema", resolve(workspace, "output-schema.json"), "-o", outputPath, "-"];
    const started = Date.now();
    const result = await run(process.env.NELOS_API_CODEX_BIN ?? "codex", args, { env, cwd: workspace, input: await readFile(resolve(workspace, "task-prompt.txt")), timeoutMs: request.budget.wallClockSeconds * 1000 });
    let value = {};
    try { value = JSON.parse(await readFile(outputPath, "utf8")); } catch {}
    const output = canonicalBytes(value);
    const grade = gradeTaskAttempt({ taskPackage: sealed, submission: { outputs: [{ id: "result", encoding: "base64", bytes: output.toString("base64") }] }, observation: { attemptId: `${request.operationId}:candidate`, contaminated: false, termination: result.timedOut ? "timeout" : "exited", exitCode: result.code ?? 1 }, attestation: { issuer: "api-baseline-runtime", candidateEnvironmentId: `disposable:${request.trialId}:${request.attempt}`, graderEnvironmentId: "host-grader:api-baseline" } });
    const events = parseCodexJsonl(result.stdout);
    const measurements = [{ metricId: "strict_pass_rate", value: grade.strictPass ? 1 : 0 }, { metricId: "candidate_failure_rate", value: result.code === 0 ? 0 : 1 }, { metricId: "terminal_wall_ms", value: Date.now() - started }, { metricId: "input_tokens", value: events.inputTokens }, { metricId: "output_tokens", value: events.outputTokens }, { metricId: "provider_executions", value: 1 }];
    return { outcome: result.code === 0 ? "succeeded" : "failed", observedRoute: request.requestedRoute, operationId: request.operationId, outputs: [{ id: "result", digest: sha256Bytes(output), byteLength: output.byteLength }], artifacts: [], measurements, evidenceComplete: true, retryable: false };
  } });
} catch (error) {
  process.stderr.write(`${JSON.stringify({ error: safeApiRuntimeError(error) })}\n`);
  process.exitCode = 1;
}
if (response) process.stdout.write(JSON.stringify(response));
