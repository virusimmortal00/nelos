# Reader-facing release notes

Write for someone who uses Nelos but has not followed its development. Lead
with what changed for them, why it matters, and any action they must take.
Ordinary task coordination is the primary audience; operators and API users
need details only when their workflows change.

## Reused practices

This template adapts [Keep a Changelog 2.0.0](https://keepachangelog.com/en/2.0.0/):
curate notable changes, group them by change type, highlight breaking changes,
and omit empty sections. It does not copy commit logs into public notes.
[GitLab's changelog guidance](https://docs.gitlab.com/development/changelog/)
provides the inclusion boundary: user/API changes belong; internal refactors,
test-suite changes, and development experiments generally do not.
[GitHub's generated notes](https://docs.github.com/en/repositories/releasing-projects-on-github/automatically-generated-release-notes)
can help inventory merged PRs, but GitHub still asks editors to check the output.
Our canonical notes remain the curated version section in `CHANGELOG.md`.

## Writing template

Use only the sections that apply. Replace the sample text; do not publish the
template or empty `None` sections. Keep the overview short; place long technical
lists in a public migration document and link to it.

```markdown
## [VERSION] - YYYY-MM-DD

One or two sentences describing the main benefit and who is affected.

### Added
- New capability and what the reader can now do.

### Changed
- Observable difference from the previous version and why it matters.

### Fixed
- Symptom users experienced and the corrected behavior.

### Removed
- **Breaking:** Removed capability, affected users, and a public migration link.

### Upgrade notes
- Required action, or a relevant compatibility requirement that changed.

### Known issues
- A current user-visible limitation and available workaround.
```

`Deprecated` and `Security` are also supported change types. Security entries
must explain an actual security impact; generic stricter validation is not
automatically a security fix. Do not publish sensitive exploit details.

## Editorial review

Give a human editor or an independent agent the proposed notes, the release
diff, and any linked migration pages. Do not tell them the notes should pass.
They must assess these five questions and request edits until each passes:

1. **User value:** Does each entry describe an observable benefit, change,
   symptom, or necessary action for a named audience? Is important breaking
   behavior included, rather than hidden to make the notes shorter?
2. **Plain language:** Can a reader unfamiliar with internal project names
   understand it? Keep CLI/API identifiers when needed for action; explain them.
3. **Public migration:** Can affected users actually follow the upgrade steps
   and access the linked guidance? A private repository or local path is not
   a migration destination for the public. If there is no public replacement,
   say so and explain the available option without inventing one.
4. **Accurate claims:** Do benefits, compatibility, security statements, and
   limitations match the evidence? Do not imply that fixture tests prove live
   GUI behavior or that rewritten metadata proves higher invocation rates.
5. **Scope separation:** Have CI steps, internal architecture, hashes, review
   counts, run IDs, and testing methodology moved to the engineering report?
   Retain details only when the reader needs them to use or upgrade Nelos.

For example, replace an internal description about controller extraction and
receipt validation with: “Desktop testing utilities are no longer bundled with
Nelos. Normal task coordination is unchanged.” Then explicitly list affected
commands in a public upgrade guide; do not send readers to the private lab.

## Enforced pre-tag gate

1. Finalize the version section and run `npm run release:notes`. If the review
   is missing, the command prints the exact notes digest and expected path.
2. The reviewer copies the [review template](../.github/release-notes/review-template.json)
   to `.github/release-notes/<version>.json`, records the author and their own
   distinct identity, and supplies a specific rationale for each criterion.
   Set each status to `pass` and decision to `approved` only after review.
3. Run `npm run release:notes` again before creating a tag. Commit the reviewed
   notes and review together. Any text change invalidates the prior approval.

CI checks changed version sections in the existing required macOS/Ubuntu jobs.
Unrelated development and Unreleased-only edits do not require approval. The
artifact builder and its `--validate-only` mode always require current approval,
even if the version already equals main; a skipped development check is not
permission to tag. Published tags, packages, and historical notes are not
rewritten to adopt this process.

The tool checks structure, drafting placeholders, obvious machine-local links,
completed assessments, distinct author/reviewer labels, and exact text binding.
It does **not** authenticate identities, judge prose, prove a rationale true,
or verify that every link is public. The reviewer and ordinary PR review own
those decisions. This is one editorial sign-off, not a new runtime service or
model dependency in CI. Never manufacture approval just to make the build pass.
