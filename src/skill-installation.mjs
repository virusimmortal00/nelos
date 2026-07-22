import { createHash } from "node:crypto";
import { readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

import { PROVENANCE_FILENAME } from "./distribution-provenance.mjs";
import { pathInfo } from "./path-safety.mjs";

export const MANAGED_SKILL_FILES = Object.freeze(
  ["SKILL.md", PROVENANCE_FILENAME].toSorted(),
);

export async function pathFingerprint(path) {
  const info = await pathInfo(path);
  if (!info) return "missing";
  if (info.isSymbolicLink()) return `symlink:${await readlink(path)}`;
  if (info.isDirectory()) {
    return `directory:${info.dev}:${info.ino}:${info.ctimeMs}`;
  }
  if (info.isFile()) return `file:${info.dev}:${info.ino}:${info.ctimeMs}`;
  return `other:${info.mode}:${info.dev}:${info.ino}:${info.ctimeMs}`;
}

export async function skillFingerprint(path) {
  const hash = createHash("sha256");
  const rootInfo = await pathInfo(path);
  hash.update(await pathFingerprint(path));
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    return hash.digest("hex");
  }
  for (const name of MANAGED_SKILL_FILES) {
    const file = join(path, name);
    const info = await pathInfo(file);
    hash.update(`\0${name}\0${await pathFingerprint(file)}\0`);
    if (info?.isFile() && !info.isSymbolicLink()) {
      hash.update(await readFile(file));
    }
  }
  return hash.digest("hex");
}

export async function hasOnlyManagedSkillFiles(path) {
  const info = await pathInfo(path);
  if (!info?.isDirectory() || info.isSymbolicLink()) return false;
  const entries = (await readdir(path)).toSorted();
  return (
    entries.length === MANAGED_SKILL_FILES.length &&
    entries.every((name, index) => name === MANAGED_SKILL_FILES[index])
  );
}
