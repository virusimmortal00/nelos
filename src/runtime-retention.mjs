import { copyFile, lstat, mkdir, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { computeDistributionIntegrity, listDistributionFiles } from "./distribution-provenance.mjs";
import { deriveRuntimeIdentityV1 } from "./runtime-identity.mjs";
import { readRuntimeContractV1, runtimeImageDirectory, runtimeImagePathV1 } from "./runtime-compatibility.mjs";

async function verify(root, identity) {
  const actual = await deriveRuntimeIdentityV1({ moduleRoot: root, declaredVersion: identity.version });
  if (actual.buildIdentity !== identity.buildIdentity || !identity.integrity ||
      await computeDistributionIntegrity(root) !== identity.integrity) {
    throw new Error("retained runtime digest does not match the selected distribution");
  }
  if (!await readRuntimeContractV1(root)) throw new Error("distribution has no runtime compatibility contract");
}

async function verifyProvenance(root, expected) {
  const actual = JSON.parse(await readFile(join(root, "distribution-provenance.json"), "utf8"));
  if (!isDeepStrictEqual(actual, expected)) throw new Error("retained runtime provenance disagrees");
}

// Publish a complete verified image atomically, before importing the server.
// Images are never updated or automatically collected: closed Desktop tasks
// can still hold old launch/skill references after their worker lease is gone.
export async function retainRuntimeV1({ moduleRoot, declaredVersion, directory = runtimeImageDirectory(), publish = rename }) {
  const root = resolve(moduleRoot);
  const sourceProvenance = JSON.parse(await readFile(join(root, "distribution-provenance.json"), "utf8"));
  const identity = await deriveRuntimeIdentityV1({ moduleRoot: root, declaredVersion });
  await verify(root, identity);
  const target = runtimeImagePathV1(identity, directory);
  if (root === target) return target;
  // Reuse only after verification. A corrupt/incomplete existing image is an
  // error, not a cache miss that may be silently overwritten.
  const existing = await lstat(target).catch((error) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existing) {
    if (!existing.isDirectory()) throw new Error("retained runtime is not a directory");
    await verify(target, identity);
    await verifyProvenance(target, sourceProvenance);
    return target;
  }
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(dirname(target), ".staging-"));
  try {
    for (const path of await listDistributionFiles(root, { includeProvenance: true })) {
      await mkdir(dirname(join(temporary, path)), { recursive: true, mode: 0o700 });
      await copyFile(join(root, path), join(temporary, path));
    }
    await verify(temporary, identity);
    // Provenance is not itself covered by the distribution digest. Bind the
    // copy before publishing it, then stop depending on the replaceable cache.
    await verifyProvenance(temporary, sourceProvenance);
    try { await publish(temporary, target); }
    catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes(error.code)) throw error;
    }
    await verify(target, identity);
    await verifyProvenance(target, sourceProvenance);
    return target;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function startRetainedNelosMcpServerV1({ moduleRoot, serverVersion }) {
  const root = await retainRuntimeV1({ moduleRoot, declaredVersion: serverVersion });
  const { startNelosMcpServer } = await import(pathToFileURL(join(root, "src/mcp-server.mjs")).href);
  return startNelosMcpServer({ serverVersion });
}
