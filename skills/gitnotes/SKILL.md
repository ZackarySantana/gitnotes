---
name: gitnotes
description: Write git notes as durable, commit-attached reports for human reviewers (guided PR tours, review summaries, benchmarks) rendered by the GitNotes browser extension. Use when asked to attach a note to a commit or make a large PR digestible for reviewers.
---

# Git notes for the review cycle

Git notes attach metadata to a commit **without changing its SHA** or touching
the PR conversation. Notes pushed to GitHub are rendered by the GitNotes
extension on commit and PR pages. No extra tooling is needed — plain git does
everything.

## When to write a note (vs. a PR comment)

- **PR comment**: conversation — questions, requested changes, anything a
  human should respond to.
- **Git note**: a durable, richly-rendered report *for human reviewers*,
  attached to the code itself — a guided tour of a large PR, review summary,
  performance analysis, benchmark results, security assessment.

The direction of communication is one-way: **code → agents, notes → humans.**
You write notes to make big changes digestible for people; you do not read
them for context. A good HTML note for a large PR walks the reviewer through
it: what changed and why, in what order to read the diff, risk areas, evidence
(benchmarks, screenshots-as-inline-SVG, test results).

**Critical**: notes are keyed by commit SHA. Rebase, amend, and squash-merge
produce new SHAs and **orphan the note**. Therefore:
- Attach durable notes to commits that will not be rewritten — the merge
  commit, the squashed commit after merge, or commits already on the main
  branch.
- For an open PR that will be squash-merged, prefer a PR comment during
  review, then write the note on the landed commit after merge.
- If the user has `notes.rewriteRef` configured, local rebase/amend copies
  notes along — but never rely on this for remote workflows.

## Note format (GitNotes schema v1)

A note is a single JSON object. **`html` is the standard type** — write a
self-contained HTML document (inline CSS/JS, no external resources; it renders
in a sandboxed iframe with no network). Use `markdown` only for simple prose;
bare plain text (non-JSON) is the fallback for trivial one-liners.

```json
{
  "title": "Review summary for auth refactor",
  "gitnotes": 1,
  "type": "html",
  "body": "<!doctype html><html>…</html>"
}
```

Keep `title` as the first key — it's the Hub's sidebar label and keeps raw
`git notes show` output scannable.

Don't hand-escape the body into JSON. Write the HTML to a file and let `jq`
build the envelope:

```bash
jq -Rs --arg title "Review summary for auth refactor" \
  '{title: $title, gitnotes: 1, type: "html", body: .}' \
  body.html > note.json
```

## Diff-aware links (guided tours)

Inside a note body (markdown or html), link to specific places in the commit's
diff — the GitNotes viewer navigates and highlights the target right below the
note:

```
gitnotes:diff/<file-path>            jump to a file in the diff
gitnotes:diff/<file-path>#R29        line 29 on the new side (L = old side)
gitnotes:diff/<file-path>#R29-R40    highlight a range
```

Markdown: `[the retry loop](gitnotes:diff/src/retry.c#R29-R40)`.
HTML: `<a href="gitnotes:diff/src/retry.c#R29">the retry loop</a>`.

Use these to structure a review tour: "start with [the schema change](…),
then [the migration](…), the risky part is [here](…)". Use paths exactly as
they appear in the commit's diff, and line numbers from the NEW side of the
diff unless you're pointing at deleted code. Outside GitNotes the links are
inert text — harmless degradation.

## Which ref

- `refs/notes/commits` — git's default; shows in plain `git log`. Use for
  general annotations.
- `refs/notes/review` — review-cycle records (summaries, assessments). Keeps
  default `git log` output clean; the extension auto-discovers all
  `refs/notes/*` refs.

## Writing a note

Sync first (notes are NOT fetched or pushed by default), then create, then
push:

```bash
# 1. Get the latest notes from the remote
git fetch origin 'refs/notes/*:refs/notes/*'

# 2. Create the note from the envelope built above
git notes --ref=review add -F note.json <commit-sha>

# 3. Push it up
git push origin refs/notes/review
```

- Updating a typed note: **replace, never append** — appending concatenates
  blobs and corrupts the JSON envelope. Read the existing note
  (`git notes --ref=review show <sha>`), merge content into a new envelope,
  then `git notes --ref=review add -f -F note.json <sha>`.
- `git notes append` is fine only for bare plain-text notes.
- Never force-push a notes ref.

## If the push is rejected (someone else pushed notes meanwhile)

```bash
git fetch origin refs/notes/review
git notes --ref=review merge -s union FETCH_HEAD   # or: cat_sort_uniq
git push origin refs/notes/review
```

Notes for *different* commits never conflict, so this is almost always clean.
If the *same* commit was annotated by both sides, `-s union` concatenates the
two blobs — which breaks a JSON envelope (it degrades to plain text in the
extension, nothing is lost). When that happens, read the combined note, merge
the content into one fresh envelope, and `add -f` it. If a merge leaves state
behind, inspect `.git/NOTES_MERGE_*` and resolve with
`git notes merge --commit`.

## Checking for an existing note (only before writing)

Notes are **not context for you** — they are written *for human reviewers*.
Derive your understanding from the code, history, and PR discussion. The only
reason to read a note is to avoid clobbering one when you're about to write:

```bash
git notes --ref=review show <commit-sha>   # exit code 1 = no note, safe to add
```

If one exists and you have something to add, fold both into a single fresh
envelope and `add -f` — one coherent report reads better for a human than two
stitched-together ones.
