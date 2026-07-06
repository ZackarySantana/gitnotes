# GitNotes Chrome Extension — Plan

A Chrome extension that surfaces `git notes` on GitHub commit and PR pages, since
GitHub hosts pushed notes refs but stopped rendering them (~2014).

## Validated feasibility (2026-07-05)

Tested live against `git/git` on github.com — the entire pipeline works with the
public REST API, no cloning needed:

1. **Discover notes refs**: `GET /repos/{o}/{r}/git/matching-refs/notes/`
   → returns e.g. `refs/notes/amlog` with its tip commit SHA.
2. **Handle fanout**: the notes tree maps *annotated commit SHA → note blob*.
   Git fans large trees out into 2-hex-char subtrees; `git/git` uses 2 levels
   (`00/00/23961a…`). Fanout depth can be 0, 1, or 2 — detect once per repo by
   inspecting the top-level tree and cache it.
3. **Fetch a note in one request**:
   `GET /repos/{o}/{r}/contents/{sha[0:2]}/{sha[2:4]}/{sha[4:]}?ref=refs/notes/amlog`
   → base64 note content. Verified: returned the actual note for commit
   `000023961a…`.

GraphQL alternative (better for PR pages): `object(expression: "refs/notes/amlog:00/00/xxx")`
— and aliases let you batch lookups for all commits in a PR in **one query**.

## Architecture (Manifest V3)

```
content script (github.com/*)        service worker              options page
  - detect commit SHAs on page  →     - GitHub API client         - PAT storage
  - inject note UI              ←     - ref/fanout/blob caching   - notes-ref config
  - html notes: chip → Hub tab        - rate-limit handling       - per-repo settings
```

- **Content script**: matches `github.com/*/*/commit/*`, `/pull/*`, `/commits/*`.
  GitHub is a Turbo SPA — re-run detection on `turbo:load` / `turbo:render`
  events plus a MutationObserver fallback. Extract SHAs from the URL and from
  commit-list DOM elements (`clipboard-copy` values, `/commit/<sha>` hrefs).
- **Service worker**: owns all API calls (keeps the PAT out of page context),
  caching, and request coalescing.
- **Messaging**: content script asks worker `getNotes(owner, repo, [shas])`,
  worker answers with `{sha: {ref, content, type}}`.

## Caching strategy

