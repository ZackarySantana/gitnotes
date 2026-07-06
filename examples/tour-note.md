# Example: a guided-tour note with diff-aware links

A markdown note that walks a reviewer through a commit. Attach it to one of
your own commits (paths/lines must match that commit's diff):

```bash
# 1. Edit the payload below so the gitnotes:diff/ paths + lines match a real
#    commit in your repo, save it as body.md, then wrap it in the envelope:
jq -Rs --arg title "Review tour: retry logic rework" \
  '{title: $title, gitnotes: 1, type: "markdown", body: .}' body.md > note.json

# 2. Attach + push:
git notes --ref=review add -F note.json <commit-sha>
git push origin refs/notes/review
```

Payload (`body.md`):

```markdown
## What changed and why

We were retrying on every error class, which hammered downstream services
during outages. This commit scopes retries to transient failures only.

**Read the diff in this order:**

1. Start with [the new error classifier](gitnotes:diff/src/errors.ts#R12-R48) —
   everything else hangs off it.
2. Then [the retry loop](gitnotes:diff/src/retry.ts#R71) that now consults it.
3. The deleted [blanket catch](gitnotes:diff/src/retry.ts#L45-L60) is the
   behavior change to scrutinize (old-side lines — this code is gone).
4. [Tests](gitnotes:diff/test/retry.test.ts) cover the three failure classes.

**Risk:** callers relying on retries for non-transient errors will now see
failures immediately — grep results in the PR thread.
```

Line syntax: `#R29` = new side, `#L29` = old side (deleted code), `#R29-R40` =
range highlight, bare file path = jump to the file.
