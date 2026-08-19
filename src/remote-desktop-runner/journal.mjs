import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export class RemoteDesktopJournalError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RemoteDesktopJournalError";
    this.code = code;
  }
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function contentDigest(value) {
  return `sha256:${createHash("sha256").update(`${canonicalJson(value)}\n`).digest("hex")}`;
}

async function fsyncDirectory(path) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}

async function writeExclusive(path, bytes) {
  const handle = await open(path, "wx", 0o600);
  try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
}

export class AtomicRemoteDesktopJournal {
  constructor(directory) {
    if (!isAbsolute(directory)) throw new RemoteDesktopJournalError("UNSAFE_JOURNAL", "journal directory must be absolute");
    this.directory = resolve(directory);
    this.entriesDirectory = join(this.directory, "entries");
    this.pointerPath = join(this.directory, "CURRENT");
    this.lockPath = join(this.directory, "RUNNER.lock");
  }

  async withRunLock(callback) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let acquired = false;
    for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
      try {
        await writeExclusive(this.lockPath, Buffer.from(`${canonicalJson({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`));
        acquired = true;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let owner;
        try { owner = JSON.parse(await readFile(this.lockPath, "utf8")); } catch { throw new RemoteDesktopJournalError("RUNNER_BUSY", "runner lock is unreadable and requires operator reconciliation"); }
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) throw new RemoteDesktopJournalError("RUNNER_BUSY", "runner lock identity is invalid and requires operator reconciliation");
        try { process.kill(owner.pid, 0); throw new RemoteDesktopJournalError("RUNNER_BUSY", `runner process ${owner.pid} is still active`); }
        catch (ownerError) {
          if (ownerError instanceof RemoteDesktopJournalError) throw ownerError;
          if (ownerError.code !== "ESRCH") throw new RemoteDesktopJournalError("RUNNER_BUSY", "runner lock owner cannot be safely inspected");
        }
        try { await unlink(this.lockPath); } catch (unlinkError) { if (unlinkError.code !== "ENOENT") throw unlinkError; }
      }
    }
    if (!acquired) throw new RemoteDesktopJournalError("RUNNER_BUSY", "could not acquire the runner lock");
    try { return await callback(); }
    finally { try { await unlink(this.lockPath); } catch (error) { if (error.code !== "ENOENT") throw error; } }
  }

  async initialize(value) {
    await mkdir(this.entriesDirectory, { recursive: true, mode: 0o700 });
    try {
      await stat(this.pointerPath);
      throw new RemoteDesktopJournalError("JOURNAL_EXISTS", "journal already exists; use resume");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return this.commit({ ...structuredClone(value), generation: 0 });
  }

  async load() {
    let pointer;
    try { pointer = JSON.parse(await readFile(this.pointerPath, "utf8")); }
    catch (error) { throw new RemoteDesktopJournalError("JOURNAL_UNREADABLE", `journal pointer is unreadable: ${error.message}`); }
    if (!Number.isSafeInteger(pointer.generation) || pointer.generation < 0 || !/^sha256:[0-9a-f]{64}$/u.test(pointer.digest ?? "")) {
      throw new RemoteDesktopJournalError("JOURNAL_CORRUPT", "journal pointer is invalid");
    }
    const entryPath = join(this.entriesDirectory, `${pointer.digest.slice(7)}.json`);
    let value;
    try { value = JSON.parse(await readFile(entryPath, "utf8")); }
    catch (error) { throw new RemoteDesktopJournalError("JOURNAL_CORRUPT", `journal entry is unreadable: ${error.message}`); }
    if (value.generation !== pointer.generation || contentDigest(value) !== pointer.digest) {
      throw new RemoteDesktopJournalError("JOURNAL_CORRUPT", "journal entry digest or generation does not match CURRENT");
    }
    return value;
  }

  async commit(next) {
    await mkdir(this.entriesDirectory, { recursive: true, mode: 0o700 });
    const value = structuredClone(next);
    const digest = contentDigest(value);
    const entryPath = join(this.entriesDirectory, `${digest.slice(7)}.json`);
    const bytes = Buffer.from(`${canonicalJson(value)}\n`, "utf8");
    try { await writeExclusive(entryPath, bytes); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      if ((await readFile(entryPath)).compare(bytes) !== 0) throw new RemoteDesktopJournalError("JOURNAL_CORRUPT", "content-address collision");
    }
    const pointer = Buffer.from(`${canonicalJson({ generation: value.generation, digest })}\n`, "utf8");
    const temporary = join(this.directory, `.CURRENT.${process.pid}.${value.generation}`);
    await writeExclusive(temporary, pointer);
    await rename(temporary, this.pointerPath);
    await fsyncDirectory(dirname(this.pointerPath));
    return Object.freeze({ value, digest });
  }

  async update(mutator) {
    const current = await this.load();
    const next = await mutator(structuredClone(current));
    next.generation = current.generation + 1;
    return this.commit(next);
  }
}
