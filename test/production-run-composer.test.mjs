import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  chown,
  lstat,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { sha256 } from "nelos/proxmox-desktop-runtime";
import {
  canonicalProductionRunBytesV1,
  prepareProductionDesktopRunV1,
} from "../validation/proxmox-desktop/v1/prepare-production-run.mjs";
import {
  composerCliArguments,
  createProductionRunComposerFixture,
  stageComposerCandidateFixture,
} from "./fixtures/production-run-composer-v1.mjs";

const exec = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const composerCli = join(repositoryRoot, "bin", "nelos-prepare-production-run");
const errorCode = (code) => (error) => error?.code === code;
let suiteRoot;
let candidate;

async function invokeComposer(paths, { requireSealedValues = false } = {}) {
  return exec(process.execPath, [composerCli, ...composerCliArguments(paths), ...(requireSealedValues ? ["--require-sealed-values"] : [])], {
    encoding: "utf8",
    env: { HOME: "/var/empty", LANG: "C", LC_ALL: "C", PATH: "/usr/bin:/bin" },
    maxBuffer: 4 * 1024 * 1024,
    timeout: 180_000,
  });
}

async function replaceSealed(path, value) {
  await chmod(path, 0o600);
  await writeFile(path, canonicalProductionRunBytesV1(value));
  await chmod(path, 0o400);
}

test.before(async () => {
  suiteRoot = await realpath(await mkdtemp(join(tmpdir(), "nelos-production-run-composer-")));
  await chmod(suiteRoot, 0o700);
  candidate = await stageComposerCandidateFixture({ repositoryRoot, suiteRoot });
});

test.after(async () => {
  await rm(suiteRoot, { recursive: true, force: true });
});

