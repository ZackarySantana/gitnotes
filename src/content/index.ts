// Content script: surfaces git notes on GitHub commit pages, and note badges
// on commit-list and PR pages.
// Bundled as an iife — this file is an entry point with no exports.

import { renderNote } from '../lib/render'
import type { GetNotesResponse, NoteResult, WorkerRequest } from '../lib/types'

const ROOT_ID = 'gitnotes-root'
const TITLE_MAX = 80

/** Reserved top-level GitHub paths that can never be an owner (or repo). */
const RESERVED_SEGMENTS = new Set([
  'settings',
  'orgs',
  'notifications',
  'marketplace',
  'explore',
  'topics',
  'search',
  'pulls',
  'issues',
  'codespaces',
  'sponsors',
  'features',
  'about',
  'pricing',
  'apps',
  'login',
  'join',
])

const SHA_RE = /^[0-9a-f]{7,40}$/

interface CommitRoute {
  owner: string
  repo: string
  sha: string
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function parseCommitRoute(pathname: string): CommitRoute | null {
  const parts = pathname.split('/').filter((p) => p.length > 0)
  if (parts.length !== 4) return null
  const [owner, repo, keyword, sha] = parts
  if (!owner || !repo || keyword !== 'commit' || !sha) return null
  if (
    RESERVED_SEGMENTS.has(owner.toLowerCase()) ||
    RESERVED_SEGMENTS.has(repo.toLowerCase())
  ) {
    return null
  }
  if (!SHA_RE.test(sha)) return null
  return { owner, repo, sha }
}

// ---------------------------------------------------------------------------
// Messaging (worker may be asleep or erroring — never throw into the page)
// ---------------------------------------------------------------------------

function sendRequest<T>(message: WorkerRequest): Promise<T | undefined> {
  try {
    return chrome.runtime.sendMessage(message).then(
      (response) => response as T,
      (err: unknown) => {
        console.debug('[gitnotes] message failed:', err)
        return undefined
      },
    )
  } catch (err) {
    console.debug('[gitnotes] message failed:', err)
    return Promise.resolve(undefined)
  }
}

// ---------------------------------------------------------------------------
// Panel construction (titles/labels via textContent only — renderNote owns
// body rendering; no note-derived innerHTML anywhere in this file)
// ---------------------------------------------------------------------------

function noteTitle(note: NoteResult): string {
  let title = ''
  if (note.parsed.kind === 'typed' && note.parsed.envelope.title) {
    title = note.parsed.envelope.title.trim()
  }
  if (!title) {
    const firstLine = note.content.split('\n', 1)[0] ?? ''
    title = firstLine.trim()
  }
  if (!title) title = '(empty note)'
  if (title.length > TITLE_MAX) {
    title = `${title.slice(0, TITLE_MAX - 1).trimEnd()}…`
  }
  return title
}

function shortRefName(notesRef: string): string {
  if (notesRef.startsWith('refs/notes/')) return notesRef.slice('refs/notes/'.length)
  const last = notesRef.split('/').filter((p) => p.length > 0).pop()
  return last ?? notesRef
}

function hubRoute(route: CommitRoute, fullSha: string, note: NoteResult) {
  return { owner: route.owner, repo: route.repo, notesRef: note.notesRef, commitSha: fullSha }
}

function buildPanel(route: CommitRoute, fullSha: string, note: NoteResult): HTMLElement {
  const panel = document.createElement('section')
  panel.className = 'gitnotes-panel'

  const header = document.createElement('div')
  header.className = 'gitnotes-header'
  header.setAttribute('role', 'button')
  header.setAttribute('tabindex', '0')
  header.setAttribute('aria-expanded', 'false')

  const triangle = document.createElement('span')
  triangle.className = 'gitnotes-triangle'
  triangle.setAttribute('aria-hidden', 'true')
  triangle.textContent = '▸'

  const badge = document.createElement('span')
  badge.className = 'gitnotes-badge'
  badge.textContent = 'Git note'

  const title = document.createElement('span')
  title.className = 'gitnotes-title'
  title.textContent = noteTitle(note)

  const ref = document.createElement('span')
  ref.className = 'gitnotes-ref'
  ref.textContent = shortRefName(note.notesRef)
  ref.title = note.notesRef

  const hubButton = document.createElement('button')
  hubButton.type = 'button'
  hubButton.className = 'gitnotes-hub-link'
  hubButton.textContent = 'Hub ⧉'
  hubButton.title = 'Open in the GitNotes Hub — all your notes in one place'
  hubButton.addEventListener('click', (event) => {
    event.stopPropagation() // don't toggle the panel
    void sendRequest({ type: 'openHub', route: hubRoute(route, fullSha, note) })
  })

  header.append(triangle, badge, title, ref, hubButton)

  const body = document.createElement('div')
  body.className = 'gitnotes-body'
  body.hidden = true // collapsed by default

  let expanded = false
  let renderedOnce = false

  const toggle = (): void => {
    expanded = !expanded
    body.hidden = !expanded
    triangle.textContent = expanded ? '▾' : '▸'
    header.setAttribute('aria-expanded', String(expanded))
    if (expanded && !renderedOnce) {
      // First explicit expand: render the body and record the view.
      // Views are recorded ONLY here — that's a product invariant.
      renderedOnce = true
      try {
        body.appendChild(
          renderNote(note, {
            surface: 'inline',
            owner: route.owner,
            repo: route.repo,
            onOpenHub: (n) =>
              void sendRequest({ type: 'openHub', route: hubRoute(route, fullSha, n) }),
            // Diff links have no diff pane inline — open the Hub at that spot.
            onDiffLink: (href) =>
              void sendRequest({
                type: 'openHub',
                route: hubRoute(route, fullSha, note),
                diffTarget: href,
              }),
          }),
        )
      } catch (err) {
        console.debug('[gitnotes] renderNote failed:', err)
      }
      void sendRequest({
        type: 'recordView',
        owner: route.owner,
        repo: route.repo,
        notesRef: note.notesRef,
        commitSha: fullSha,
        blobSha: note.blobSha,
        surface: 'inline',
      })
    }
  }

  header.addEventListener('click', toggle)
  header.addEventListener('keydown', (event) => {
    if (event.target !== header) return // let the hub button handle its own keys
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggle()
    }
  })

