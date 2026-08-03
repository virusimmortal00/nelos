import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { canonicalBytes } from "../experimentation-contract/canonical-json.mjs";

const IMPLEMENTATION_ROOTS = Object.freeze([
  Object.freeze({
    label: "src/experimentation-contract",
    url: new URL("../experimentation-contract/", import.meta.url),
  }),
  Object.freeze({
    label: "src/experimentation-corpus",
    url: new URL("./", import.meta.url),
  }),
]);

function sha256(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function implementationFiles() {
  const files = [];
  function collect(root, directoryUrl, relativeDirectory = "") {
    for (const entry of readdirSync(directoryUrl, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = relativeDirectory === ""
        ? entry.name
        : `${relativeDirectory}/${entry.name}`;
      const url = new URL(relativePath, root.url);
      if (entry.isSymbolicLink()) {
        throw new Error(`grader implementation member cannot be a symlink: ${root.label}/${relativePath}`);
      }
      if (entry.isDirectory()) {
        collect(root, new URL(`${relativePath}/`, root.url), relativePath);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".mjs")) continue;
      const stat = lstatSync(url);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error(`grader implementation member must be a regular file: ${root.label}/${relativePath}`);
      }
      files.push(Object.freeze({
        path: `${root.label}/${relativePath}`,
        digest: sha256(readFileSync(url)),
      }));
    }
  }
  for (const root of IMPLEMENTATION_ROOTS) {
    collect(root, root.url);
  }
  return Object.freeze(files.sort((left, right) => left.path.localeCompare(right.path)));
}

export function validateGraderImplementationManifest(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.files) ||
    value.files.length === 0 ||
    Object.keys(value).sort().join() !== "files,schemaVersion"
  ) {
    throw new TypeError("grader implementation manifest is invalid");
  }
  let previous = null;
  for (const file of value.files) {
    if (
      file === null ||
      typeof file !== "object" ||
      Array.isArray(file) ||
      Object.keys(file).sort().join() !== "digest,path" ||
      typeof file.path !== "string" ||
      !/^src\/(?:experimentation-contract|experimentation-corpus)\/(?:[a-z0-9-]+\/)*[a-z0-9-]+\.mjs$/u.test(file.path) ||
      !/^sha256:[0-9a-f]{64}$/u.test(file.digest) ||
      (previous !== null && previous.localeCompare(file.path) >= 0)
    ) {
      throw new TypeError("grader implementation manifest member is invalid");
    }
    previous = file.path;
  }
  return value;
}

export function graderImplementationDigest(value) {
  validateGraderImplementationManifest(value);
  return sha256(canonicalBytes(value));
}

export function graderImplementationManifest() {
  return Object.freeze({ schemaVersion: 1, files: implementationFiles() });
}