The cache **is** the library. Everything fetched while browsing GitHub is
persisted to IndexedDB by the service worker; the Hub reads the same store.
Notes objects are content-addressed → immutable, so cache aggressively:
- Per repo: notes ref list + tip SHA + fanout depth (TTL ~5 min, or re-check tip).
- Per (tip SHA, commit SHA): note blob SHA or `null` — a changed note means a
  new tip SHA, which invalidates naturally. Negative results (`null` = "no
  note") are cached too; most commits have no note and this is the hot path.
- Blobs by SHA: cached forever, deduped.

"Cached" and "viewed" are distinct: caching happens automatically as pages are
browsed; a **view** is recorded only when the user explicitly opens a note
(expands an inline panel or opens it in the Hub). View events are append-only
with timestamps — when a note was viewed is first-class data.

## Auth

- Unauthenticated: 60 req/hr — fine for demos on public repos only.
- Fine-grained PAT (contents: read) stored in `chrome.storage.local`: 5000/hr
  and unlocks private repos. GraphQL requires a token, so the batched PR path
  is token-only; fall back to REST when no token.
- Later: GitHub OAuth device flow for a nicer onboarding than "paste a PAT".

## Rendering tiers ("dynamic notes")

### Note schema (v1 — JSON envelope, HTML first-class)

A typed note is a single JSON object. **HTML is the de facto standard**;
markdown is supported but second-class; bare non-JSON content is the plain-text
fallback.

```json
{
  "title": "Perf regression analysis",
  "gitnotes": 1,
  "type": "html",
  "body": "<!doctype html><html>…</html>"
}
```

- `gitnotes` (required): schema version.
- `type`: `html` (default & preferred) | `markdown` | `text`. Later: `json`
  + `schema` field for structured renderers.
- `title` (optional, keep it the first key): Hub sidebar label, and it keeps
  the first line of raw `git notes show` output human-scannable.
- `body`: the payload string.

Detection is trivial and unambiguous: `JSON.parse` succeeds *and* has a
`gitnotes` key → typed note; anything else → plain text. Unknown `type` on a
valid envelope → render `body` as text with a "produced by a newer schema"
hint. Never error on malformed input.

Known trade-off: raw `git log --show-notes` shows an escaped JSON blob rather
than prose. Acceptable — agents and the extension are the primary writers and
readers; the leading `title` key keeps it scannable.

**Renderer registry**: rendering is dispatched on `type` through a registry
(`type → renderer`), used by both the inline panel and the Hub. Adding a type
later (json+schema, images) = registering one renderer; storage and UI don't
change. Renderers declare where they may run: `text`/`markdown` run inline on
GitHub and in the Hub; `html` runs **Hub-sandbox-only** — inline on GitHub it
shows as title + "Open dynamic note ⧉" chip.

## The Hub (dynamic-note viewer + library)

HTML/dynamic notes are never rendered on github.com. Instead the content script
shows a link chip; clicking it opens a dedicated extension page in a new tab —
the **Hub** — which is both the viewer for that note and a library of every
note the user has ever viewed.

**Open flow**: chip click → message to service worker →
`chrome.tabs.create({url: hub.html#/note/<owner>/<repo>/<notesRef>/<commitSha>})`.
Routing via URL hash keeps the hub a single static page. Going through the
worker (instead of a direct `chrome-extension://` href) avoids putting hub.html
in `web_accessible_resources`, so websites can't probe for the extension.

**Layout**:
- *Sidebar*: viewing history — search + filters (repo, type, date, pinned).
- *Center*: the current note rendered in the sandboxed iframe.
- *Control chrome* (outside the iframe, trusted): open commit on GitHub,
  re-fetch from origin, "changed upstream" indicator (blob-SHA comparison),
  raw-source toggle, copy raw, pin/favorite, delete from history.

**Storage** (IndexedDB on the extension origin; request `unlimitedStorage`),
shared between service worker and Hub:
- `blobs`: `blobSha → {content, parsedEnvelope {gitnotes, type, title}, size,
  fetchedAt}` — content-addressed, immutable, deduped.
- `commitNotes`: `(owner, repo, notesRef, commitSha) → {blobSha | null,
  tipSha, cachedAt}` — the browse-time cache, including negative entries.
  Same note seen from many commits = one blob, many entries. A note edited
  upstream = new blob SHA for the same commit → free per-note version history.
- `viewEvents`: append-only `{owner, repo, notesRef, commitSha, blobSha,
  viewedAt, surface: inline | hub}` — every explicit open, full timestamps.
- `noteMeta`: `(repo, commitSha, notesRef) → {pinned, tags?}` — user state.
- Title: envelope `title`, else first heading/line of body, else commit subject.

**Sidebar model** — viewed > cached, time is first-class:
- Default view: *Viewed*, grouped by day like browser history (Today,
  Yesterday, …), sorted by last view; each entry shows view count + last
  viewed.
- Secondary view/filter: *All cached* — everything encountered while
  browsing, including never-opened notes (shown dimmed / "never opened").
- Filters on top of either: repo, type, pinned, date range.

### Security (the hard constraint)

Untrusted note HTML never runs with page or extension privileges:

- On github.com: dynamic notes are a link only — nothing note-derived touches
  GitHub's DOM (a note author must never get XSS on github.com).
- In the Hub: the hub page has `chrome.*` access, so notes render inside a
  manifest-`sandbox`ed iframe (CSP: no network, no top navigation, no extension
  APIs), fed via `postMessage`. `<script>` in notes is allowed *inside* the
  sandbox — that's what makes notes truly dynamic — but it can't reach the hub,
  GitHub, or the network.
- Markdown tier (rendered inline on GitHub): render + sanitize (DOMPurify)
  even though it's "just" markdown.

## UI injection points

1. **Commit page** (`/commit/<sha>`): a "Git note" panel under the commit
   message — the MVP.
2. **PR "Commits" tab**: badge on commits that have notes; expand inline.
3. **PR conversation/files**: badge in the header if any commit in the PR has a
   note; panel listing them. (Head commit SHA is in the DOM; full list via API:
   `GET /repos/{o}/{r}/pulls/{n}/commits`.)
4. **Commit list pages** (`/commits/<branch>`): same badge treatment.

## Roadmap

**Phase 1 — MVP (commit pages, schema v1)** ✅ shipped (verified live on git/git)
- MV3 scaffold (TypeScript + Vite/CRXJS or plain esbuild), options page w/ PAT.
- REST client: ref discovery, fanout detection, contents lookup.
- IndexedDB store from day one (blobs / commitNotes / viewEvents) — the cache
  is the library, so it can't be an afterthought.
- JSON envelope parser + renderer registry with `text` and `markdown`; `html`
  notes show title + a chip (Hub lands in Phase 2).
- Commit-page content script + note panel, Turbo navigation handling.
- Default ref `refs/notes/commits` + configurable extra refs.

**Phase 2 — Hub + HTML (the headline feature) + PRs**
- ✅ Hub page: hash routing, Viewed/All-cached sidebar with day grouping,
  search, center viewer with control bar (GitHub link, copy raw, raw toggle).
- ✅ `type: html` renderer in the manifest-sandboxed iframe (Hub-only); the
  GitHub chip and a per-panel "Hub ⧉" button open it.
- ✅ Repo filter (matches by repo name across owners, so forks group together)
  and a commit diff viewer (unified + split layouts, per-file collapse, stat
  bars; diff fetched via the worker from the commits API).
- ✅ Viewer is a vertical split: note on top, diff below, draggable divider
  with collapse chevrons; layout persisted to localStorage.
- ✅ Sidebar rows lead with the commit subject (worker-fetched via the commits
  API, cached forever in a `commits` store — db v2), then repo@sha + ref chip,
  then icon meta row (first-viewed time, commit time; no view counts).
- ✅ Right-click a sidebar entry → "Remove from library" (deletes view events
  + cache entry + orphaned blob; local only, reappears if browsed again).
- ✅ Sidebar note-type chips (html/md/text); diff intraline (word-level)
  highlighting; diff toolbar: expand/collapse all, jump-to-file, find bar
  with prev/next + match count.
- ✅ Note badges on commit-list and PR pages (batched lookup, one badge per
  commit, click deep-links into the Hub).
- ✅ Diff-aware links: `gitnotes:diff/<path>[#R29[-R40]]` in markdown/html
  note bodies navigates + highlights the Hub's diff pane (sandbox forwards
  clicks via postMessage; inline panels deep-link into the Hub; external
  http(s) links in html notes now open in a new tab).