  panel.append(header, body)
  return panel
}

function buildRoot(
  route: CommitRoute,
  fullSha: string,
  notes: NoteResult[],
  errors: string[],
): HTMLElement {
  const root = document.createElement('div')
  root.id = ROOT_ID
  for (const message of errors) {
    const notice = document.createElement('p')
    notice.className = 'gitnotes-notice'
    notice.textContent = message
    root.appendChild(notice)
  }
  for (const note of notes) {
    root.appendChild(buildPanel(route, fullSha, note))
  }
  return root
}

// ---------------------------------------------------------------------------
// Injection (GitHub's DOM shifts — try anchors in order, retry with backoff)
// ---------------------------------------------------------------------------

function removeRoot(): void {
  document.getElementById(ROOT_ID)?.remove()
}

function tryInject(root: HTMLElement): boolean {
  const commitBody = document.querySelector('.commit-desc, [data-testid="commit-body"]')
  const commitTitle = document.querySelector('.commit-title, [data-testid="commit-title"]')
  const diff = document.querySelector('#diff-content, [data-testid="diff-content"]')
  const main = document.querySelector('main')

  removeRoot()
  if (commitBody) {
    commitBody.after(root)
  } else if (commitTitle) {
    commitTitle.after(root)
  } else if (diff) {
    diff.before(root)
  } else if (main) {
    main.prepend(root)
  } else {
    return false
  }
  return true
}

const RETRY_DELAYS_MS = [250, 600, 1200, 2400]

