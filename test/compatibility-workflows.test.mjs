import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  resolveRequiredCompatibilityRange,
} from "../scripts/run-required-compatibility.mjs";
import {
  parseRuntimeTransportArgs,
} from "../scripts/collect-runtime-transport.mjs";
import {
  main as verifyReleaseEvidence,
} from "../scripts/verify-release-compatibility-evidence.mjs";
import {
  main as collectCompatibilityEvidence,
} from "../scripts/collect-compatibility-evidence.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const execFileAsync = promisify(execFile);

async function text(path) {
  return readFile(new URL(path, import.meta.url), "utf8");
}

test("required compatibility script resolves the real merge base", async () => {
  const calls = [];
  const range = await resolveRequiredCompatibilityRange({
    baseRef: "origin/review-base",
    head: "review-head",
    cwd: root,
    runGit: async (command, args, options) => {
      calls.push({ command, args, options });
      return { stdout: `${"a".repeat(40)}\n` };
    },
  });
  assert.deepEqual(range, {
    base: "a".repeat(40),
    baseRef: "origin/review-base",
    head: "review-head",
  });
  assert.deepEqual(calls[0].args, [
    "merge-base",
    "--",
    "origin/review-base",
    "review-head",
  ]);
});

test("required PR job is token-free, offline, and isolated from advisory lanes", async () => {
  const workflow = await text("../.github/workflows/verify.yml");
  const packageJson = JSON.parse(await text("../package.json"));
  assert.match(workflow, /pull_request:/u);
  assert.match(
    workflow,
    /name: Compatibility \/ required offline deterministic/u,
  );
  assert.match(workflow, /fetch-depth: 0/u);
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(
    workflow,
    /env -u OPENAI_API_KEY npm run compatibility:required/u,
  );
  assert.equal(
    packageJson.scripts["compatibility:required"],
    "NODE_OPTIONS=--require=./scripts/offline-network-blocker.cjs node scripts/run-required-compatibility.mjs",
  );
  assert.equal(packageJson.scripts.compatibility, "npm run compatibility:required");
  const requiredJobStart = workflow.indexOf("  compatibility-required:");
  const nodeJobStart = workflow.indexOf("\n  node:");
  assert.ok(requiredJobStart >= 0, "compatibility-required job is missing");
  assert.ok(nodeJobStart >= 0, "node job is missing");
  assert.ok(
    requiredJobStart < nodeJobStart,
    "compatibility-required must precede the node job",
  );
  const requiredJob = workflow.slice(requiredJobStart, nodeJobStart);
  for (const forbidden of [
    "OPENAI_API_KEY:",
    "semantic",
    "verify:app-server:live",
    "collect-runtime-transport",
    "collect-compatibility-evidence",
    "curl ",
    "npx ",
  ]) {
    assert.equal(requiredJob.includes(forbidden), false, forbidden);
  }
});

test("node verification requires the immutable starter corpus lock", async () => {
  const workflow = await text("../.github/workflows/verify.yml");
  assert.match(
    workflow,
    /- run: npm run check\s+- run: npm run corpus:validate\s+- run: npm test/u,
  );
});

