import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export async function pathInfo(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

export async function pathExists(path) {
  return (await pathInfo(path)) !== null;
}

export async function assertNoSymlinkComponents(
  path,
  label,
  { allowMissing = true } = {},
) {
  const components = [];
  let current = resolve(path);
  while (true) {
    components.push(current);
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  for (const component of components.reverse()) {
    const info = await pathInfo(component);
    if (!info) {
      if (allowMissing) return;
      throw new Error(`${label} is missing: ${component}`);
    }
    if (info.isSymbolicLink()) {
      throw new Error(`${label} contains a symlinked path component: ${component}`);
    }
    if (!info.isDirectory()) {
      throw new Error(`${label} contains a non-directory path component: ${component}`);
    }
  }
}

export async function ensureCanonicalDirectory(
  path,
  label,
  { create = true, mode = 0o700, enforceMode = false } = {},
) {
  await assertNoSymlinkComponents(path, label, { allowMissing: create });
  const existing = await pathInfo(path);
  const created = create && !existing;
  if (created) await mkdir(path, { recursive: true, mode });
  await assertNoSymlinkComponents(path, label, { allowMissing: false });
  const info = await pathInfo(path);
  if (!info?.isDirectory() || info.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory: ${path}`);
  }
  let canonical = await realpath(path);
  if (canonical !== resolve(path)) {
    throw new Error(`${label} contains a symlinked path component: ${path}`);
  }
  if (created || enforceMode) {
    await chmod(path, mode);
    await assertNoSymlinkComponents(path, label, { allowMissing: false });
    canonical = await realpath(path);
    if (canonical !== resolve(path)) {
      throw new Error(`${label} contains a symlinked path component: ${path}`);
    }
  }
  return canonical;
}