function injectWithRetry(root: HTMLElement, pageKey: string, attempt = 0): void {
  if (location.href !== pageKey) return // navigated away while waiting
  if (tryInject(root)) {
    // Only now is the page truly done — and if Turbo later morphs the body
    // and wipes the panel, needsRun() notices the missing root and re-runs.
    completedKey = pageKey
    rootExpectedForKey = pageKey
    return
  }
  const delay = RETRY_DELAYS_MS[attempt]
  if (delay === undefined) {
    // Give up without marking completion: the next turbo/mutation event
    // retries the whole flow (cheap — the worker's cache answers instantly).
    console.debug('[gitnotes] no injection anchor found; giving up for now')
    return
  }
  setTimeout(() => injectWithRetry(root, pageKey, attempt + 1), delay)
}

// ---------------------------------------------------------------------------
// Page handling + SPA navigation
// ---------------------------------------------------------------------------

// completedKey marks a page that was fully handled (panel injected, or nothing
// to show). It is set only on success so failed attempts are retried by the
// next event. inFlightKey just prevents concurrent duplicate runs.
let inFlightKey: string | null = null
let completedKey: string | null = null
let rootExpectedForKey: string | null = null

function needsRun(key: string): boolean {
  if (key === inFlightKey) return false
  if (key !== completedKey) return true
  // Completed — but re-run if our injected panel was wiped by a body morph.
  return rootExpectedForKey === key && document.getElementById(ROOT_ID) === null
}

async function handle(): Promise<void> {
  const key = location.href
  if (!needsRun(key)) return
  inFlightKey = key
  try {
    const route = parseCommitRoute(location.pathname)
    if (!route) {
      removeRoot() // Turbo can carry our panel across navigations
      completedKey = key
      rootExpectedForKey = null
      return
    }

    const response = await sendRequest<GetNotesResponse>({
      type: 'getNotes',
      owner: route.owner,
      repo: route.repo,
      shas: [route.sha],
    })
    if (location.href !== key) return // navigated away while awaiting
    if (!response) {
      // Never leave a previous commit's panel on this page; no completedKey,
      // so the next event retries.
      removeRoot()
      return
    }

    // Response keys are FULL 40-char SHAs (the worker expands short ones) —
    // take the matching/only entry rather than assuming the URL sha is the key.
    const entries = Object.entries(response.notes ?? {})
    const entry = entries.find(([full]) => full.startsWith(route.sha)) ?? entries[0]
    const fullSha = entry ? entry[0] : route.sha
    const notes = entry ? entry[1] : []
    const errors = response.errors ?? []

    removeRoot()
    if (notes.length === 0 && errors.length === 0) {
      completedKey = key // no notes → silent, and done
      rootExpectedForKey = null
      return
    }

    injectWithRetry(buildRoot(route, fullSha, notes, errors), key)
  } finally {
    if (inFlightKey === key) inFlightKey = null
  }
}

// ---------------------------------------------------------------------------
// Commit-list badges (commit lists, PR commits tab, PR conversation timeline)
//
// Unlike the commit page's page-level completion guard, this pass is
// incremental and idempotent per element: every run rescans the DOM for
// commit links (GitHub lazy-loads timeline chunks, so new rows appear on
// mutation runs), batches all newly discovered SHAs into one getNotes
// message, and injects at most one badge per SHA per page.
// ---------------------------------------------------------------------------

const FULL_SHA_RE = /^[0-9a-f]{40}$/
const BADGE_TITLE_MAX = 60
const SVG_NS = 'http://www.w3.org/2000/svg'
/** Octicon "note" (16px grid), static path, filled with currentColor. */
const NOTE_ICON_PATH =
  'M0 3.75C0 2.784.784 2 1.75 2h12.5c.966 0 1.75.784 1.75 1.75v8.5A1.75 1.75 ' +
  '0 0 1 14.25 14H1.75A1.75 1.75 0 0 1 0 12.25Zm1.75-.25a.25.25 0 0 0-.25.25v8.5c0 ' +
  '.138.112.25.25.25h12.5a.25.25 0 0 0 .25-.25v-8.5a.25.25 0 0 0-.25-.25ZM3.5 ' +
  '6.25a.75.75 0 0 1 .75-.75h7a.75.75 0 0 1 0 1.5h-7a.75.75 0 0 1-.75-.75Zm.75 ' +
  '2.25h4a.75.75 0 0 1 0 1.5h-4a.75.75 0 0 1 0-1.5Z'

