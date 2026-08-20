import { constants } from "node:fs";
import { lstat, open, readdir, realpath, unlink } from "node:fs/promises";
import path from "node:path";

const VALUE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export class SealedValueError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SealedValueError";
    this.code = code;
  }
}

/**
 * One-shot resolver for benchmark values staged by a trusted secret provider.
 * Values are unlinked before they are returned and callers must invoke dispose.
 */
export class SealedValueResolver {
  #root;
  #consumed = new Set();
  #maxBytes;

  constructor({ root, maxBytes = 1_048_576 }) {
    if (!path.isAbsolute(root) || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 16_777_216) throw new SealedValueError("INVALID_SEALED_ROOT", "sealed value root and byte bound must be valid");
    this.#root = path.resolve(root);
    this.#maxBytes = maxBytes;
  }

  async #rootHandle() {
    let canonical; let handle;
    try {
      canonical = await realpath(this.#root);
      if (canonical !== this.#root) throw new SealedValueError("INVALID_SEALED_ROOT", "sealed value root is not canonical");
      handle = await open(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const info = await handle.stat();
      if (!info.isDirectory() || info.isSymbolicLink?.() || (info.mode & 0o777) !== 0o700) throw new SealedValueError("INVALID_SEALED_ROOT", "sealed value root is not an exclusive directory");
      return { canonical, handle, uid: info.uid, gid: info.gid };
    } catch (error) {
      await handle?.close();
      if (error instanceof SealedValueError) throw error;
      throw new SealedValueError("INVALID_SEALED_ROOT", "sealed value root is unavailable");
    }
  }

  async #openValue(root, valueRef, { allowMissing = false } = {}) {
    const candidate = path.join(root.canonical, `${valueRef}.sealed`);
    let handle;
    try {
      handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      const [resolved, descriptor, pathname] = await Promise.all([realpath(candidate), handle.stat(), lstat(candidate)]);
      if (path.dirname(resolved) !== root.canonical || !descriptor.isFile() || descriptor.isSymbolicLink?.() || descriptor.nlink !== 1 ||
          descriptor.dev !== pathname.dev || descriptor.ino !== pathname.ino || descriptor.uid !== root.uid || descriptor.gid !== root.gid ||
          (descriptor.mode & 0o777) !== 0o400 || descriptor.size < 1 || descriptor.size > this.#maxBytes) {
        throw new SealedValueError("INVALID_SEALED_VALUE", "sealed value ownership, link count, mode, or size is invalid");
      }
      return { candidate, handle };
    } catch (error) {
      await handle?.close();
      if (allowMissing && error?.code === "ENOENT") return null;
      if (error instanceof SealedValueError) throw error;
      throw new SealedValueError("SEALED_VALUE_UNAVAILABLE", "sealed value reference could not be opened safely");
    }
  }

  async resolve(valueRef) {
    if (!VALUE_REF.test(valueRef ?? "")) throw new SealedValueError("INVALID_VALUE_REF", "invalid opaque value reference");
    if (this.#consumed.has(valueRef)) throw new SealedValueError("VALUE_REF_CONSUMED", "sealed value reference is one-shot");
    const root = await this.#rootHandle();
    let opened;
    let value;
    let handedOff = false;
    try {
      opened = await this.#openValue(root, valueRef);
      value = await opened.handle.readFile();
      await unlink(opened.candidate);
      await root.handle.sync();
      this.#consumed.add(valueRef);
      let disposed = false;
      handedOff = true;
      return {
        bytes: value,
        dispose() {
          if (!disposed) value.fill(0);
          disposed = true;
        },
      };
    } catch (error) {
      if (error instanceof SealedValueError) throw error;
      throw new SealedValueError("SEALED_VALUE_UNAVAILABLE", "sealed value reference could not be resolved");
    } finally {
      if (!handedOff) value?.fill(0);
      await opened?.handle.close();
      await root.handle.close();
    }
  }

  /**
   * Remove every still-present declared value without reading its contents.
   * The returned closed inventory can be journaled before infrastructure
   * cleanup; any undeclared .sealed file or unsafe inode fails closed.
   */
  async cleanup(valueRefs) {
    if (!Array.isArray(valueRefs) || valueRefs.length > 1_000 ||
        valueRefs.some((valueRef) => !VALUE_REF.test(valueRef ?? "")) || new Set(valueRefs).size !== valueRefs.length) {
      throw new SealedValueError("INVALID_VALUE_REF", "declared sealed value inventory is invalid");
    }
    const declaredValueRefs = [...valueRefs].sort(); const declared = new Set(declaredValueRefs);
    const removedValueRefs = []; const alreadyAbsentValueRefs = [];
    const root = await this.#rootHandle();
    try {
      for (const valueRef of declaredValueRefs) {
        const opened = await this.#openValue(root, valueRef, { allowMissing: true });
        if (opened === null) { alreadyAbsentValueRefs.push(valueRef); continue; }
        try {
          await unlink(opened.candidate);
          removedValueRefs.push(valueRef);
          this.#consumed.add(valueRef);
        } finally { await opened.handle.close(); }
      }
      await root.handle.sync();
      const remaining = (await readdir(root.canonical, { withFileTypes: true }))
        .filter((entry) => entry.name.endsWith(".sealed"))
        .map((entry) => entry.name.slice(0, -".sealed".length));
      if (remaining.some((valueRef) => !declared.has(valueRef))) throw new SealedValueError("UNDECLARED_SEALED_VALUE", "sealed value root contains an undeclared value");
      if (remaining.length !== 0) throw new SealedValueError("SEALED_VALUE_CLEANUP_FAILED", "declared sealed values remain after cleanup");
      return Object.freeze({
        schemaVersion: 1,
        kind: "sealed-value-absence",
        declaredValueRefs,
        removedValueRefs: removedValueRefs.sort(),
        alreadyAbsentValueRefs: alreadyAbsentValueRefs.sort(),
        remainingValueRefs: [],
      });
    } finally { await root.handle.close(); }
  }
}