test("Proxmox workflow validates the pinned Desktop production source lane", async () => {
  const workflow = await text("../.github/workflows/proxmox-template.yml");
  assert.equal(
    (workflow.match(/- "validation\/proxmox-desktop\/\*\*"/gu) ?? []).length,
    2,
  );
  assert.match(workflow, /DESKTOP_PACKER_DIR: validation\/proxmox-desktop\/v1/u);
  assert.match(workflow, /npm run check:desktop-runner/u);
  assert.match(workflow, /python3 - <<'PY'[\s\S]*ast\.parse/u);
  assert.match(workflow, /packer" init "\$DESKTOP_PACKER_DIR"/u);
  assert.match(
    workflow,
    /packer fmt -check -diff "\$DESKTOP_PACKER_DIR\/golden-image\.pkr\.hcl"/u,
  );
  assert.match(
    workflow,
    /packer validate -syntax-only "\$DESKTOP_PACKER_DIR\/golden-image\.pkr\.hcl"/u,
  );
  assert.match(workflow, /packer validate -var-file="\$desktop_synthetic_vars" "\$DESKTOP_PACKER_DIR"/u);
  assert.match(workflow, /output_template_mac: "02:4E:45:4C:90:27"/u);
  assert.match(workflow, /build_nonce: "0{32}"/u);
  assert.match(workflow, /\.artifacts\.packer\.sha256/u);
  assert.match(workflow, /\.artifacts\.packerProxmoxPlugin\.sha256/u);
  assert.doesNotMatch(workflow, /hashicorp\/setup-packer|packer@latest/u);
});

test("drift lanes are scheduled/manual, bounded, and preserve unavailable reports", async () => {
  const workflow = await text("../.github/workflows/compatibility-drift.yml");
  assert.match(workflow, /schedule:/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.doesNotMatch(workflow, /pull_request:/u);
  assert.doesNotMatch(workflow, /\n  push:/u);
  assert.match(workflow, /permissions:\n  contents: read/u);
  assert.match(workflow, /compatibility:drift:docs/u);
  assert.match(workflow, /compatibility:drift:source/u);
  assert.match(workflow, /--lane source-release/u);
  assert.match(workflow, /--lane schema/u);
  assert.match(workflow, /collect-runtime-transport\.mjs/u);
  assert.match(workflow, /--expected-version/u);
  assert.ok((workflow.match(/continue-on-error: true/gu) ?? []).length >= 5);
  assert.ok((workflow.match(/if: always\(\)/gu) ?? []).length >= 2);
  assert.doesNotMatch(workflow, /OPENAI_API_KEY/u);
  assert.equal((workflow.match(/timeout-minutes: 15/gu) ?? []).length, 2);
  assert.match(workflow, /npm install[\s\S]*--ignore-scripts[\s\S]*@openai\/codex/u);
});

test("release evidence binds exact source, schema, and runtime identities", async () => {
  const workflow = await text("../.github/workflows/release.yml");
  assert.match(workflow, /compatibility-exact:/u);
  assert.match(workflow, /codex: \["0\.144\.5", "0\.144\.6"\]/u);
  assert.match(workflow, /--lane source-release/u);
  assert.match(workflow, /--lane schema/u);
  assert.match(workflow, /--expected-version/u);
  assert.match(workflow, /verify-release-compatibility-evidence\.mjs/u);
  assert.match(workflow, /needs: \[verify, compatibility-exact\]/u);
  assert.match(workflow, /Upload exact release evidence[\s\S]*if: always\(\)/u);
  assert.match(workflow, /npm install[\s\S]*--ignore-scripts[\s\S]*@openai\/codex/u);
});

test("live and semantic work is manual, optional, trusted, and advisory-only", async () => {
  const advisory = await text(
    "../.github/workflows/compatibility-advisory.yml",
  );
  assert.match(advisory, /workflow_dispatch:/u);
  assert.doesNotMatch(advisory, /pull_request:|schedule:|\n  push:/u);
  assert.match(advisory, /if: inputs\.run_live/u);
  assert.match(advisory, /if: inputs\.run_semantic/u);
  assert.equal(
    (advisory.match(/environment: compatibility-advisory/gu) ?? []).length,
    2,
  );
  assert.equal(
    (advisory.match(/continue-on-error: true/gu) ?? []).length,
    2,
  );
  assert.match(advisory, /npm run verify:app-server:live/u);
  assert.match(advisory, /compatibility:semantic-advisory/u);
  assert.match(advisory, /\[\[ -n "\$SEMANTIC_INPUT" \]\]/u);
  assert.match(advisory, /\[\[ -n "\$SEMANTIC_PROVIDER" \]\]/u);
  assert.match(advisory, /\[\[ -n "\$SEMANTIC_PROVIDER_CONFIG" \]\]/u);
  assert.doesNotMatch(advisory, /compatibility:required/u);
});

test("offline blocker closes direct socket, DNS promise, HTTP/2, and datagram paths", async () => {
  const blocker = fileURLToPath(
    new URL("../scripts/offline-network-blocker.cjs", import.meta.url),
  );
  for (const expression of [
    "new (require('node:net').Socket)().connect(443, 'example.test')",
    "require('node:dns').promises.lookup('example.test')",
    "require('node:http2').connect('https://example.test')",
    "require('node:dgram').createSocket('udp4')",
  ]) {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        ["--require", blocker, "--eval", expression],
        { encoding: "utf8" },
      ),
      (error) => {
        assert.match(error.stderr, /blocked a network operation/u);
        return true;
      },
    );
  }
});

