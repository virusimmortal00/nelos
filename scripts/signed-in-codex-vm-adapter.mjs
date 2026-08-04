#!/usr/bin/env node

import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

import { canonicalBytes, sha256Bytes } from "../src/experimentation-contract/index.mjs";
import {
  STARTER_TASK_FAMILIES,
  candidateTaskEnvelope,
  createStarterTaskPackage,
  gradeTaskAttempt,
} from "../src/experimentation-corpus/index.mjs";
import { parseCodexJsonl, parseProcessTime } from "../src/signed-in-pilot-telemetry.mjs";

const executeFile = promisify(execFile);
const COLIMA = process.env.NELOS_PILOT_COLIMA ?? "colima";
const PROFILE = process.env.NELOS_PILOT_COLIMA_PROFILE ?? "nelos-pilot";
const RUNTIME = process.env.NELOS_PILOT_VM_RUNTIME;
const SEED_ROOT = process.env.NELOS_PILOT_VM_SEED_ROOT ?? "/var/lib/nelos-pilot/auth-seed";
const EVIDENCE_ROOT = process.env.NELOS_PILOT_EVIDENCE_DIR;
const IMAGE = process.env.NELOS_PILOT_IMAGE;
const MAX_BUFFER = 16 * 1024 * 1024;

function required(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

async function readRequest() {
  let bytes = "";
  for await (const chunk of process.stdin) bytes += chunk;
  return JSON.parse(bytes);
}

function taskPackageFor(taskId) {
  for (const family of STARTER_TASK_FAMILIES) {
    const taskPackage = createStarterTaskPackage(family.id);
    if (taskPackage.task.taskId === taskId) return { family, taskPackage };
  }
  throw new Error(`pilot request references an unknown task: ${taskId}`);
}

async function stageCandidate(directory, taskPackage) {
  const envelope = candidateTaskEnvelope(taskPackage);
  const assets = resolve(directory, "assets");
  await mkdir(assets, { recursive: true, mode: 0o700 });
  await writeFile(resolve(directory, "candidate-task.json"), canonicalBytes(envelope), { mode: 0o600 });
  for (const asset of envelope.assets) {
    await writeFile(resolve(assets, `${asset.assetId.split(":").at(-1)}.json`), Buffer.from(asset.bytes, "base64"), { mode: 0o600 });
  }
  await writeFile(resolve(directory, "output-schema.json"), canonicalBytes({
    type: "object",
    additionalProperties: false,
    required: ["answer", "family"],
    properties: { answer: { type: "string" }, family: { type: "string" } },
  }), { mode: 0o600 });
  await writeFile(resolve(directory, "task-prompt.txt"), [
    taskPackage.task.prompt.text,
    "",
    "Work only in the current repository. Candidate-visible sealed inputs are in candidate-task.json and assets/.",
    "Infer the starter-v1 result from those inputs. Return only the JSON object required by output-schema.json.",
    "Do not access the network or paths outside the workspace.",
  ].join("\n"), { mode: 0o600 });
}

function run(command, args, { input, timeout } = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout = [];
    const stderr = [];
    let timer;
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      const result = { code, signal, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === 0) resolveRun(result);
      else reject(Object.assign(new Error(`${command} exited with ${code ?? signal}`), result, { killed: signal !== null }));
    });
    child.stdin.end(input);
    if (timeout) timer = setTimeout(() => child.kill("SIGTERM"), timeout);
  });
}

function vm(args, options) { return run(COLIMA, ["ssh", "--profile", PROFILE, "--", ...args], options); }
function metric(metricId, value) { return { metricId, value }; }

async function retain(payload) {
  if (!EVIDENCE_ROOT) return null;
  const digest = sha256Bytes(payload);
  const directory = resolve(EVIDENCE_ROOT, "objects", "sha256");
  const path = resolve(directory, digest.slice(7));
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { await writeFile(path, payload, { flag: "wx", mode: 0o400 }); }
  catch (error) {
    if (error.code !== "EEXIST" || !Buffer.from(await readFile(path)).equals(payload)) throw error;
  }
  return { digest, byteLength: payload.byteLength };
}

