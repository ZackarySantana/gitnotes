# GitNotes

Chrome extension that surfaces `git notes` on GitHub commit pages. GitHub hosts
pushed `refs/notes/*` refs but stopped rendering them — GitNotes fetches them
via the GitHub API and renders them in place.

See [PLAN.md](PLAN.md) for the full design (schema, Hub, roadmap) and
[skills/gitnotes/SKILL.md](skills/gitnotes/SKILL.md) for the agent skill that
writes notes.

## Build

```bash
npm install
npm run build        # bundles to dist/
npm run watch        # rebuild on change
```

## Load in Chrome

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select the `dist/` directory
3. Optional: open the extension's **Options** and paste a fine-grained PAT
   (repository *Contents: read*) — 5000 req/hr instead of 60, and private
   repos.

Then visit a commit that has a note, e.g. a `git/git` commit annotated in
`refs/notes/amlog`:
<https://github.com/git/git/commit/000023961a0c02d6e21dc51ea3484ff71abf1c74>

## Publishing notes so the extension can see them

```bash
git notes add -m "hello" <sha>
git push origin 'refs/notes/*'
```

## Tests

```bash
npm run typecheck            # tsc, strict
npm run test:envelope        # schema-v1 parser unit tests (Node, no framework)
node scripts/live-test-api.mjs   # live pipeline test against git/git (network)
```

## Layout

```
src/manifest.json        MV3 manifest
src/background/          service worker: API calls, IndexedDB cache, messaging
src/content/             github.com content script: SHA detection, note panels
src/lib/                 shared: contracts, envelope parser, renderers, API client, db
src/options/             options page (PAT)
```
