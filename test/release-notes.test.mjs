import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EDITORIAL_CHECKS, checkReleaseNotes, extractReleaseNotes, lintReleaseNotes, releaseNotesDigest, validateEditorialReview } from "../scripts/release-notes.mjs";

const version = "0.14.0";
const notes = `## [${version}] - 2026-09-02

Task status is easier to read while parallel work is running.

### Changed
- Running tasks now show their progress without opening each task.
`;
function approval(text = notes) {
  return { schemaVersion: 1, version, notesDigest: releaseNotesDigest(text), author: "fixture-author",
    reviewer: "fixture-editor", decision: "approved", assessment: Object.fromEntries(EDITORIAL_CHECKS.map(name =>
      [name, { status: "pass", rationale: `Fixture assessment for ${name}; no production approval.` }])) };
}
async function fixture(t, text = notes) {
  const root = await mkdtemp(join(tmpdir(), "nelos-editorial-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".github", "release-notes"), { recursive: true });
  await writeFile(join(root, "CHANGELOG.md"), `# Changelog\n\n## Unreleased\n\nNone.\n\n${text}`);
  return root;
}
async function writeReview(root, review) {
  await writeFile(join(root, ".github", "release-notes", `${version}.json`), JSON.stringify(review));
}

test("approved exact notes pass; approval cannot transfer to edited text or another version", () => {
  assert.equal(validateEditorialReview({ notes, version, review: approval() }).editorialReview, "approved");
  assert.throws(() => validateEditorialReview({ notes: notes.replace("progress", "details"), version, review: approval() }), /changed since/);
  assert.throws(() => validateEditorialReview({ notes, version, review: { ...approval(), version: "0.15.0" } }), /approved editorial review/);
  assert.throws(() => validateEditorialReview({ notes: notes.replace(version, "0.15.0"), version, review: approval() }), /no dated/);
});

test("missing, pending, self-authored, and incomplete reviews fail closed", () => {
  for (const review of [undefined, { ...approval(), decision: "pending" }]) {
    assert.throws(() => validateEditorialReview({ notes, version, review }), /approved editorial review/);
  }
  assert.throws(() => validateEditorialReview({ notes, version, review: { ...approval(), reviewer: " FIXTURE-AUTHOR " } }), /other than/);
  for (const name of EDITORIAL_CHECKS) {
    const review = approval();
    review.assessment[name].status = "pending";
    assert.throws(() => validateEditorialReview({ notes, version, review }), /has not passed/);
    review.assessment[name] = { status: "pass", rationale: "" };
    assert.throws(() => validateEditorialReview({ notes, version, review }), /completed/);
  }
});

test("mechanical lint rejects placeholders, missing summary, empty sections and local links", () => {
  assert.deepEqual(lintReleaseNotes(notes), []);
  for (const text of [notes.replace("Task status is easier to read while parallel work is running.", ""),
    notes.replace("progress", "TODO"), `${notes}\n### Fixed\n\nNone.\n`,
    `${notes}\n### Changed\n\n- More changes.\n`,
    `${notes}\n### Upgrade notes\n\n- [Instructions](/Users/operator/upgrade.md)\n`]) {
    assert.ok(lintReleaseNotes(text).length > 0);
  }
  // Technical CLI names remain legitimate when needed by users, not word-banned.
  assert.deepEqual(lintReleaseNotes(`${notes}\n### Upgrade notes\n\n- Use \`nelos doctor\` to check your installation.\n`), []);
});

test("new release and changed dated notes require review, while Unreleased-only work does not", async (t) => {
  const root = await fixture(t);
  const same = { root, version, baseVersion: version,
    baseChangelog: `# Changelog\n\n## Unreleased\n\nPrevious unpublished change.\n\n${notes}` };
  assert.equal((await checkReleaseNotes(same)).editorialReview, "not-required");
  await assert.rejects(checkReleaseNotes({ ...same, requireReview: true }), /Missing or invalid editorial review/);
  await assert.rejects(checkReleaseNotes({ ...same, baseVersion: "0.13.0" }), /Missing or invalid editorial review/);
  await assert.rejects(checkReleaseNotes({ ...same, baseChangelog: notes.replace("progress", "details") }), /Missing or invalid editorial review/);
  await writeReview(root, approval());
  assert.equal((await checkReleaseNotes({ root, version, requireReview: true })).editorialReview, "approved");
});

test("duplicate sections and unsafe version paths cannot select an unintended approval", () => {
  assert.throws(() => extractReleaseNotes(`${notes}\n${notes}`, version), /duplicate/);
  assert.throws(() => extractReleaseNotes(notes, "../../another-file"), /invalid.*version/);
  assert.throws(() => extractReleaseNotes(notes, "0.15.0"), /no dated/);
});

test("release note versions accept SemVer identifiers and reject malformed segments", () => {
  for (const candidate of ["1.2.3", "1.2.3-0", "1.2.3-alpha.1", "1.2.3-01a.0-1+build.01", "1.2.3+001"]) {
    const section = notes.replace(version, candidate);
    assert.equal(extractReleaseNotes(section, candidate), section);
  }
  for (const candidate of ["1.2.3-alpha..1", "1.2.3-alpha.", "1.2.3-.alpha", "1.2.3-01", "1.2.3-alpha.01", "1.2.3+build..1", "1.2.3+build."]) {
    assert.throws(() => extractReleaseNotes(notes.replace(version, candidate), candidate), /invalid.*version/);
  }
  assert.throws(() => extractReleaseNotes(notes, `0.0.0-0.${"--.".repeat(1000)}!`), /invalid.*version/);
});

test("review template is not an approval and engineering jargon is left to editorial judgment", async (t) => {
  const root = await fixture(t, notes.replace("Running tasks now show their progress without opening each task.", "Provenance receipts bind controller attestation identities."));
  await assert.rejects(checkReleaseNotes({ root, version, requireReview: true }), /Missing or invalid editorial review/);
  await writeReview(root, { ...approval(), decision: "pending" });
  await assert.rejects(checkReleaseNotes({ root, version, requireReview: true }), /approved editorial review/);
});