- Remaining: pin/favorite, PR commits/conversation badges, GraphQL batching.

**Phase 3 — structured notes + hub extras**
- First structured renderer (`type: json` + `schema`; pick one real use case,
  e.g. CI/benchmark results).
- "Changed upstream" re-fetch, export/import library, tags.

**Phase 4 — polish**
- OAuth device flow, GitHub Enterprise host config, Firefox port
  (MV3 mostly compatible), dark/light theming to match GitHub.

## Agent skill (no CLI)

Agents write notes with plain git — the deliverable is a skill
(`skills/gitnotes/SKILL.md`) encoding conventions, not commands:
- the audience principle: **code → agents, notes → humans**. Notes are
  agent-authored reports that make large PRs digestible for human reviewers
  (guided diff tours, evidence, risk areas) — agents never read notes as
  context; the only read is a clobber-check before writing;
- when a note beats a PR comment (durable report vs. conversation);
- the SHA-keying caveat: rebase/squash orphans notes → attach durable notes to
  landed commits, or write after merge;
- schema v1 envelope; ref conventions (`refs/notes/review` for review-cycle
  records, extension auto-discovers);
- fetch → `git notes add` → push, and `git notes merge -s union` recovery for
  concurrent writers.

Distribute by copying into a repo's `.claude/skills/` (or a plugin later).

## Open decisions

1. **Note source**: plan assumes notes are *pushed to GitHub*
   (`git push origin 'refs/notes/*'` — not pushed by default; docs must say so).
   Alternative for unpushed notes: a native-messaging host reading the local
   clone — powerful but heavyweight; defer.
2. **Which refs by default**: just `refs/notes/commits`, or auto-discover all
   `refs/notes/*` and show each as a labeled section? (Auto-discover is one
   cheap API call — lean toward it.)
3. **Write support**: read-only first. Adding/editing notes via the API is
   possible (create blob/tree/commit + update ref) but is a whole project of
   its own (fanout rewriting, race conditions).
