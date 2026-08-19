import { constants } from "node:fs";
import { open, realpath, unlink } from "node:fs/promises";
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
    if (!path.isAbsolute(root)) throw new SealedValueError("INVALID_SEALED_ROOT", "sealed value root must be absolute");
    this.#root = root;
    this.#maxBytes = maxBytes;
  }

  async resolve(valueRef) {
    if (!VALUE_REF.test(valueRef ?? "")) throw new SealedValueError("INVALID_VALUE_REF", "invalid opaque value reference");
    if (this.#consumed.has(valueRef)) throw new SealedValueError("VALUE_REF_CONSUMED", "sealed value reference is one-shot");
    const root = await realpath(this.#root);
    const candidate = path.join(root, `${valueRef}.sealed`);
    let handle;
    let value;
    let handedOff = false;
    try {
      handle = await open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
      const resolved = await realpath(candidate);
      if (path.dirname(resolved) !== root) throw new SealedValueError("SEALED_VALUE_ESCAPE", "sealed value escaped its staging root");
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size < 1 || stat.size > this.#maxBytes) {
        throw new SealedValueError("INVALID_SEALED_VALUE", "sealed value size is outside the driver limit");
      }
      value = await handle.readFile();
      await unlink(candidate);
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
      await handle?.close();
    }
  }
}
