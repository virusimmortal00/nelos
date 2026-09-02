import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export const EDITORIAL_CHECKS = Object.freeze([
  "userValue", "plainLanguage", "publicMigration", "accurateClaims", "scopeSeparation",
]);
const VERSION = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SECTIONS = new Set(["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security", "Upgrade notes", "Known issues"]);

function requireVersion(version) {
  if (typeof version !== "string" || !VERSION.test(version)) throw new Error("invalid release notes version");
}

export function extractReleaseNotes(changelog, version) {
  requireVersion(version);
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const heading = new RegExp(`^## \\[${escaped}\\] - \\d{4}-\\d{2}-\\d{2}\\s*$`, "gmu");
  const matches = [...changelog.matchAll(heading)];
  if (matches.length === 0) throw new Error(`CHANGELOG.md has no dated ${version} release section`);
  if (matches.length !== 1) throw new Error(`CHANGELOG.md has duplicate ${version} release sections`);
  const [match] = matches;
  const start = match.index;
  const remainder = changelog.slice(start + match[0].length);
  const next = /^##\s+/mu.exec(remainder);
  const end = next === null ? changelog.length : start + match[0].length + next.index;
  return `${changelog.slice(start, end).trim()}\n`;
}

export function releaseNotesDigest(notes) {
  return `sha256:${createHash("sha256").update(notes).digest("hex")}`;
}

// These are mechanical checks, not a readability score or semantic review.
export function lintReleaseNotes(notes) {
  const problems = [];
  const body = notes.slice(notes.indexOf("\n") + 1).trim();
  const summary = body.split(/^### /mu)[0].trim();
  if (!summary || /^(?:[-*]|#)/u.test(summary)) problems.push("Add a short reader-facing summary before the change sections.");
  if (/\b(?:TODO|TBD|FIXME)\b|\[(?:describe|insert|replace)[^\]]*\]/iu.test(notes)) {
    problems.push("Replace drafting placeholders before review.");
  }
  const headings = [...notes.matchAll(/^### (.+)$/gmu)];
  if (headings.length === 0) problems.push("Include at least one relevant change section.");
  const seen = new Set();
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];
    const name = heading[1];
    if (!SECTIONS.has(name)) problems.push(`Unsupported section: ${name}. Use the public release-note template.`);
    if (seen.has(name)) problems.push(`Duplicate section: ${name}.`);
    seen.add(name);
    const content = notes.slice(heading.index + heading[0].length, headings[i + 1]?.index).trim();
    if (!content || /^(?:[-*]\s*)?(?:None|N\/A)\.?$/iu.test(content)) problems.push(`Omit the empty ${name} section.`);
  }
  if (/(?:file:\/\/|https?:\/\/(?:localhost|127\.0\.0\.1)(?::|\/)|\]\((?:\/Users\/|\/private\/tmp\/))/iu.test(notes)) {
    problems.push("Replace machine-local links with publicly usable guidance.");
  }
  return problems;
}

function text(value, label) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 2000 || /\b(?:TODO|TBD|FIXME)\b|^pending$/iu.test(value)) {
    throw new Error(`release notes review requires a completed ${label}`);
  }
}

export function validateEditorialReview({ notes, version, review }) {
  requireVersion(version);
  if (extractReleaseNotes(notes, version) !== notes) throw new Error("review must cover exactly one canonical release section");
  const problems = lintReleaseNotes(notes);
  if (problems.length) throw new Error(`release notes need editing: ${problems.join(" ")}`);
  if (!review || review.schemaVersion !== 1 || review.version !== version || review.decision !== "approved") {
    throw new Error("release notes require an approved editorial review for this version");
  }
  if (review.notesDigest !== releaseNotesDigest(notes)) throw new Error("release notes changed since editorial review; review the current text again");
  text(review.author, "author");
  text(review.reviewer, "reviewer");
  if (review.author.trim().toLowerCase() === review.reviewer.trim().toLowerCase()) throw new Error("release notes need a reviewer other than their author");
  for (const name of EDITORIAL_CHECKS) {
    if (review.assessment?.[name]?.status !== "pass") throw new Error(`release notes review has not passed ${name}`);
    text(review.assessment[name].rationale, `${name} assessment`);
  }
  return { version, notesDigest: review.notesDigest, reviewer: review.reviewer, editorialReview: "approved" };
}

export async function checkReleaseNotes({ root, version, baseVersion, baseChangelog, requireReview = false }) {
  requireVersion(version);
  const changelog = await readFile(join(root, "CHANGELOG.md"), "utf8");
  const notes = extractReleaseNotes(changelog, version);
  // Development work and Unreleased entries are not an intentional release.
  // An explicit pre-tag/build check NEVER takes this branch.
  if (!requireReview && baseVersion === version && extractReleaseNotes(baseChangelog, version) === notes) {
    return { version, editorialReview: "not-required", reason: "released version and notes unchanged" };
  }
  const path = join(root, ".github", "release-notes", `${version}.json`);
  let review;
  try { review = JSON.parse(await readFile(path, "utf8")); }
  catch (error) {
    throw new Error(`Missing or invalid editorial review at .github/release-notes/${version}.json; follow docs/release-notes.md. Notes digest: ${releaseNotesDigest(notes)}`, { cause: error });
  }
  return validateEditorialReview({ notes, version, review });
}