interface ListRoute {
  owner: string
  repo: string
}

/** Pages that list commits: /{o}/{r}/commits[/branch...], /{o}/{r}/pull/{n},
 * /{o}/{r}/pull/{n}/commits. Commit pages themselves never match. */
function parseListRoute(pathname: string): ListRoute | null {
  const parts = pathname.split('/').filter((p) => p.length > 0)
  if (parts.length < 3) return null
  const [owner, repo, third, fourth, fifth] = parts
  if (!owner || !repo || !third) return null
  if (
    RESERVED_SEGMENTS.has(owner.toLowerCase()) ||
    RESERVED_SEGMENTS.has(repo.toLowerCase())
  ) {
    return null
  }
  if (third === 'commits') return { owner, repo } // list, optionally /{branch...}
  if (third === 'pull' && fourth && /^\d+$/.test(fourth)) {
    if (parts.length === 4) return { owner, repo } // PR conversation
    if (parts.length === 5 && fifth === 'commits') return { owner, repo } // PR commits tab
  }
  return null
}

/** Full commit SHA from an anchor href, iff it points at a commit of THIS
 * repo: /{o}/{r}/commit/{40-hex} or /{o}/{r}/pull/{n}/commits/{40-hex}. */
function commitShaFromHref(href: string, route: ListRoute): string | null {
  let pathname: string
  try {
    pathname = new URL(href, location.origin).pathname
  } catch {
    return null
  }
  const parts = pathname.split('/').filter((p) => p.length > 0)
  if (parts.length === 4) {
    const [owner, repo, keyword, sha] = parts
    if (
      owner === route.owner &&
      repo === route.repo &&
      keyword === 'commit' &&
      sha &&
      FULL_SHA_RE.test(sha)
    ) {
      return sha
    }
  }
  if (parts.length === 6) {
    const [owner, repo, keyword, num, keyword2, sha] = parts
    if (
      owner === route.owner &&
      repo === route.repo &&
      keyword === 'pull' &&
      num &&
      /^\d+$/.test(num) &&
      keyword2 === 'commits' &&
      sha &&
      FULL_SHA_RE.test(sha)
    ) {
      return sha
    }
  }
  return null
}

function badgeFor(sha: string): Element | null {
  return document.querySelector(`.gitnotes-badge-chip[data-gitnotes-sha="${sha}"]`)
}

/** Best anchor to attach a badge to for this SHA: the title occurrence (link
 * text that isn't just a short/full sha) wins over bare sha links. */
function findBadgeAnchor(route: ListRoute, sha: string): HTMLAnchorElement | null {
  let fallback: HTMLAnchorElement | null = null
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>(`a[href*="${sha}"]`)) {
    const href = anchor.getAttribute('href')
    if (!href || commitShaFromHref(href, route) !== sha) continue
    const text = (anchor.textContent ?? '').trim().toLowerCase()
    if (text.length > 0 && !SHA_RE.test(text)) return anchor
    fallback ??= anchor
  }
  return fallback
}

function buildBadgeChip(
  route: ListRoute,
  fullSha: string,
  first: NoteResult,
  count: number,
): HTMLButtonElement {
  const chip = document.createElement('button')
  chip.type = 'button'
  chip.className = 'gitnotes-badge-chip'
  chip.dataset['gitnotesSha'] = fullSha

  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '12')
  svg.setAttribute('height', '12')
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', NOTE_ICON_PATH)
  svg.appendChild(path)

  const label = document.createElement('span')
  label.textContent = count === 1 ? shortRefName(first.notesRef) : `×${count}`

  chip.append(svg, label)

  let title = noteTitle(first)
  if (title.length > BADGE_TITLE_MAX) {
    title = `${title.slice(0, BADGE_TITLE_MAX - 1).trimEnd()}…`
  }
  chip.title = title

  chip.addEventListener('click', (event) => {
    event.preventDefault()
    event.stopPropagation()
    void sendRequest({
      type: 'openHub',
      route: {
        owner: route.owner,
        repo: route.repo,
        notesRef: first.notesRef,
        commitSha: fullSha,
      },
    })
  })
  return chip
}

