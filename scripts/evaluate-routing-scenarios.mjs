#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { randomBytes } from "node:crypto";

import {
  createRoutingLivePromptV1,
  createRoutingObservationTemplateV1,
  gradeRoutingEvalSuiteV1,
  routingEvalCoverageV1,
  validateRoutingEvalSuiteV1,
} from "../src/routing-evaluation.mjs";

const DEFAULT_SUITE = new URL(
  "../evals/routing/isolated-queen-scenarios.v1.json",
  import.meta.url,
);

async function readJson(pathOrUrl, label) {
  let bytes;
  try {
    bytes = await readFile(pathOrUrl, "utf8");
  } catch (error) {
    throw new Error(`${label} could not be read: ${error.message}`);
  }
  try {
    return JSON.parse(bytes);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function usage() {
  return [
    "Usage:",
    "  npm run eval:routing -- validate",
    "  npm run eval:routing -- list [--all]",
    "  npm run eval:routing -- prompt SCENARIO_ID [--run-id RUN_ID]",
    "  npm run eval:routing -- template [SCENARIO_ID ...]",
    "  npm run eval:routing -- grade OBSERVATION.json [--partial]",
    "",
    "Each live scenario must run in a fresh queen and a distinct isolated workspace.",
    "Populate observations only from Nelos runtime-intelligence verification evidence.",
  ].join("\n");
}

function scenarioSummary(scenario) {
  const routes = scenario.expectation.requiredRoutes
    .map(({
      lifecycle,
      model,
      effort,
      taskShape,
      modelSelection,
      effortSelection,
      minimumCount,
    }) => (
      `${lifecycle}:${model}/${effort} [${taskShape}; ${modelSelection}/${effortSelection}] x${minimumCount}`
    ))
    .join(", ");
  return `${scenario.id}\t${scenario.lane}\t${scenario.expectation.baseline}\t${routes}`;
}

async function main(argv) {
  const suite = validateRoutingEvalSuiteV1(await readJson(DEFAULT_SUITE, "routing suite"));
  const [command = "validate", ...args] = argv;
  if (command === "validate") {
    if (args.length !== 0) throw new Error("validate takes no arguments");
    process.stdout.write(`${JSON.stringify({
      suiteId: suite.suiteId,
      valid: true,
      coverage: routingEvalCoverageV1(suite),
    }, null, 2)}\n`);
    return;
  }
  if (command === "list") {
    const includeOptIn = args.length === 1 && args[0] === "--all";
    if (args.length > 1 || (args.length === 1 && !includeOptIn)) {
      throw new Error("list accepts only --all");
    }
    const scenarios = includeOptIn
      ? suite.scenarios
      : suite.scenarios.filter(({ enabledByDefault }) => enabledByDefault);
    process.stdout.write(`${scenarios.map(scenarioSummary).join("\n")}\n`);
    return;
  }
  if (command === "prompt") {
    const runIdIndex = args.indexOf("--run-id");
    if (
      (runIdIndex === -1 && args.length !== 1) ||
      (runIdIndex !== -1 && (args.length !== 3 || runIdIndex !== 1))
    ) {
      throw new Error("prompt requires one scenario ID and optional --run-id RUN_ID");
    }
    const scenarioId = args[0];
    const scenario = suite.scenarios.find(({ id }) => id === scenarioId);
    if (!scenario) throw new Error(`unknown routing scenario: ${args[0]}`);
    const runId = runIdIndex === -1
      ? `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`
      : args[2];
    process.stdout.write(`${createRoutingLivePromptV1(suite, scenario.id, { runId })}\n`);
    return;
  }
  if (command === "template") {
    const template = createRoutingObservationTemplateV1(
      suite,
      args.length === 0 ? null : args,
    );
    process.stdout.write(`${JSON.stringify(template, null, 2)}\n`);
    return;
  }
  if (command === "grade") {
    const partialIndex = args.indexOf("--partial");
    const partial = partialIndex !== -1;
    const positional = args.filter((argument) => argument !== "--partial");
    if (positional.length !== 1 || args.filter((argument) => argument === "--partial").length > 1) {
      throw new Error("grade requires one observation path and optional --partial");
    }
    const observationPath = resolve(process.cwd(), positional[0]);
    const observation = await readJson(observationPath, "routing observation");
    const report = gradeRoutingEvalSuiteV1(suite, observation, {
      requireComplete: !partial,
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.passed) process.exitCode = 1;
    return;
  }
  if (["help", "--help", "-h"].includes(command)) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  throw new Error(`unknown command: ${command}\n\n${usage()}`);
}

main(process.argv.slice(2)).catch((error) => {
  process.stderr.write(`routing evaluation error: ${error.message}\n`);
  process.exitCode = 1;
});
