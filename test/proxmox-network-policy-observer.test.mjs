import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, chown, copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const source = resolve("validation/proxmox/desktop/helpers/nelos-network-policy-observer.py");
const NOW = Date.parse("2026-08-20T12:00:00.000Z");
const canonical = (value) => JSON.stringify(value, Object.keys(value).sort());
const sortDeep = (value) => Array.isArray(value)
  ? value.map(sortDeep)
  : value !== null && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]))
    : value;
const bytes = (value) => Buffer.from(JSON.stringify(sortDeep(value)));
const sha256 = (value) => `sha256:${createHash("sha256").update(Buffer.isBuffer(value) ? value : bytes(value)).digest("hex")}`;

function ruleset({ extraAccept = false, addresses = ["104.18.1.10", "104.18.2.10"] } = {}) {
  return Buffer.from(`table inet nelosbld {
\tset approved_ipv4 {
\t\ttype ipv4_addr
\t\tflags timeout
\t\telements = { ${addresses.join(", ")} }
\t}

\tchain forward {
\t\ttype filter hook forward priority filter; policy drop;
\t\tct state established,related accept
\t\tip saddr 10.77.77.0/24 ip daddr @approved_ipv4 tcp dport 443 accept
${extraAccept ? "\t\tip saddr 10.77.77.0/24 accept\n" : ""}\t}
}
`);
}

function approvedSet({ addresses = ["104.18.1.10", "104.18.2.10"], expires = [600_000, 900_000] } = {}) {
  return {
    nftables: [
      { metainfo: { json_schema_version: 1 } },
      { set: {
        family: "inet", table: "nelosbld", name: "approved_ipv4", type: "ipv4_addr", flags: ["timeout"],
        elem: addresses.map((val, index) => ({ elem: { val, timeout: 1_800_000, expires: expires[index] } })),
      } },
    ],
  };
}

function runProgram(command, args, env) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    const stdout = []; const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk)); child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", rejectPromise);
    child.once("close", (code) => resolvePromise({ code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}

async function fixture(t, options = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "nelos-policy-observer-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  await chmod(root, 0o700);
  await writeFile(join(root, ".nelos-network-policy-observer-fake-root"), "nelos-network-policy-observer-fake-root-v1\n", { mode: 0o600 });
  const libexec = join(root, "usr/libexec"); await mkdir(libexec, { recursive: true, mode: 0o755 });
  const installed = join(libexec, "nelos-network-policy-observer"); await copyFile(source, installed); await chmod(installed, 0o755);
  await chown(installed, process.getuid(), process.getgid());
  const nft = join(root, "nft.mjs");
  const completeRuleset = ruleset(options);
  const setValue = approvedSet(options);
  await writeFile(nft, `#!${process.execPath}
const args = process.argv.slice(2);
if (JSON.stringify(args) === JSON.stringify(["--stateless","list","ruleset"])) process.stdout.write(Buffer.from(${JSON.stringify(completeRuleset.toString("base64"))}, "base64"));
else if (JSON.stringify(args) === JSON.stringify(["--json","list","set","inet","nelosbld","approved_ipv4"])) process.stdout.write(JSON.stringify(${JSON.stringify(setValue)}));
else process.exit(91);
`);
  await chmod(nft, 0o755);
  return {
    completeRuleset,
    installed,
    env: {
      NELOS_NETWORK_POLICY_NFT: nft,
      NELOS_NETWORK_POLICY_OBSERVER_ROOT: root,
      NELOS_NETWORK_POLICY_TEST_NOW: String(NOW),
    },
  };
}

test("fixed gateway observer hashes complete nft bytes and the exact live timeout inventory", async (t) => {
  const value = await fixture(t);
  const result = await runProgram("/usr/bin/python3", [value.installed, "observe"], value.env);
  assert.equal(result.code, 0, result.stderr);
  const measurement = JSON.parse(result.stdout);
  assert.equal(result.stdout.toString("utf8"), `${JSON.stringify(sortDeep(measurement))}\n`);
  assert.equal(measurement.rulesetDigest, sha256(value.completeRuleset));
  assert.equal(measurement.approvedAddressInventoryDigest, sha256({ addresses: ["104.18.1.10", "104.18.2.10"] }));
  assert.equal(measurement.policyDigest, sha256({
    approvedAddressInventoryDigest: measurement.approvedAddressInventoryDigest,
    kind: "nelos.proxmox-desktop.gateway-policy-identity.v1",
    networkId: "nelosbld",
    rulesetDigest: measurement.rulesetDigest,
    schemaVersion: 1,
  }));
  assert.equal(measurement.approvedAddressCount, 2);
  assert.equal(measurement.expiresAt, "2026-08-20T12:10:00.000Z");
  assert.equal(measurement.helper.digest, sha256(await readFile(value.installed)));
  const { measurementDigest, ...unsigned } = measurement;
  assert.equal(measurementDigest, sha256(unsigned));
});

test("fixed gateway observer rejects broadened forwarding and empty or malformed timeout inventories", async (t) => {
  const broadened = await fixture(t, { extraAccept: true });
  const broadResult = await runProgram("/usr/bin/python3", [broadened.installed, "observe"], broadened.env);
  assert.equal(broadResult.code, 77); assert.match(broadResult.stderr, /broader than allowed/u);

  const empty = await fixture(t, { addresses: [], expires: [] });
  const emptyResult = await runProgram("/usr/bin/python3", [empty.installed, "observe"], empty.env);
  assert.equal(emptyResult.code, 77); assert.match(emptyResult.stderr, /empty or exceeds/u);

  const expiring = await fixture(t, { addresses: ["104.18.1.10"], expires: [0] });
  const expiryResult = await runProgram("/usr/bin/python3", [expiring.installed, "observe"], expiring.env);
  assert.equal(expiryResult.code, 77); assert.match(expiryResult.stderr, /timeout is invalid/u);
});

test("observer accepts no caller-selected command and contains no shell execution surface", async (t) => {
  const value = await fixture(t);
  const denied = await runProgram("/usr/bin/python3", [value.installed, "observe", "inet", "other"], value.env);
  assert.equal(denied.code, 64); assert.match(denied.stderr, /accepts only observe/u);
  const helper = await readFile(source, "utf8");
  assert.doesNotMatch(helper, /shell\s*=\s*True|os\.system|subprocess\.Popen/u);
  assert.match(helper, /\["--stateless", "list", "ruleset"\]/u);
  assert.match(helper, /\["--json", "list", "set", "inet", NETWORK_ID, "approved_ipv4"\]/u);
  assert.equal(canonical({ b: 2, a: 1 }), '{"a":1,"b":2}');
});
