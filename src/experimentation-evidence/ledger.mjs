import { open, readFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalize } from "../experimentation-contract/index.mjs";
import { ensureCanonicalDirectory } from "../path-safety.mjs";
import { EVIDENCE_STREAMS, validateEvidenceEvent } from "./contracts.mjs";
import { evidenceFailure } from "./errors.mjs";

function chainKey(event) {
  return `${event.writerId}\0${event.writerEpoch}`;
}

async function appendDurably(path, bytes) {
  const handle = await open(path, "a", 0o600);
  try {
    await handle.write(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export class EvidenceLedger {
  #root;
  #events = [];
  #byId = new Map();
  #chainHeads = new Map();
  #streamContracts;
  #pending = Promise.resolve();

  constructor(root, streamContracts) {
    this.#root = root;
    this.#streamContracts = streamContracts;
  }

  static async open(root, { streamContracts = null } = {}) {
    const canonicalRoot = await ensureCanonicalDirectory(root, "evidence ledger", { mode: 0o700, enforceMode: true });
    await mkdir(resolve(canonicalRoot, "streams"), { recursive: true, mode: 0o700 });
    const ledger = new EvidenceLedger(canonicalRoot, streamContracts);
    await ledger.#load();
    return ledger;
  }

  get root() { return this.#root; }
  get events() { return Object.freeze([...this.#events]); }

  async #load() {
    const loaded = [];
    for (const stream of EVIDENCE_STREAMS) {
      const path = resolve(this.#root, "streams", `${stream}.jsonl`);
      let text;
      try { text = await readFile(path, "utf8"); } catch (error) { if (error.code === "ENOENT") continue; throw error; }
      if (text && !text.endsWith("\n")) evidenceFailure("INTERRUPTED_LEDGER", `stream ${stream} has an incomplete terminal record`);
      for (const [index, line] of text.split("\n").entries()) {
        if (!line) continue;
        let event;
        try { event = JSON.parse(line); } catch { evidenceFailure("MALFORMED_STREAM", `stream ${stream} record ${index + 1} is malformed`); }
        if (event.stream !== stream) evidenceFailure("STREAM_CONTRACT_VIOLATION", "event is stored in the wrong stream");
        validateEvidenceEvent(event, { streamContracts: this.#streamContracts });
        loaded.push(event);
      }
    }
    loaded.sort((left, right) => left.writerId.localeCompare(right.writerId) || left.writerEpoch - right.writerEpoch || left.sequence - right.sequence);
    for (const event of loaded) this.#accept(event);
  }

  #accept(event) {
    validateEvidenceEvent(event, { streamContracts: this.#streamContracts });
    if (this.#byId.has(event.eventId) || [...this.#byId.values()].some((entry) => entry.eventDigest === event.eventDigest)) evidenceFailure("DUPLICATE_EVIDENCE", "duplicate event identity or digest");
    const key = chainKey(event);
    const head = this.#chainHeads.get(key);
    if (!head && (event.sequence !== 1 || event.previousEventDigest !== null)) evidenceFailure("SEQUENCE_GAP", "writer chain does not begin at sequence 1");
    if (head && (event.sequence !== head.sequence + 1 || event.previousEventDigest !== head.eventDigest)) evidenceFailure("SEQUENCE_GAP", "writer sequence or digest chain is discontinuous");
    this.#events.push(event);
    this.#byId.set(event.eventId, event);
    this.#chainHeads.set(key, event);
  }

  append(event) {
    const operation = this.#pending.then(async () => {
      const previousHead = this.#chainHeads.get(chainKey(event));
      this.#accept(event);
      try {
        await appendDurably(resolve(this.#root, "streams", `${event.stream}.jsonl`), `${canonicalize(event)}\n`);
      } catch (error) {
        this.#events.pop();
        this.#byId.delete(event.eventId);
        if (previousHead) this.#chainHeads.set(chainKey(event), previousHead);
        else this.#chainHeads.delete(chainKey(event));
        evidenceFailure("SINK_LOSS", "event could not be durably committed", { cause: error.code ?? error.message });
      }
      return event;
    });
    this.#pending = operation.catch(() => {});
    return operation;
  }
}
