#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  COMPATIBILITY_CONTRACT_REGISTRY_V1,
} from "../src/compatibility-contract-registry.mjs";
import {
  collectRuntimeTransportEvidenceV1,
  validateWireCompatibilityEvidenceV1,
} from "../src/wire-compatibility-collector.mjs";

function takeValue(argv, index, option) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseRuntimeTransportArgs(argv) {
  const options = {
    codexCommand: "codex",
    expectedVersion: null,
    help: false,
    timeoutMs: 10_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--codex") {
      options.codexCommand = takeValue(argv, index, argument);
      index += 1;
    } else if (argument === "--expected-version") {
      const value = takeValue(argv, index, argument);
      if (!/^\d+\.\d+\.\d+$/u.test(value)) {
        throw new Error("--expected-version must be an exact stable version");
      }
      options.expectedVersion = value;
      index += 1;
    } else if (argument === "--timeout-ms") {
      const value = Number(takeValue(argv, index, argument));
      if (!Number.isSafeInteger(value) || value <= 0 || value > 60_000) {
        throw new Error("--timeout-ms must be an integer from 1 to 60000");
      }
      options.timeoutMs = value;
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option: ${argument}`);
    }
  }
  return options;
}

function usage() {
  return `Usage: node scripts/collect-runtime-transport.mjs [options]

Collect normalized compatibility evidence from an exact Codex stdio runtime.
Only initialize and one bounded read-only thread/list request are performed.

Options:
  --codex PATH       Exact Codex executable (default: codex)
  --expected-version Exact required Codex version (default: registry versions)
  --timeout-ms N     Per-operation timeout, at most 60000 (default: 10000)
  -h, --help         Show this help
`;
}

export async function runRuntimeTransportCollector(argv = process.argv.slice(2)) {
  const options = parseRuntimeTransportArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return 0;
  }
  const report = await collectRuntimeTransportEvidenceV1({
    timeoutMs: options.timeoutMs,
    declaration: {
      checkId: "runtime.stdio-transport",
      executable: options.codexCommand,
      transport: "stdio-jsonl",
      expectedCodexIdentities: options.expectedVersion
        ? [{ version: options.expectedVersion, commitSha: null }]
        : COMPATIBILITY_CONTRACT_REGISTRY_V1.supportedCodexReleases
          .map(({ version }) => ({ version, commitSha: null })),
      operations: [{
        method: "thread/list",
        params: {
          archived: false,
          limit: 1,
          sortDirection: "desc",
          sortKey: "updated_at",
        },
        readOnly: true,
        validate(result) {
          if (!result || !Array.isArray(result.data)) {
            throw new Error("thread/list returned malformed generated output");
          }
        },
      }],
    },
  });
  validateWireCompatibilityEvidenceV1(report);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.outcome === "passed" ? 0 : report.outcome === "failed" ? 1 : 2;
}

const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  runRuntimeTransportCollector()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`collect-runtime-transport: ${error.message}\n`);
      process.exitCode = 2;
    });
}