// Per-page-URL SHA states. 'pending' = query in flight, 'none' = known
// note-less, 'badged' = badge injected. Reset on URL change — injected badges
// are discarded with GitHub's own DOM swap; state never crosses URLs.
type BadgeShaState = 'pending' | 'none' | 'badged'
let badgePageKey: string | null = null
const badgeShaStates = new Map<string, BadgeShaState>()

async function handleBadges(): Promise<void> {
  const pageKey = location.href
  if (badgePageKey !== pageKey) {
    badgePageKey = pageKey
    badgeShaStates.clear()
  }
  const route = parseListRoute(location.pathname)
  if (!route) return

  // Scan: every commit link on the page, deduped to full SHAs.
  const discovered = new Set<string>()
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href*="/commit"]')) {
    const href = anchor.getAttribute('href')
    if (!href) continue
    const sha = commitShaFromHref(href, route)
    if (sha) discovered.add(sha)
  }

  const toQuery: string[] = []
  for (const sha of discovered) {
    const state = badgeShaStates.get(sha)
    if (state === 'pending' || state === 'none') continue
    // 'badged' but the badge survived → done; if a body morph wiped it,
    // re-query (the worker's cache answers instantly) and re-inject.
    if (state === 'badged' && badgeFor(sha)) continue
    badgeShaStates.set(sha, 'pending')
    toQuery.push(sha)
  }
  if (toQuery.length === 0) return

  const response = await sendRequest<GetNotesResponse>({
    type: 'getNotes',
    owner: route.owner,
    repo: route.repo,
    shas: toQuery,
  })
  if (location.href !== pageKey) return // navigated away while awaiting
  if (!response) {
    // Forget these SHAs so the next turbo/mutation event retries them.
    for (const sha of toQuery) badgeShaStates.delete(sha)
    return
  }
  // List pages never show visible notices — debug-log only.
  for (const message of response.errors ?? []) {
    console.debug('[gitnotes] getNotes error:', message)
  }

  for (const sha of toQuery) {
    const notes = response.notes?.[sha]
    if (notes === undefined) {
      // No verdict for this sha (e.g. lookup failed) — retry on a later run.
      badgeShaStates.delete(sha)
      continue
    }
    const first = notes[0]
    if (!first) {
      badgeShaStates.set(sha, 'none')
      continue
    }
    if (badgeFor(sha)) {
      badgeShaStates.set(sha, 'badged') // already injected (concurrent run)
      continue
    }
    // Re-find the anchor: the DOM may have morphed while we were awaiting.
    const anchor = findBadgeAnchor(route, sha)
    if (!anchor) {
      badgeShaStates.delete(sha) // row gone for now; retry on a later run
      continue
    }
    const chip = buildBadgeChip(route, sha, first, notes.length)
    const parent = anchor.parentElement
    if (parent) {
      parent.appendChild(chip)
    } else {
      anchor.after(chip)
    }
    badgeShaStates.set(sha, 'badged')
  }
}

function run(): void {
  handle().catch((err: unknown) => {
    console.debug('[gitnotes] handler failed:', err)
  })
  handleBadges().catch((err: unknown) => {
    console.debug('[gitnotes] badge pass failed:', err)
  })
}

function startListening(): void {
  // GitHub is a Turbo app: re-run on Turbo navigation/render events...
  document.addEventListener('turbo:load', run)
  document.addEventListener('turbo:render', run)
  // ...plus history navigation...
  window.addEventListener('popstate', run)

  // ...plus a debounced MutationObserver fallback for DOM swaps we miss.
  let debounceTimer: number | undefined
  const observer = new MutationObserver(() => {
    if (debounceTimer !== undefined) window.clearTimeout(debounceTimer)
    debounceTimer = window.setTimeout(() => {
      debounceTimer = undefined
      run()
    }, 300)
  })
  // Observe documentElement, not body: Turbo replaces <body> wholesale on
  // navigation, which would orphan an observer bound to the old element.
  observer.observe(document.documentElement, { childList: true, subtree: true })
}

startListening()
run()
