import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { canonicalBytes, canonicalDigest, canonicalize, sha256Bytes } from "../experimentation-contract/index.mjs";
import { ensureCanonicalDirectory } from "../path-safety.mjs";
import { EVENT_CLASSIFICATIONS } from "./contracts.mjs";
import { evidenceFailure } from "./errors.mjs";

const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu,
  /\bBearer\s+[A-Za-z0-9._~+/-]{12,}=*/giu,
  /\b(?:sk|sk-proj|ghp|github_pat)_[A-Za-z0-9_-]{12,}\b/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\b(?:password|passwd|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[=:]\s*[^\s,;]{4,}/giu,
  /\b(?:authorization|cookie|set-cookie)\s*:\s*[^\r\n]+/giu,
];
const MEDIA_TEXT = /^(?:text\/|application\/(?:json|xml|javascript|x-ndjson))/u;

function scanSecrets(text) {
  return SECRET_PATTERNS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => ({ index: match.index, length: match[0].length })));
}

function redactSecrets(text) {
  let output = text;
  let changed = false;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, () => { changed = true; return "[REDACTED]"; });
  }
  return { output, changed };
}

async function stageAndLink(stagingRoot, target, bytes) {
  const temporary = resolve(stagingRoot, randomUUID());
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temporary, target);
    await chmod(target, 0o400);
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
    const existing = await readFile(target);
    if (!existing.equals(bytes)) evidenceFailure("ALTERED_ARTIFACT", "content-addressed target contains different bytes");
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

function validateRetention(retention) {
  if (!retention || typeof retention !== "object" || Array.isArray(retention)) evidenceFailure("INVALID_ARTIFACT", "retention policy is required");
  if (typeof retention.policyId !== "string" || typeof retention.legalHold !== "boolean" || (retention.retainUntil !== null && Number.isNaN(Date.parse(retention.retainUntil)))) evidenceFailure("INVALID_ARTIFACT", "retention policy is invalid");
}

export class ArtifactStore {
  #root;
  #staging;

  constructor(root) {
    this.#root = root;
    this.#staging = resolve(root, "staging");
  }

  static async open(root) {
    const canonicalRoot = await ensureCanonicalDirectory(root, "artifact store", { mode: 0o700, enforceMode: true });
    await Promise.all([
      mkdir(resolve(canonicalRoot, "staging"), { recursive: true, mode: 0o700 }),
      mkdir(resolve(canonicalRoot, "manifests"), { recursive: true, mode: 0o700 }),
      ...EVENT_CLASSIFICATIONS.map((classification) => mkdir(resolve(canonicalRoot, "objects", classification), { recursive: true, mode: 0o700 })),
    ]);
    return new ArtifactStore(canonicalRoot);
  }