test("real stage CLI output composes exact launch files, cross-preflights candidate runner and binder, and adopts deterministically", async () => {
  assert.deepEqual(candidate.manifestBytes, canonicalProductionRunBytesV1(candidate.manifest));
  assert.equal(candidate.manifest.schemaVersion, 1);
  assert.equal(candidate.manifest.packageRoot, candidate.candidateRoot);

  const fixture = await createProductionRunComposerFixture({ suiteRoot, candidate, name: "000001" });
  const first = await invokeComposer(fixture.paths);
  assert.equal(first.stderr, "");
  const summary = JSON.parse(first.stdout);
  assert.deepEqual(Buffer.from(first.stdout), canonicalProductionRunBytesV1(summary));
  assert.equal(summary.kind, "nelos-production-desktop-run-composition");
  assert.equal(summary.outputRoot, fixture.outputRoot);
  assert.match(summary.preflight.binderPlanDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.match(summary.preflight.runnerPreflightDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.equal(summary.preflight.packetDigest, summary.runPacket.digest);
  assert.match(summary.preflight.candidateVerificationReceiptDigest, /^sha256:[0-9a-f]{64}$/u);
  assert.deepEqual(summary.sealedValues, {
    includedInComposition: false,
    root: join(fixture.outputRoot, "staging", "sealed-values", fixture.runId),
    values: [{
      gid: process.getgid(),
      maximumBytes: 1_048_576,
      minimumBytes: 1,
      mode: "0400",
      path: join(fixture.outputRoot, "staging", "sealed-values", fixture.runId, "benchmark-000001.sealed"),
      uid: process.getuid(),
      valueRef: "benchmark-000001",
    }],
  });

  const configBytes = await readFile(summary.runConfig.path);
  const config = JSON.parse(configBytes);
  assert.deepEqual(configBytes, canonicalProductionRunBytesV1(config));
  assert.equal(Object.hasOwn(config, "now"), false);
  assert.deepEqual(config.run.candidate, { digest: candidate.manifest.candidateDigest, immutable: true });
  assert.deepEqual(config.run.desktopBundle, {
    bundleId: "chatgpt",
    digest: "sha256:4778b26a7abd08647214d5b05c17bd3ebe2d9688d146dabf017c1a2faf93ac7d",
    version: "26.814.41957",
  });
  assert.deepEqual(Object.keys(config.runPacket.packet.roots).sort(), ["evidence", "packet", "recovery", "staging"]);
  const expectedRootPaths = {
    evidence: join(fixture.outputRoot, "evidence"),
    packet: join(fixture.outputRoot, "packet"),
    recovery: join(fixture.outputRoot, "recovery"),
    staging: join(fixture.outputRoot, "staging"),
  };
  for (const [name, root] of Object.entries(config.runPacket.packet.roots)) {
    assert.deepEqual(root, {
      gid: process.getgid(),
      mode: "0700",
      path: expectedRootPaths[name],
      sealed: true,
      uid: process.getuid(),
    });
    assert.equal((await lstat(root.path)).mode & 0o777, 0o700);
  }
  assert.equal(config.homelab.sealedValueRoot, join(fixture.outputRoot, "staging", "sealed-values", fixture.runId));
  assert.equal(config.homelab.observationRoot, join(fixture.outputRoot, "staging", "observations"));
  assert.equal(config.journalDirectory, join(fixture.outputRoot, "journal"));
  assert.equal(config.runPacket.digest, sha256(config.runPacket.packet));
  assert.equal(summary.runConfig.digest, sha256(config));

  const packetEnvelope = JSON.parse(await readFile(summary.runPacket.path, "utf8"));
  assert.deepEqual(packetEnvelope, config.runPacket);
  assert.equal(summary.runPacket.path, join(fixture.outputRoot, "packet", `run-packet-${config.runPacket.digest.slice(7)}.json`));
  const hostBytes = await readFile(summary.hostBinding.path);
  const hostBinding = JSON.parse(hostBytes);
  assert.deepEqual(hostBytes, canonicalProductionRunBytesV1(hostBinding));
  assert.equal(summary.hostBinding.digest, sha256(hostBytes));
  assert.deepEqual(hostBinding.provider, {
    gatewayId: "9023", hostId: "prox2", networkId: "nelosbld", networkPolicyDigest: fixture.provider.provider.networkPolicyDigest,
    networkPolicyObserverDigest: sha256(await readFile(join(candidate.manifest.packageRoot, "validation/proxmox/desktop/helpers/nelos-network-policy-observer.py"))),
    providerId: "proxmox-lab", sourceTemplateVmId: "9025",
  });
  assert.equal(hostBinding.runBinding.vmId, "9028");
  assert.equal(hostBinding.runBinding.macAddress, "02:4E:45:4C:90:28");
  assert.equal(hostBinding.runBinding.runId, fixture.runId);
  assert.deepEqual(config.plan.automation.credentialRefs, []);
  assert.doesNotMatch(JSON.stringify({ config, hostBinding }), /-----BEGIN [A-Z ]*PRIVATE KEY-----|PVEAPIToken\s*=|\bBearer\s+/iu);

  assert.deepEqual((await readdir(fixture.outputRoot)).sort(), ["composition.json", "evidence", "operator", "packet", "recovery", "staging"]);
  assert.deepEqual(await readdir(expectedRootPaths.evidence), []);
  assert.deepEqual(await readdir(expectedRootPaths.recovery), []);
  for (const path of [summary.runConfig.path, summary.runPacket.path, summary.hostBinding.path, summary.goldenReceipt.path, summary.taskIntent.path, join(fixture.outputRoot, "composition.json")]) {
    assert.equal((await lstat(path)).mode & 0o777, 0o400, path);
  }

  const second = await invokeComposer(fixture.paths);
  assert.equal(second.stderr, "");
  assert.equal(second.stdout, first.stdout);
  assert.deepEqual(await readFile(join(fixture.outputRoot, "composition.json")), Buffer.from(first.stdout));

  await assert.rejects(
    prepareProductionDesktopRunV1({ ...fixture.paths, now: fixture.now, requireSealedValues: true }),
    errorCode("SEALED_VALUES_NOT_READY"),
  );
  const sealedValuePath = summary.sealedValues.values[0].path;
  const secretBytes = Buffer.from("opaque benchmark fixture");
  await writeFile(sealedValuePath, secretBytes, { flag: "wx", mode: 0o400 });
  await chown(sealedValuePath, process.getuid(), process.getgid());
  await chmod(sealedValuePath, 0o400);
  const staged = await invokeComposer(fixture.paths, { requireSealedValues: true });
  assert.equal(staged.stderr, "");
  assert.equal(staged.stdout, first.stdout);
  assert.deepEqual(await readFile(sealedValuePath), secretBytes);
  await chmod(sealedValuePath, 0o600);
  await assert.rejects(
    prepareProductionDesktopRunV1({ ...fixture.paths, now: fixture.now, requireSealedValues: true }),
    errorCode("COMPOSER_OUTPUT_TAMPERED"),
  );
  assert.deepEqual(await readFile(sealedValuePath), secretBytes);
});

test("adoption rejects byte and mode tampering without deleting or replacing the composed root", async () => {
  const fixture = await createProductionRunComposerFixture({ suiteRoot, candidate, name: "000002" });
  const summary = await prepareProductionDesktopRunV1({ ...fixture.paths, now: fixture.now });
  const original = await readFile(summary.runConfig.path);
  const changed = Buffer.from(original);
  changed[changed.length - 2] = changed[changed.length - 2] === 0x7d ? 0x20 : 0x7d;
  await chmod(summary.runConfig.path, 0o600);
  await writeFile(summary.runConfig.path, changed);
  await chmod(summary.runConfig.path, 0o400);
  await assert.rejects(
    prepareProductionDesktopRunV1({ ...fixture.paths, now: fixture.now }),
    errorCode("COMPOSER_OUTPUT_TAMPERED"),
  );
  assert.deepEqual(await readFile(summary.runConfig.path), changed);
  assert.equal((await lstat(fixture.outputRoot)).isDirectory(), true);

  const receiptFixture = await createProductionRunComposerFixture({ suiteRoot, candidate, name: "000006" });
  await prepareProductionDesktopRunV1({ ...receiptFixture.paths, now: receiptFixture.now });
  const compositionPath = join(receiptFixture.outputRoot, "composition.json");
  const compositionBytes = await readFile(compositionPath);
  await chmod(compositionPath, 0o600);
  await assert.rejects(
    prepareProductionDesktopRunV1({ ...receiptFixture.paths, now: receiptFixture.now }),
    errorCode("COMPOSER_OUTPUT_TAMPERED"),
  );
  assert.deepEqual(await readFile(compositionPath), compositionBytes);
  assert.equal((await lstat(compositionPath)).mode & 0o777, 0o600);
});

test("closed input and secret-shaped policy failures happen before an output root or cross-preflight exists", async () => {
  const fixture = await createProductionRunComposerFixture({ suiteRoot, candidate, name: "000003" });
  const changed = structuredClone(fixture.reservation);
  changed.policy.secret = "password=not-allowed";
  await replaceSealed(fixture.paths.reservationPath, changed);
  await assert.rejects(
    prepareProductionDesktopRunV1({ ...fixture.paths, now: fixture.now }),
    errorCode("FORBIDDEN_SECRET_MATERIAL"),
  );
  await assert.rejects(access(fixture.outputRoot), /ENOENT/u);

  const second = await createProductionRunComposerFixture({ suiteRoot, candidate, name: "000004" });
  const unknown = { ...second.scenarioInput, unreviewed: true };
  await replaceSealed(second.paths.scenarioPath, unknown);
  await assert.rejects(
    prepareProductionDesktopRunV1({ ...second.paths, now: second.now }),
    errorCode("INVALID_COMPOSER_INPUT"),
  );
  await assert.rejects(access(second.outputRoot), /ENOENT/u);
});

test("an internally consistent alternate prox2 gateway is rejected before composition or cross-preflight", async () => {
  const fixture = await createProductionRunComposerFixture({ suiteRoot, candidate, name: "000007" });
  const changed = structuredClone(fixture.provider);
  changed.provider.gatewayId = "9024";
  await replaceSealed(fixture.paths.providerPath, changed);
  await assert.rejects(
    prepareProductionDesktopRunV1({ ...fixture.paths, now: fixture.now }),
    errorCode("INVALID_COMPOSER_INPUT"),
  );
  await assert.rejects(access(fixture.outputRoot), /ENOENT/u);
});

test("an internally consistent alternate prox2 VNet is rejected before composition or cross-preflight", async () => {
  const fixture = await createProductionRunComposerFixture({ suiteRoot, candidate, name: "000009" });
  const changed = structuredClone(fixture.provider);
  changed.provider.networkId = "caller-selected";
  await replaceSealed(fixture.paths.providerPath, changed);
  await assert.rejects(
    prepareProductionDesktopRunV1({ ...fixture.paths, now: fixture.now }),
    errorCode("INVALID_COMPOSER_INPUT"),
  );
  await assert.rejects(access(fixture.outputRoot), /ENOENT/u);
});

test("text assertions stage a distinct one-shot sealed value instead of treating it as a GUI binding", async () => {
  const fixture = await createProductionRunComposerFixture({ suiteRoot, candidate, name: "000008" });
  const changed = structuredClone(fixture.scenarioInput);
  changed.scenario.assertions.push({
    assertionId: "000008-text-present",
    type: "text_ref_present",
    targetRef: "active-task",
    expectedRef: "expected-output-000008",
    checkpointId: "000008-completed",
  });
  changed.scenarioManifest.digest = sha256({ schemaVersion: 1, scenarios: [changed.scenario] });
  await replaceSealed(fixture.paths.scenarioPath, changed);

  const summary = await prepareProductionDesktopRunV1({ ...fixture.paths, now: fixture.now });
  assert.deepEqual(summary.sealedValues.values.map(({ valueRef }) => valueRef), [
    "benchmark-000008",
    "expected-output-000008",
  ]);
  assert.equal(Object.hasOwn(fixture.reservation.homelab.guiBindings, "expected-output-000008"), false);

  for (const [index, requirement] of summary.sealedValues.values.entries()) {
    await writeFile(requirement.path, Buffer.from(`opaque-${index}\n`), { flag: "wx", mode: 0o400 });
    await chown(requirement.path, process.getuid(), process.getgid());
    await chmod(requirement.path, 0o400);
  }
  const adopted = await prepareProductionDesktopRunV1({ ...fixture.paths, now: fixture.now, requireSealedValues: true });
  assert.deepEqual(adopted, summary);
});

test("the real host binder rejects a well-formed but mismatched host fingerprint and composer rolls back only its new root", async () => {
  const fixture = await createProductionRunComposerFixture({ suiteRoot, candidate, name: "000005" });
  const sibling = join(dirname(fixture.outputRoot), "operator-owned-sibling.txt");
  await writeFile(sibling, "preserve\n", { mode: 0o600 });
  const changed = structuredClone(fixture.provider);
  changed.controller.hostFingerprint = candidate.providerKey.fingerprint;
  await replaceSealed(fixture.paths.providerPath, changed);
  await assert.rejects(
    prepareProductionDesktopRunV1({ ...fixture.paths, now: fixture.now }),
    errorCode("HOST_BINDING_PREFLIGHT_FAILED"),
  );
  await assert.rejects(access(fixture.outputRoot), /ENOENT/u);
  assert.equal(await readFile(sibling, "utf8"), "preserve\n");
  assert.equal((await lstat(dirname(fixture.outputRoot))).mode & 0o777, 0o700);
});

test("composer CLI is closed over required absolute options", async () => {
  const { stdout, stderr } = await exec(process.execPath, [composerCli, "--help"], { encoding: "utf8" });
  assert.equal(stderr, "");
  assert.match(stdout, /^Usage: nelos-prepare-production-run /u);
  await assert.rejects(
    exec(process.execPath, [composerCli, "--output-root", "relative"], { encoding: "utf8" }),
    (error) => error?.code === 2 && /must be one normalized non-root absolute path/u.test(error.stderr),
  );
});
