#!/usr/bin/env node

import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { canonicalBytes, canonicalDigest } from "../src/experimentation-contract/index.mjs";
import { expandExperimentPlan } from "../src/experiment-runner.mjs";

const manifestPath = process.argv[2];
if (!manifestPath) {
  process.stderr.write("usage: run-signed-in-pilot-canary <manifest.json>\n");
  process.exitCode = 2;
} else {
  const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
  const trial = expandExperimentPlan(manifest).trials[0];
  const operationId = `op:canary-${trial.trialId.slice(-16)}`;
  const request = {
    schemaVersion: 1,
    runId: "run:signed-in-pilot-canary",
    runGeneration: 1,
    trialId: trial.trialId,
    attempt: 1,
    operationId,
    lease: {
      leaseId: `lease:${operationId}`,
      owner: "controller:canary",
      fencingToken: canonicalDigest({ operationId, trialId: trial.trialId }),
      acquiredAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 240000).toISOString(),
    },
    seed: trial.seed,
    componentSeeds: trial.componentSeeds,
    declaredInputs: trial.declaredInputs,
    declaredInputsDigest: trial.declaredInputsDigest,
    budget: trial.budget,
    requestedRoute: {
      candidateId: trial.candidateId,
      adapter: trial.adapter,
      modelId: trial.candidateProvenance.model.id,
      modelRevision: trial.candidateProvenance.model.revision,
      reasoningEffort: trial.candidateProvenance.model.reasoningEffort,
      pluginDigest: canonicalDigest(trial.candidateProvenance.plugins),
    },
  };
  const declaration = manifest.adapters["direct-codex"];
  const child = spawn(declaration.command[0], declaration.command.slice(1), {
    env: { ...process.env, ...declaration.environment },
    stdio: ["pipe", "pipe", "inherit"],
  });
  child.stdin.end(canonicalBytes(request));
  for await (const chunk of child.stdout) process.stdout.write(chunk);
  const code = await new Promise((resolveExit) => child.once("exit", resolveExit));
  if (code !== 0) process.exitCode = code;
}