  get root() { return this.#root; }

  async commit({
    bytes, kind, mediaType, encoding = "identity", experimentId, runId, trialId,
    attempt, producerEventId, provenanceDigest, classification = "internal",
    redactionPolicy = { policyId: "privacy-v1", onSecret: "quarantine" },
    readers = [], encryption = "at-rest", retention,
  }) {
    if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
    if (!EVENT_CLASSIFICATIONS.includes(classification)) evidenceFailure("INVALID_ARTIFACT", "artifact classification is invalid");
    if (!MEDIA_TEXT.test(mediaType) && redactionPolicy.onSecret === "redact") evidenceFailure("INVALID_ARTIFACT", "binary artifacts cannot use textual redaction");
    validateRetention(retention);
    if (!Array.isArray(readers) || readers.some((reader) => typeof reader !== "string" || !reader)) evidenceFailure("INVALID_ARTIFACT", "artifact readers are invalid");
    if (!["at-rest", "envelope", "none-public"].includes(encryption) || (classification !== "public" && encryption === "none-public")) evidenceFailure("INVALID_ARTIFACT", "artifact encryption policy is invalid");

    let committedBytes = bytes;
    let redactionStatus = "none";
    const textual = MEDIA_TEXT.test(mediaType);
    const text = textual ? bytes.toString("utf8") : "";
    const findings = textual ? scanSecrets(text) : [];
    if (findings.length > 0) {
      if (redactionPolicy.onSecret === "drop") evidenceFailure("PRIVACY_DROPPED", "artifact was dropped by privacy policy");
      if (redactionPolicy.onSecret === "redact") {
        committedBytes = Buffer.from(redactSecrets(text).output, "utf8");
        redactionStatus = "redacted";
      } else if (redactionPolicy.onSecret === "quarantine") {
        classification = "quarantined";
        readers = [...new Set([...readers, "privacy-reviewer"])];
        redactionStatus = "quarantined";
      } else {
        evidenceFailure("PRIVACY_VIOLATION", "privacy policy has no fail-closed secret action");
      }
    }

    const contentDigest = sha256Bytes(committedBytes);
    const artifactId = `artifact:${contentDigest.slice(7)}`;
    const objectRoot = await ensureCanonicalDirectory(resolve(this.#root, "objects", classification), "artifact namespace", { create: false });
    await ensureCanonicalDirectory(this.#staging, "artifact staging", { create: false });
    const manifestRoot = await ensureCanonicalDirectory(resolve(this.#root, "manifests"), "artifact manifests", { create: false });
    const objectPath = resolve(objectRoot, contentDigest.slice(7));
    await stageAndLink(this.#staging, objectPath, committedBytes);
    const unsigned = {
      schemaVersion: 1, artifactId, contentDigest, kind, mediaType, encoding,
      byteLength: committedBytes.byteLength, experimentId, runId, trialId, attempt,
      producerEventId, provenanceDigest, classification,
      redaction: { policyId: redactionPolicy.policyId, status: redactionStatus },
      storage: { namespace: classification, encryption },
      access: { readers: [...new Set(readers)].sort() },
      retention: { policyId: retention.policyId, retainUntil: retention.retainUntil, legalHold: retention.legalHold },
      supersedesManifestDigest: null,
    };
    const manifest = Object.freeze({ ...unsigned, manifestDigest: canonicalDigest(unsigned) });
    await stageAndLink(this.#staging, resolve(manifestRoot, `${manifest.manifestDigest.slice(7)}.json`), canonicalBytes(manifest));
    return manifest;
  }

  async verify(manifest) {
    const fields = ["schemaVersion", "artifactId", "contentDigest", "kind", "mediaType", "encoding", "byteLength", "experimentId", "runId", "trialId", "attempt", "producerEventId", "provenanceDigest", "classification", "redaction", "storage", "access", "retention", "supersedesManifestDigest", "manifestDigest"];
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest) || Object.keys(manifest).sort().join() !== fields.sort().join()) evidenceFailure("INVALID_ARTIFACT", "artifact manifest fields must match the closed schema");
    if (manifest.schemaVersion !== 1) evidenceFailure("INCOMPATIBLE_EVIDENCE", "artifact manifest schema is unsupported");
    if (!EVENT_CLASSIFICATIONS.includes(manifest.classification) || manifest.storage?.namespace !== manifest.classification) evidenceFailure("INVALID_ARTIFACT", "artifact storage namespace is invalid");
    if (typeof manifest.contentDigest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(manifest.contentDigest) || manifest.artifactId !== `artifact:${manifest.contentDigest.slice(7)}`) evidenceFailure("INVALID_ARTIFACT", "artifact identity is invalid");
    if (!Number.isSafeInteger(manifest.byteLength) || manifest.byteLength < 0 || !Number.isSafeInteger(manifest.attempt) || manifest.attempt < 1) evidenceFailure("INVALID_ARTIFACT", "artifact bounds are invalid");
    if (!Array.isArray(manifest.access?.readers)) evidenceFailure("INVALID_ARTIFACT", "artifact access policy is invalid");
    validateRetention(manifest.retention);
    const material = { ...manifest };
    delete material.manifestDigest;
    if (manifest.manifestDigest !== canonicalDigest(material)) evidenceFailure("ALTERED_ARTIFACT", "artifact manifest digest is invalid");
    const objectRoot = await ensureCanonicalDirectory(resolve(this.#root, "objects", manifest.storage.namespace), "artifact namespace", { create: false });
    const path = resolve(objectRoot, manifest.contentDigest.slice(7));
    let bytes;
    try { bytes = await readFile(path); } catch (error) { if (error.code === "ENOENT") evidenceFailure("MISSING_ARTIFACT", "artifact bytes are missing"); throw error; }
    if (bytes.byteLength !== manifest.byteLength || sha256Bytes(bytes) !== manifest.contentDigest) evidenceFailure("ALTERED_ARTIFACT", "artifact bytes do not match the manifest");
    return bytes;
  }

  async read(manifest, { principal }) {
    if (manifest.classification !== "public" && !manifest.access.readers.includes(principal)) evidenceFailure("UNAUTHORIZED_ARTIFACT", "artifact reference does not confer read authority");
    return this.verify(manifest);
  }
}

export function captureAllowedEnvironment(environment, allowlist) {
  const output = {};
  for (const name of allowlist) {
    if (/TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|AUTH|PRIVATE|CREDENTIAL|API_KEY/iu.test(name)) evidenceFailure("PRIVACY_VIOLATION", "secret-bearing environment names cannot be captured");
    if (Object.hasOwn(environment, name)) output[name] = environment[name];
  }
  return Buffer.from(canonicalize(output), "utf8");
}
