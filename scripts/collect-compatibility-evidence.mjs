#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  COMPATIBILITY_CONTRACT_REGISTRY_V1,
} from "../src/compatibility-contract-registry.mjs";
import {
  collectUpstreamDocumentationEvidenceV1,
  createUpstreamDocumentationReportV1,
} from "../src/upstream-documentation-evidence.mjs";
import {
  collectUpstreamSourceEvidenceV1,
} from "../src/upstream-source-collector.mjs";
import {
  APP_SERVER_DOCUMENTATION_CONTRACT_V1,
} from "../src/upstream-documentation-contracts.mjs";

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const repositoryUrl = "https://github.com/openai/codex";
const legacyV2SourcePath =
  "codex-rs/app-server-protocol/src/protocol/v2.rs";
const releaseV2SourcePath =
  "codex-rs/app-server-protocol/src/protocol/v2/mod.rs";
const requiredMethods = [
  "thread/read",
  "thread/name/set",
  "thread/resume",
  "thread/turns/list",
  "turn/start",
  "turn/steer",
  "thread/archive",
];

function parseArgs(argv) {
  const options = {
    codex: null,
    lane: null,
    out: null,
    releaseId: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!["--codex", "--lane", "--out", "--release-id"].includes(key)) {
      throw new Error(`unknown option ${key}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    options[key.slice(2).replace("-id", "Id")] = value;
    index += 1;
  }
  if (!options.lane || !options.out) {
    throw new Error("--lane and --out are required");
  }
  if (
    ["schema", "source-release"].includes(options.lane) &&
    !options.releaseId
  ) {
    throw new Error(`--release-id is required for the ${options.lane} lane`);
  }
  return options;
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

async function walkJson(directory, prefix = "") {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walkJson(absolute, relative));
    else if (entry.isFile() && entry.name.endsWith(".json")) {
      const bytes = await readFile(absolute);
      JSON.parse(bytes.toString("utf8"));
      files.push({ path: relative, bytes });
    }
  }
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function exactRelease(releaseId) {
  const release = COMPATIBILITY_CONTRACT_REGISTRY_V1.supportedCodexReleases
    .find(({ id }) => id === releaseId);
  if (!release) throw new Error(`unsupported exact release ${releaseId}`);
  return release;
}

async function collectDocumentation() {
  const observation = await collectUpstreamDocumentationEvidenceV1(
    APP_SERVER_DOCUMENTATION_CONTRACT_V1,
  );
  return createUpstreamDocumentationReportV1([observation]);
}

export function sourceEvidenceRegistry() {
  const registry = structuredClone(COMPATIBILITY_CONTRACT_REGISTRY_V1);
  for (const capability of registry.capabilities) {
    for (const mapping of capability.mappings.upstreamSource) {
      mapping.paths = mapping.paths.map((path) =>
        path === legacyV2SourcePath ? releaseV2SourcePath : path);
    }
  }
  return registry;
}

async function collectSource(kind, releaseId) {
  const registry = sourceEvidenceRegistry();
  const reports = [];
  for (const capability of registry.capabilities) {
    const mapping = capability.mappings.upstreamSource.find(
      ({ repository }) => repository === repositoryUrl,
    );
    if (!mapping) continue;
    reports.push(await collectUpstreamSourceEvidenceV1(
      registry,
      {
        capabilityId: capability.id,
        repositoryUrl,
        evidenceRef: kind === "floating-main"
          ? { kind }
          : { kind, releaseId },
        selectedPaths: [...mapping.paths],
        selectedArtifacts: [...mapping.artifacts],
      },
    ));
  }
  return {
    schemaVersion: 1,
    lane: kind === "floating-main"
      ? "floating-main-early-warning"
      : "exact-release-open-source",
    releaseId: releaseId ?? null,
    countsForCompatibility: kind === "supported-release" &&
      reports.length > 0 &&
      reports.every(({ outcome }) => outcome === "evidence"),
    reports,
  };
}

async function resolveExecutable(command) {
  if (isAbsolute(command)) return command;
  if (/[\\/]/u.test(command)) return resolve(command);
  const resolver = process.platform === "win32" ? "where.exe" : "which";
  const { stdout } = await execFileAsync(resolver, [command], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
  const executable = stdout.split(/\r?\n/u).find(Boolean);
  if (!executable) throw new Error(`could not resolve executable ${command}`);
  return executable;
}

async function collectSchema(codex, releaseId) {
  const release = exactRelease(releaseId);
  if (!codex) throw new Error("--codex is required for the schema lane");
  const executable = await resolveExecutable(codex);
  const { stdout: versionOutput } = await execFileAsync(executable, ["--version"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
  const observedVersion = versionOutput.match(
    /(?:^|\s)(\d+\.\d+\.\d+)(?![\w.+-])/u,
  )?.[1];
  if (observedVersion !== release.version) {
    throw new Error(
      `schema executable identity ${observedVersion ?? "<unresolved>"} does not match ${release.version}`,
    );
  }
  const outputDirectory = await mkdtemp(join(tmpdir(), "nelos-schema-ci-"));
  try {
    await execFileAsync(
      executable,
      [
        "app-server",
        "generate-json-schema",
        "--experimental",
        "--out",
        outputDirectory,
      ],
      { cwd: root, encoding: "utf8", timeout: 30_000 },
    );
    const files = await walkJson(outputDirectory);
    if (files.length === 0) throw new Error("schema generator produced no JSON");
    const corpus = files.map(({ bytes }) => bytes.toString("utf8")).join("\n");
    const missingMethods = requiredMethods.filter(
      (method) => !corpus.includes(method),
    );
    if (missingMethods.length > 0) {
      throw new Error(`generated schema is missing: ${missingMethods.join(", ")}`);
    }
    return {
      schemaVersion: 1,
      evidenceKind: "generated-schema",
      outcome: "passed",
      countsForCompatibility: true,
      authority: "decisive-wire-evidence",
      releaseId,
      expectedCodexIdentity: { version: release.version, commitSha: null },
      observedCodexIdentity: { version: observedVersion, commitSha: null },
      observedAt: new Date().toISOString(),
      provenance: {
        executable,
        args: [
          "app-server",
          "generate-json-schema",
          "--experimental",
          "--out",
          "<temporary-directory>",
        ],
        files: files.map(({ path, bytes }) => ({
          path,
          digest: digest(bytes),
          size: bytes.length,
        })),
      },
      digest: digest(Buffer.concat(
        files.flatMap(({ path, bytes }) => [Buffer.from(path), bytes]),
      )),
      failure: null,
    };
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

function infrastructureReport(options, error) {
  return {
    schemaVersion: 1,
    lane: options.lane,
    releaseId: options.releaseId,
    outcome: "infrastructure-failure",
    countsForCompatibility: false,
    observedAt: new Date().toISOString(),
    failure: { kind: "infrastructure", message: error.message },
  };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  let report;
  let exitCode = 0;
  try {
    if (options.lane === "docs") report = await collectDocumentation();
    else if (options.lane === "source-floating") {
      report = await collectSource("floating-main");
    } else if (options.lane === "source-release") {
      report = await collectSource("supported-release", options.releaseId);
    } else if (options.lane === "schema") {
      report = await collectSchema(options.codex, options.releaseId);
    } else {
      throw new Error(`unknown lane ${options.lane}`);
    }
    if (
      options.lane === "docs" && report.status !== "available" ||
      options.lane === "source-release" && !report.countsForCompatibility
    ) {
      exitCode = 2;
    }
  } catch (error) {
    report = infrastructureReport(options, error);
    exitCode = 2;
  }
  const outputPath = resolve(options.out);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return exitCode;
}

const isMain = process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      process.stderr.write(`collect-compatibility-evidence: ${error.message}\n`);
      process.exitCode = 2;
    });
}