async function main() {
  const runtime = required(RUNTIME, "NELOS_PILOT_VM_RUNTIME");
  required(IMAGE, "NELOS_PILOT_IMAGE");
  if (!/^[a-z0-9-]+$/u.test(PROFILE) || !/^\/[A-Za-z0-9/_.-]+$/u.test(runtime) || !/^\/[A-Za-z0-9/_.-]+$/u.test(SEED_ROOT)) throw new Error("pilot VM paths or profile are unsafe");
  const request = await readRequest();
  const { family, taskPackage } = taskPackageFor(request.declaredInputs.taskId);
  if (taskPackage.task.digest !== request.declaredInputs.taskDigest) throw new Error("task package digest does not match the sealed request");
  const staging = await mkdtemp(resolve(tmpdir(), "nelos-pilot-vm-candidate-"));
  const attemptName = `${request.trialId.slice(-12)}-${request.attempt}-${randomUUID().slice(0, 8)}`;
  const attemptRoot = `/var/lib/nelos-pilot/attempts/${attemptName}`;
  const home = `${attemptRoot}/home`;
  const workspace = `${attemptRoot}/workspace`;
  const temporary = `${attemptRoot}/tmp`;
  const started = Date.now();
  let stdout = "";
  let stderr = "";
  let exitCode = 1;
  let timedOut = false;
  try {
    await stageCandidate(staging, taskPackage);
    await vm(["sudo", "install", "-d", "-o", "nelos-experiment", "-g", "nelos-experiment", "-m", "0700", `${home}/.codex`, `${home}/.cache`, `${home}/.config`, `${home}/.local/share`, workspace, temporary]);
    await vm(["sudo", "cp", `${SEED_ROOT}/.codex/auth.json`, `${home}/.codex/auth.json`]);
    await vm(["sudo", "chown", "nelos-experiment:nelos-experiment", `${home}/.codex/auth.json`]);
    const archive = resolve(staging, "candidate.tar");
    await executeFile("tar", ["-C", staging, "--exclude", "candidate.tar", "-cf", archive, "."], { maxBuffer: MAX_BUFFER });
    await vm(["sudo", "tar", "-xf", "-", "-C", workspace], { input: await readFile(archive) });
    await vm(["sudo", "chown", "-R", "nelos-experiment:nelos-experiment", workspace]);
    const script = [
      `cd ${workspace}`,
      "git init -q",
      `/usr/bin/timeout --signal=TERM ${request.budget.wallClockSeconds}s /usr/bin/time -f '\\nNELOS_TIME user_seconds=%U system_seconds=%S max_rss_kb=%M' codex exec --json --ephemeral --ignore-user-config --ignore-rules --sandbox workspace-write --skip-git-repo-check -C ${workspace} --output-schema ${workspace}/output-schema.json -o ${workspace}/result.json - < ${workspace}/task-prompt.txt`,
    ].join("; ");
    try {
      const result = await vm([
        "sudo", "-u", "nelos-experiment", "env",
        `PATH=${runtime}/bin:/usr/bin:/bin`, `HOME=${home}`, `CODEX_HOME=${home}/.codex`,
        `XDG_CACHE_HOME=${home}/.cache`, `XDG_CONFIG_HOME=${home}/.config`, `XDG_DATA_HOME=${home}/.local/share`, `TMPDIR=${temporary}`,
        "/bin/sh", "-eu", "-c", script,
      ], { timeout: (request.budget.wallClockSeconds + 10) * 1000 });
      stdout = result.stdout;
      stderr = result.stderr;
      exitCode = 0;
    } catch (error) {
      stdout = error.stdout ?? "";
      stderr = error.stderr ?? "";
      exitCode = Number.isSafeInteger(error.code) ? error.code : 1;
      timedOut = error.killed === true || error.signal === "SIGTERM" || /exit status 124|status 124/u.test(stderr);
      if (process.env.NELOS_PILOT_DEBUG === "1") process.stderr.write(stderr.replace(/[A-Za-z0-9_-]{32,}/gu, "[redacted]").slice(-4000));
    }
    let candidateValue = {};
    try { candidateValue = JSON.parse((await vm(["sudo", "cat", `${workspace}/result.json`])).stdout); } catch {}
    const output = canonicalBytes(candidateValue);
    await retain(output);
    if (process.env.NELOS_PILOT_DEBUG === "1") process.stderr.write(`\nNELOS_OUTPUT ${output.toString("utf8")}\n`);
    const observation = { attemptId: `${request.operationId}:candidate`, contaminated: false, termination: timedOut ? "timeout" : "exited", exitCode };
    const grade = gradeTaskAttempt({
      taskPackage,
      submission: { outputs: [{ id: "result", encoding: "base64", bytes: output.toString("base64") }] },
      observation,
      attestation: { issuer: "nelos-host-runtime", candidateEnvironmentId: `colima-vm:${attemptName}`, graderEnvironmentId: `host-grader:${process.pid}` },
    });
    const events = parseCodexJsonl(stdout);
    const timing = parseProcessTime(stderr);
    const wallMs = Date.now() - started;
    let diskBytes;
    try { diskBytes = Number((await vm(["sudo", "du", "-sb", workspace])).stdout.split(/\s/u)[0]); } catch {}
    const evidencePayload = canonicalBytes({
      schemaVersion: 1, operationId: request.operationId, family: family.id, acquisitionImage: IMAGE,
      executionBackend: "colima-vm", colimaProfile: PROFILE, codexVersion: "0.146.0", exitCode, timedOut,
      outputDigest: sha256Bytes(output), gradeDigest: grade.digest, gradeOutcome: grade.outcome, eventCounts: events.eventCounts,
      routeObservation: "product-default route; concrete model revision unavailable from Codex JSONL",
    });
    const evidence = await retain(evidencePayload);
    const measurements = [
      metric("strict_pass_rate", grade.strictPass ? 1 : 0), metric("completion_without_retry", request.attempt === 1 ? 1 : 0),
      metric("candidate_failure_rate", exitCode === 0 ? 0 : 1), metric("timeout_rate", timedOut ? 1 : 0),
      metric("route_mismatch_rate", 0), metric("safety_violation_rate", 0), metric("terminal_wall_ms", wallMs),
      metric("wall_limit_ms", request.budget.wallClockSeconds * 1000), metric("input_tokens", events.inputTokens),
      metric("cached_input_tokens", events.cachedInputTokens), metric("output_tokens", events.outputTokens),
      metric("reasoning_output_tokens", events.reasoningOutputTokens), metric("tool_calls", events.toolCalls),
      metric("tool_failures", events.toolFailures), metric("concurrency_seconds", wallMs / 1000),
    ];
    if (Number.isFinite(timing.cpuMs)) measurements.push(metric("cpu_ms", timing.cpuMs));
    if (Number.isFinite(timing.peakMemoryBytes)) measurements.push(metric("peak_memory_bytes", timing.peakMemoryBytes));
    if (Number.isFinite(diskBytes)) measurements.push(metric("disk_bytes", diskBytes));
    process.stdout.write(JSON.stringify({
      outcome: exitCode === 0 ? "succeeded" : "failed", observedRoute: request.requestedRoute, operationId: request.operationId,
      outputs: [{ id: "result", digest: sha256Bytes(output), byteLength: output.byteLength }],
      artifacts: evidence ? [{ id: "evidence", ...evidence }] : [], measurements, evidenceComplete: true, retryable: false,
    }));
  } finally {
    await vm(["sudo", "rm", "-rf", attemptRoot]).catch(() => null);
    await rm(staging, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${JSON.stringify({ error: "SIGNED_IN_PILOT_VM_ADAPTER_FAILED", message: error.message })}\n`);
  process.exitCode = 1;
});