test("compatibility workflows never edit checked-in claims or source", async () => {
  const workflows = await Promise.all([
    text("../.github/workflows/verify.yml"),
    text("../.github/workflows/compatibility-drift.yml"),
    text("../.github/workflows/compatibility-advisory.yml"),
    text("../.github/workflows/release.yml"),
  ]);
  const compatibilityCommands = workflows.join("\n");
  for (const forbidden of [
    "git commit",
    "git push",
    "git add",
    "sed -i",
    "supportedCodexReleases.push",
    "test/fixtures/mcp-app-server-protocol-v0.144.x.json >",
  ]) {
    assert.equal(compatibilityCommands.includes(forbidden), false, forbidden);
  }
});

test("runtime collector accepts one exact expected version", () => {
  const options = parseRuntimeTransportArgs([
    "--codex",
    "/tmp/codex",
    "--expected-version",
    "0.144.6",
  ]);
  assert.equal(options.expectedVersion, "0.144.6");
  assert.throws(
    () => parseRuntimeTransportArgs(["--expected-version", "main"]),
    /exact stable version/u,
  );
});

test("release-bound evidence lanes require an explicit release id", async () => {
  for (const lane of ["schema", "source-release"]) {
    await assert.rejects(
      collectCompatibilityEvidence([
        "--lane",
        lane,
        "--out",
        "/tmp/unused-compatibility-evidence.json",
      ]),
      new RegExp(`--release-id is required for the ${lane} lane`, "u"),
    );
  }
});

test("schema evidence invokes and records the same PATH-resolved executable", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nelos-schema-path-"));
  const executable = join(directory, "fixture-codex");
  const reportPath = join(directory, "schema.json");
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(executable, `#!/usr/bin/env node
const { mkdirSync, writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--version") {
  process.stdout.write("codex-cli 0.144.5\\n");
  process.exit(0);
}
const output = args[args.indexOf("--out") + 1];
mkdirSync(output, { recursive: true });
writeFileSync(
  require("node:path").join(output, "schema.json"),
  JSON.stringify({ methods: ${JSON.stringify([
    "thread/read",
    "thread/name/set",
    "thread/resume",
    "thread/turns/list",
    "turn/start",
    "turn/steer",
    "thread/archive",
  ])} }),
);
`);
  await chmod(executable, 0o755);

  const collector = fileURLToPath(
    new URL("../scripts/collect-compatibility-evidence.mjs", import.meta.url),
  );
  await execFileAsync(
    process.execPath,
    [
      collector,
      "--lane",
      "schema",
      "--release-id",
      "codex@0.144.5",
      "--codex",
      "fixture-codex",
      "--out",
      reportPath,
    ],
    {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
      },
    },
  );
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  assert.equal(report.provenance.executable, executable);
});

test("release verifier accepts exact refs and rejects a mismatched commit", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "nelos-release-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourcePath = join(directory, "source.json");
  const schemaPath = join(directory, "schema.json");
  const runtimePath = join(directory, "runtime.json");
  const outputPath = join(directory, "bundle.json");
  const source = {
    releaseId: "codex@0.144.5",
    countsForCompatibility: true,
    reports: [{
      outcome: "evidence",
      requestedRef: "refs/tags/rust-v0.144.5",
      commitSha: "87db9bc18ba5bc82c1cb4e4381b44f693ee35623",
    }],
  };
  const schema = {
    evidenceKind: "generated-schema",
    releaseId: "codex@0.144.5",
    outcome: "passed",
    observedCodexIdentity: { version: "0.144.5" },
  };
  const runtime = {
    evidenceKind: "runtime-transport",
    outcome: "passed",
    expectedCodexIdentities: [{ version: "0.144.5" }],
    observedCodexIdentity: { version: "0.144.5" },
  };
  await Promise.all([
    writeFile(sourcePath, JSON.stringify(source)),
    writeFile(schemaPath, JSON.stringify(schema)),
    writeFile(runtimePath, JSON.stringify(runtime)),
  ]);
  await verifyReleaseEvidence([
    "--release-id",
    "codex@0.144.5",
    "--source",
    sourcePath,
    "--schema",
    schemaPath,
    "--runtime",
    runtimePath,
    "--out",
    outputPath,
  ]);
  const bundle = JSON.parse(await readFile(outputPath, "utf8"));
  assert.equal(bundle.countsForCompatibility, true);
  source.reports[0].commitSha = "1".repeat(40);
  await writeFile(sourcePath, JSON.stringify(source));
  await assert.rejects(
    verifyReleaseEvidence([
      "--release-id",
      "codex@0.144.5",
      "--source",
      sourcePath,
      "--schema",
      schemaPath,
      "--runtime",
      runtimePath,
      "--out",
      outputPath,
    ]),
    /unresolved, mismatched, or unavailable/u,
  );
});
