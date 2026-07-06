// GitNotes Hub — library sidebar + sandboxed note viewer.
//
// Runs as a full extension page (chrome-extension:// origin): reads the shared
// IndexedDB directly via src/lib/db.ts and talks to the service worker for
// fetch-on-miss and view recording. Routing lives entirely in location.hash —
// the sidebar sets the hash, rendering follows it.
//
// Security invariant: no note-derived string is ever innerHTML'd into this
// document. Dynamic HTML notes render inside a fresh manifest-sandboxed
// iframe (sandbox.html) fed via postMessage; everything else goes through the
// trusted renderer registry (textContent / sanitized markdown).

import {
  commitInfoKey,
  commitNoteKey,
  deleteBlobIfUnreferenced,
  deleteCommitNote,
  deleteViewEventsFor,
  getBlob,
  getCommitNote,
  listCommitNotes,
  listViewEvents,
} from '../lib/db'
import { noteTitle, parseNote } from '../lib/envelope'
import { renderNote } from '../lib/render'
import type {
  CommitInfo,
  DiffFile,
  GetCommitInfoResponse,
  GetDiffResponse,
  GetNotesResponse,
  HubNoteRoute,
  NoteResult,
  ParsedNote,
  RecordViewResponse,
  WorkerRequest,
} from '../lib/types'

// --- DOM handles -------------------------------------------------------

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id)
  if (!node) throw new Error(`GitNotes Hub: missing element #${id}`)
  return node as T
}

const searchInput = el<HTMLInputElement>('search')
const repoFilterEl = el<HTMLSelectElement>('repo-filter')
const tabViewedBtn = el<HTMLButtonElement>('tab-viewed')
const tabCachedBtn = el<HTMLButtonElement>('tab-cached')
const entryListEl = el<HTMLDivElement>('entry-list')
const emptyStateEl = el<HTMLDivElement>('empty-state')
const emptyMessageEl = el<HTMLParagraphElement>('empty-message')
const viewerSectionEl = el<HTMLElement>('viewer-section')
const controlBarEl = el<HTMLDivElement>('control-bar')
const viewerBodyEl = el<HTMLDivElement>('viewer-body')
const diffBodyEl = el<HTMLDivElement>('diff-body')
const viewerSplitEl = el<HTMLDivElement>('viewer-split')
const splitDividerEl = el<HTMLDivElement>('split-divider')
const collapseNoteBtn = el<HTMLButtonElement>('collapse-note')
const collapseDiffBtn = el<HTMLButtonElement>('collapse-diff')

// --- State --------------------------------------------------------------

type Tab = 'viewed' | 'cached'
type DiffLayout = 'unified' | 'split'

interface SidebarEntry {
  owner: string
  repo: string
  notesRef: string
  commitSha: string
  blobSha: string | null
  title: string
  /** Envelope type ('html' | 'markdown' | 'text' | unknown raw string); plain
   * non-envelope notes are 'text'. Null when the blob isn't cached locally. */
  noteType: string | null
  viewCount: number
  /** Earliest viewedAt for this note — the displayed "first viewed" time. */
  firstViewedAt: number | null
  /** Latest viewedAt — still drives day grouping and sort order. */
  lastViewedAt: number | null
  cachedAt: number | null
  /** commitNoteKey — matches the route key of the selected note. */
  key: string
}

let viewedEntries: SidebarEntry[] = []
let cachedEntries: SidebarEntry[] = []
let activeTab: Tab = 'viewed'
/** Monotonic token: only the latest renderRoute call may touch the viewer. */
let renderSeq = 0
/** Route key of the last recorded view — one recordView per selection. */
let recordedKey: string | null = null
/** Raw-source toggle for the current selection. */
let rawMode = false
/** Repo-name filter (lowercase repo name; '' = all repositories). */
let repoFilter = ''
/** localStorage key for the note/diff split (ratio + collapse flags). */
const SPLIT_STORAGE_KEY = 'gitnotes.hub.split'
const DEFAULT_SPLIT_RATIO = 0.55
/** Neither pane may be dragged below this height, in px. */
const MIN_PANE_PX = 80
/** Note-pane share of the vertical split (0–1); persisted. */
let splitRatio = DEFAULT_SPLIT_RATIO
/** Collapsed panes — at most one at a time; persisted. */
let noteCollapsed = false
let diffCollapsed = false
/** Unified/split preference — persists across files and selections. */
let diffLayout: DiffLayout = 'unified'
/** Session cache of diff responses, keyed `${owner}/${repo}@${sha}`. */
const diffCache = new Map<string, GetDiffResponse>()
/** Commit subject + time per note, keyed commitInfoKey (`owner/repo|sha`).
 * Filled lazily via getCommitInfo; misses fall back to the note title. */
const commitInfoCache = new Map<string, CommitInfo>()
/** commitInfoKeys with an in-flight getCommitInfo request (dedup only). */
const commitInfoPending = new Set<string>()
/** Diff key currently rendered (or loading) in #diff-body; null = none. */
let renderedDiffKey: string | null = null

// --- Routing ------------------------------------------------------------

/** 4-part note route, plus an optional /diff/{encoded gitnotes:diff href}
 * segment (openHub deep links). Selection identity is the 4-part route only —
 * parseRoute/routeKey ignore the diff segment, and routeHash never writes it. */
const ROUTE_RE = /^#\/note\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)(?:\/diff\/([^/]+))?$/

function parseRoute(hash: string): HubNoteRoute | null {
  const m = ROUTE_RE.exec(hash)
  if (!m) return null
  const [, owner, repo, encodedRef, commitSha] = m
  if (!owner || !repo || !encodedRef || !commitSha) return null
  let notesRef: string
  try {
    notesRef = decodeURIComponent(encodedRef)
  } catch {
    return null
  }
  return { owner, repo, notesRef, commitSha }
}

function routeHash(route: HubNoteRoute): string {
  return `#/note/${route.owner}/${route.repo}/${encodeURIComponent(route.notesRef)}/${route.commitSha}`
}

function routeKey(route: HubNoteRoute): string {
  return commitNoteKey(route.owner, route.repo, route.notesRef, route.commitSha)
}

function currentRouteKey(): string | null {
  const route = parseRoute(location.hash)
  return route ? routeKey(route) : null
}

/** The decoded gitnotes:diff/... href carried by a deep-link hash, if any. */
function routeDiffHref(hash: string): string | null {
  const encoded = ROUTE_RE.exec(hash)?.[5]
  if (!encoded) return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    console.debug('gitnotes hub: malformed diff deep-link segment', encoded)
    return null
  }
}

// --- Worker messaging ----------------------------------------------------

function sendToWorker<R>(msg: WorkerRequest): Promise<R> {
  return chrome.runtime.sendMessage(msg) as Promise<R>
}

// --- Formatting helpers ---------------------------------------------------

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

function shortRef(notesRef: string): string {
  return notesRef.replace(/^refs\/notes\//, '')
}

function titleOf(content: string, parsed: ParsedNote): string {
  const envelopeTitle = noteTitle(parsed)?.trim()
  if (envelopeTitle) return truncate(envelopeTitle, 80)
  const firstLine = content.trim().split('\n', 1)[0]?.trim() ?? ''
  return firstLine ? truncate(firstLine, 80) : '(empty note)'
}

function deriveTitle(content: string): string {
  return titleOf(content, parseNote(content))
}

/** Title + envelope type for a cached blob (sidebar rows). Plain non-envelope
 * notes are 'text'; unknown envelope types keep their raw type string. */
interface BlobMeta {
  title: string
  noteType: string
}

function deriveBlobMeta(content: string): BlobMeta {
  const parsed = parseNote(content)
  return {
    title: titleOf(content, parsed),
    noteType: parsed.kind === 'typed' ? parsed.envelope.type : 'text',
  }
}

/** Chip label + colorway class for a note type. Known types get fixed muted
 * colorways; anything else shows its raw type string in the fallback style. */
function typeChipInfo(noteType: string): { label: string; cls: string } {
  switch (noteType) {
    case 'html':
      return { label: 'html', cls: 'type-chip-html' }
    case 'markdown':
      return { label: 'md', cls: 'type-chip-md' }
    case 'text':
      return { label: 'text', cls: 'type-chip-text' }
    default:
      return { label: truncate(noteType, 16), cls: 'type-chip-other' }
  }
}

function dayLabel(ts: number): string {
  const startOfDay = (d: Date) =>
    new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
  const date = new Date(ts)
  const now = new Date()
  const diffDays = Math.round((startOfDay(now) - startOfDay(date)) / 86_400_000)
  if (diffDays === 0) return 'Today'
  if (diffDays === 1) return 'Yesterday'
  const opts: Intl.DateTimeFormatOptions = {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }
  if (date.getFullYear() !== now.getFullYear()) opts.year = 'numeric'
  return date.toLocaleDateString('en-US', opts)
}

function formatWhen(ts: number): string {
  const date = new Date(ts)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()
  const time = date.toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
  if (sameDay) return time
  const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric' }
  if (date.getFullYear() !== now.getFullYear()) opts.year = 'numeric'
  return `${date.toLocaleDateString(undefined, opts)}, ${time}`
}

// --- Sidebar icons -----------------------------------------------------------
//
// Static octicon path data (16×16 viewBox) built via createElementNS — the
// no-innerHTML rule holds even for trusted markup.

const SVG_NS = 'http://www.w3.org/2000/svg'

/** Octicon "eye" (16). */
const EYE_ICON_PATH =
  'M8 2c1.981 0 3.671.992 4.933 2.078 1.27 1.091 2.187 2.345 2.637 3.023a1.62 1.62 0 0 1 0 1.798c-.45.678-1.367 1.932-2.637 3.023C11.67 13.008 9.981 14 8 14c-1.981 0-3.671-.992-4.933-2.078C1.797 10.83.88 9.576.43 8.898a1.62 1.62 0 0 1 0-1.798c.45-.677 1.367-1.931 2.637-3.022C4.33 2.992 6.019 2 8 2ZM1.679 7.932a.12.12 0 0 0 0 .136c.411.622 1.241 1.75 2.366 2.717C5.176 11.758 6.527 12.5 8 12.5c1.473 0 2.825-.742 3.955-1.715 1.124-.967 1.954-2.096 2.366-2.717a.12.12 0 0 0 0-.136c-.412-.621-1.242-1.75-2.366-2.717C10.824 4.242 9.473 3.5 8 3.5c-1.473 0-2.825.742-3.955 1.715-1.124.967-1.954 2.096-2.366 2.717ZM8 10a2 2 0 1 1-.001-3.999A2 2 0 0 1 8 10Z'

/** Octicon "git-commit" (16). */
const COMMIT_ICON_PATH =
  'M11.93 8.5a4.002 4.002 0 0 1-7.86 0H.75a.75.75 0 0 1 0-1.5h3.32a4.002 4.002 0 0 1 7.86 0h3.32a.75.75 0 0 1 0 1.5Zm-1.43-.75a2.5 2.5 0 1 0-5 0 2.5 2.5 0 0 0 5 0Z'

function buildIcon(pathData: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', '12')
  svg.setAttribute('height', '12')
  svg.setAttribute('fill', 'currentColor')
  svg.setAttribute('aria-hidden', 'true')
  const path = document.createElementNS(SVG_NS, 'path')
  path.setAttribute('d', pathData)
  svg.appendChild(path)
  return svg
}

/** Icon + formatted time, with a "<label> <time>" tooltip. */
function timePair(iconPath: string, ts: number, label: string): HTMLElement {
  const pair = document.createElement('span')
  pair.className = 'time-pair'
  const when = formatWhen(ts)
  pair.title = `${label} ${when}`
  pair.appendChild(buildIcon(iconPath))
  const text = document.createElement('span')
  text.textContent = when
  pair.appendChild(text)
  return pair
}

// --- Sidebar data ----------------------------------------------------------

async function loadData(): Promise<void> {
  const [events, commitNotes] = await Promise.all([
    listViewEvents(),
    listCommitNotes(),
  ])

  // Resolve titles for every referenced blob. Load them all — the store is
  // local and this is v1.
  const blobShas = new Set<string>()
  for (const ev of events) blobShas.add(ev.blobSha)
  for (const cn of commitNotes) if (cn.blobSha) blobShas.add(cn.blobSha)
  const blobMeta = new Map<string, BlobMeta>()
  await Promise.all(
    [...blobShas].map(async (sha) => {
      try {
        const blob = await getBlob(sha)
        if (blob) blobMeta.set(sha, deriveBlobMeta(blob.content))
      } catch (err) {
        console.debug('gitnotes hub: failed to load blob for title', sha, err)
      }
    }),
  )
  const metaFor = (blobSha: string | null): BlobMeta | undefined =>
    blobSha ? blobMeta.get(blobSha) : undefined
  const titleFor = (blobSha: string | null): string =>
    metaFor(blobSha)?.title ?? '(content not cached)'
  const typeFor = (blobSha: string | null): string | null =>
    metaFor(blobSha)?.noteType ?? null

  // Viewed: aggregate events per (owner, repo, notesRef, commitSha). Events
  // come newest-first, so the first event seen per key carries lastViewedAt
  // and the map preserves newest-first order.
  const viewed = new Map<string, SidebarEntry>()
  for (const ev of events) {
    const key = commitNoteKey(ev.owner, ev.repo, ev.notesRef, ev.commitSha)
    const existing = viewed.get(key)
    if (existing) {
      existing.viewCount += 1
      // Events iterate newest-first, so the last one seen is the earliest.
      existing.firstViewedAt = ev.viewedAt
    } else {
      viewed.set(key, {
        owner: ev.owner,
        repo: ev.repo,
        notesRef: ev.notesRef,
        commitSha: ev.commitSha,
        blobSha: ev.blobSha,
        title: titleFor(ev.blobSha),
        noteType: typeFor(ev.blobSha),
        viewCount: 1,
        firstViewedAt: ev.viewedAt,
        lastViewedAt: ev.viewedAt,
        cachedAt: null,
        key,
      })
    }
  }
  viewedEntries = [...viewed.values()]

  // All cached: every commitNotes entry with a real blob, newest cache first.
  cachedEntries = commitNotes
    .filter((cn) => cn.blobSha !== null)
    .map((cn) => {
      const key = commitNoteKey(cn.owner, cn.repo, cn.notesRef, cn.commitSha)
      const views = viewed.get(key)
      return {
        owner: cn.owner,
        repo: cn.repo,
        notesRef: cn.notesRef,
        commitSha: cn.commitSha,
        blobSha: cn.blobSha,
        title: titleFor(cn.blobSha),
        noteType: typeFor(cn.blobSha),
        viewCount: views?.viewCount ?? 0,
        firstViewedAt: views?.firstViewedAt ?? null,
        lastViewedAt: views?.lastViewedAt ?? null,
        cachedAt: cn.cachedAt,
        key,
      }
    })
    .sort((a, b) => (b.cachedAt ?? 0) - (a.cachedAt ?? 0))

  rebuildRepoFilter()
  fetchMissingCommitInfo()
}

/** Request commit subject/time for every entry not yet in commitInfoCache,
 * batched one getCommitInfo message per owner/repo. Each response merges into
 * the cache and re-renders the sidebar once. Failed shas simply stay absent —
 * rows keep the note-title fallback (and may be retried on a later load). */
function fetchMissingCommitInfo(): void {
  const byRepo = new Map<string, { owner: string; repo: string; shas: Set<string> }>()
  for (const entry of [...viewedEntries, ...cachedEntries]) {
    const infoKey = commitInfoKey(entry.owner, entry.repo, entry.commitSha)
    if (commitInfoCache.has(infoKey) || commitInfoPending.has(infoKey)) continue
    commitInfoPending.add(infoKey)
    const repoKey = `${entry.owner}/${entry.repo}`
    let group = byRepo.get(repoKey)
    if (!group) {
      group = { owner: entry.owner, repo: entry.repo, shas: new Set() }
      byRepo.set(repoKey, group)
    }
    group.shas.add(entry.commitSha)
  }

  for (const { owner, repo, shas } of byRepo.values()) {
    void (async () => {
      try {
        const response = await sendToWorker<GetCommitInfoResponse>({
          type: 'getCommitInfo',
          owner,
          repo,
          shas: [...shas],
        })
        if (response.errors?.length) {
          console.debug('gitnotes hub: getCommitInfo reported errors', response.errors)
        }
        for (const [sha, info] of Object.entries(response.commits)) {
          commitInfoCache.set(commitInfoKey(owner, repo, sha), info)
        }
        renderSidebar()
      } catch (err) {
        console.debug('gitnotes hub: getCommitInfo failed', err)
      } finally {
        for (const sha of shas) commitInfoPending.delete(commitInfoKey(owner, repo, sha))
      }
    })()
  }
}

/** Rebuild the repo-filter options from the current library, preserving the
 * selection when the repo name still exists. Grouping is by repo NAME only
 * (case-insensitive) so forks under different owners collapse together. */
function rebuildRepoFilter(): void {
  const repos = new Map<string, { name: string; firstOwner: string; owners: Set<string> }>()
  for (const entry of [...viewedEntries, ...cachedEntries]) {
    const nameKey = entry.repo.toLowerCase()
    const existing = repos.get(nameKey)
    if (existing) {
      existing.owners.add(entry.owner.toLowerCase())
    } else {
      repos.set(nameKey, {
        name: entry.repo,
        firstOwner: entry.owner,
        owners: new Set([entry.owner.toLowerCase()]),
      })
    }
  }

  repoFilterEl.textContent = ''
  const allOption = document.createElement('option')
  allOption.value = ''
  allOption.textContent = 'All repositories'
  repoFilterEl.appendChild(allOption)

  const sorted = [...repos.entries()].sort(([a], [b]) => a.localeCompare(b))
  for (const [nameKey, info] of sorted) {
    const option = document.createElement('option')
    option.value = nameKey
    option.textContent =
      info.owners.size > 1
        ? `${info.name} (${info.owners.size} owners)`
        : `${info.firstOwner}/${info.name}`
    repoFilterEl.appendChild(option)
  }

  if (repoFilter && !repos.has(repoFilter)) repoFilter = ''
  repoFilterEl.value = repoFilter
}

// --- Sidebar rendering -------------------------------------------------------

function matchesSearch(entry: SidebarEntry, query: string): boolean {
  if (!query) return true
  const haystack =
    `${entry.title} ${entry.owner}/${entry.repo} ${entry.notesRef} ${entry.commitSha}`.toLowerCase()
  return haystack.includes(query)
}

function matchesRepoFilter(entry: SidebarEntry): boolean {
  return repoFilter === '' || entry.repo.toLowerCase() === repoFilter
}

function renderEntryRow(entry: SidebarEntry, selectedKey: string | null): HTMLElement {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'entry'
  row.dataset['key'] = entry.key
  if (entry.key === selectedKey) row.classList.add('selected')
  if (entry.viewCount === 0) row.classList.add('never-viewed')

  const info = commitInfoCache.get(
    commitInfoKey(entry.owner, entry.repo, entry.commitSha),
  )

  // Line 1: commit subject; note title until commit info arrives (or when the
  // lookup failed).
  const title = document.createElement('div')
  title.className = 'entry-title'
  title.textContent = info?.subject ? truncate(info.subject, 80) : entry.title
  row.appendChild(title)

  const meta = document.createElement('div')
  meta.className = 'entry-meta'
  const loc = document.createElement('span')
  loc.className = 'entry-loc'
  loc.textContent = `${entry.owner}/${entry.repo}@${shortSha(entry.commitSha)}`
  meta.appendChild(loc)
  const badge = document.createElement('span')
  badge.className = 'ref-badge'
  badge.textContent = shortRef(entry.notesRef)
  meta.appendChild(badge)
  if (entry.noteType !== null) {
    const { label, cls } = typeChipInfo(entry.noteType)
    const typeChip = document.createElement('span')
    typeChip.className = `type-chip ${cls}`
    typeChip.textContent = label
    meta.appendChild(typeChip)
  }
  row.appendChild(meta)

  // Line 3: first-view time + commit time (each an icon+time pair).
  const times = document.createElement('div')
  times.className = 'entry-times'
  if (entry.firstViewedAt !== null) {
    times.appendChild(timePair(EYE_ICON_PATH, entry.firstViewedAt, 'First viewed'))
  } else {
    const never = document.createElement('span')
    never.className = 'entry-never'
    never.textContent = 'never opened'
    times.appendChild(never)
  }
  if (info) {
    times.appendChild(timePair(COMMIT_ICON_PATH, info.committedAt, 'Committed'))
  }
  row.appendChild(times)

  row.addEventListener('click', () => {
    location.hash = routeHash(entry)
  })
  row.addEventListener('contextmenu', (ev) => {
    ev.preventDefault()
    openContextMenu(entry, ev.clientX, ev.clientY)
  })
  return row
}

function renderSidebar(): void {
  entryListEl.textContent = ''
  const query = searchInput.value.trim().toLowerCase()
  const source = activeTab === 'viewed' ? viewedEntries : cachedEntries
  const entries = source.filter(
    (e) => matchesRepoFilter(e) && matchesSearch(e, query),
  )
  const selectedKey = currentRouteKey()

  if (entries.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'list-empty'
    if (query) {
      empty.textContent = 'No notes match your search.'
    } else if (repoFilter !== '') {
      empty.textContent = 'No notes in this repository.'
    } else if (activeTab === 'viewed') {
      empty.textContent = 'No notes viewed yet.'
    } else {
      empty.textContent = 'No cached notes yet.'
    }
    entryListEl.appendChild(empty)
    return
  }

  if (activeTab === 'viewed') {
    let lastLabel: string | null = null
    for (const entry of entries) {
      const label = dayLabel(entry.lastViewedAt ?? 0)
      if (label !== lastLabel) {
        lastLabel = label
        const header = document.createElement('div')
        header.className = 'day-header'
        header.textContent = label
        entryListEl.appendChild(header)
      }
      entryListEl.appendChild(renderEntryRow(entry, selectedKey))
    }
  } else {
    for (const entry of entries) {
      entryListEl.appendChild(renderEntryRow(entry, selectedKey))
    }
  }
}

/** Cheap selection sync (no rebuild, keeps scroll position). */
function updateSelectionHighlight(): void {
  const selectedKey = currentRouteKey()
  for (const row of entryListEl.querySelectorAll<HTMLElement>('.entry')) {
    row.classList.toggle('selected', row.dataset['key'] === selectedKey)
  }
}

function setTab(tab: Tab): void {
  activeTab = tab
  tabViewedBtn.classList.toggle('active', tab === 'viewed')
  tabViewedBtn.setAttribute('aria-selected', String(tab === 'viewed'))
  tabCachedBtn.classList.toggle('active', tab === 'cached')
  tabCachedBtn.setAttribute('aria-selected', String(tab === 'cached'))
  renderSidebar()
}

async function refreshSidebar(): Promise<void> {
  try {
    await loadData()
    renderSidebar()
  } catch (err) {
    console.debug('gitnotes hub: sidebar refresh failed', err)
  }
}

// --- Entry context menu -------------------------------------------------------
//
// One menu at a time, built as trusted static DOM appended to body. Dismissed
// by any outside pointer press, Escape, scroll, another contextmenu, or blur.

/** Tears down the open menu (element + listeners); null = no menu open. */
let closeOpenMenu: (() => void) | null = null

function closeContextMenu(): void {
  if (closeOpenMenu) {
    closeOpenMenu()
    closeOpenMenu = null
  }
}

function openContextMenu(entry: SidebarEntry, x: number, y: number): void {
  closeContextMenu()

  const menu = document.createElement('div')
  menu.className = 'context-menu'
  menu.setAttribute('role', 'menu')

  const item = document.createElement('button')
  item.type = 'button'
  item.className = 'context-menu-item'
  item.setAttribute('role', 'menuitem')
  item.textContent = 'Remove from library'
  item.addEventListener('click', () => {
    closeContextMenu()
    void removeEntry(entry)
  })
  menu.appendChild(item)
  document.body.appendChild(menu)

  // Position at the cursor, clamped into the viewport.
  const rect = menu.getBoundingClientRect()
  menu.style.left = `${Math.max(0, Math.min(x, window.innerWidth - rect.width - 4))}px`
  menu.style.top = `${Math.max(0, Math.min(y, window.innerHeight - rect.height - 4))}px`
  item.focus()

  const controller = new AbortController()
  const opts = { signal: controller.signal, capture: true } as const
  document.addEventListener(
    'pointerdown',
    (ev) => {
      if (ev.target instanceof Node && menu.contains(ev.target)) return
      closeContextMenu()
    },
    opts,
  )
  document.addEventListener(
    'keydown',
    (ev) => {
      if (ev.key !== 'Escape') return
      ev.preventDefault()
      closeContextMenu()
    },
    opts,
  )
  // Capture-phase 'scroll' also catches non-bubbling element scrolls
  // (e.g. #entry-list). Runs before any row contextmenu handler too, so a
  // second right-click closes this menu, then opens the new one.
  document.addEventListener('scroll', closeContextMenu, opts)
  document.addEventListener('contextmenu', closeContextMenu, opts)
  window.addEventListener('blur', closeContextMenu, { signal: controller.signal })

  closeOpenMenu = () => {
    controller.abort()
    menu.remove()
  }
}

/** Remove the note from the local library: view history, cache entry, and the
 * blob when nothing else references it. Local-only — the note reappears if the
 * user browses that commit again. */
async function removeEntry(entry: SidebarEntry): Promise<void> {
  try {
    await deleteViewEventsFor(entry.owner, entry.repo, entry.notesRef, entry.commitSha)
    await deleteCommitNote(entry.owner, entry.repo, entry.notesRef, entry.commitSha)
    // After deleteCommitNote, so the reference count is current.
    if (entry.blobSha) await deleteBlobIfUnreferenced(entry.blobSha)
  } catch (err) {
    console.debug('gitnotes hub: remove from library failed', err)
  }
  if (currentRouteKey() === entry.key) {
    location.hash = '' // existing routing renders the landing state
  }
  await refreshSidebar()
}

// --- Viewer ------------------------------------------------------------------

function showEmptyState(): void {
  viewerSectionEl.hidden = true
  emptyStateEl.hidden = false
  emptyMessageEl.textContent =
    viewedEntries.length === 0 && cachedEntries.length === 0
      ? 'No notes yet — browse GitHub commits with notes and they’ll appear here.'
      : 'Select a note'
}

function showViewerError(message: string): void {
  viewerBodyEl.textContent = ''
  const err = document.createElement('div')
  err.className = 'viewer-error'
  err.textContent = message
  viewerBodyEl.appendChild(err)
}

/** Load the note from the local store; fall back to the service worker. */
async function loadNote(route: HubNoteRoute): Promise<NoteResult | null> {
  try {
    const record = await getCommitNote(
      route.owner,
      route.repo,
      route.notesRef,
      route.commitSha,
    )
    if (record?.blobSha) {
      const blob = await getBlob(record.blobSha)
      if (blob) {
        return {
          notesRef: route.notesRef,
          blobSha: record.blobSha,
          content: blob.content,
          parsed: parseNote(blob.content),
        }
      }
    }
  } catch (err) {
    console.debug('gitnotes hub: local note lookup failed', err)
  }

  // Not cached locally — ask the worker to fetch (it persists to the db too).
  const response = await sendToWorker<GetNotesResponse>({
    type: 'getNotes',
    owner: route.owner,
    repo: route.repo,
    shas: [route.commitSha],
  })
  if (response.errors?.length) {
    console.debug('gitnotes hub: getNotes reported errors', response.errors)
  }
  const results = response.notes[route.commitSha.toLowerCase()] ?? []
  const match = results.find((r) => r.notesRef === route.notesRef) ?? null
  if (match) {
    // The worker just cached it — reflect that in the sidebar.
    void refreshSidebar()
  }
  return match
}

function buildControlBar(route: HubNoteRoute, note: NoteResult): void {
  controlBarEl.textContent = ''

  const title = document.createElement('span')
  title.className = 'control-title'
  title.textContent = deriveTitle(note.content)
  controlBarEl.appendChild(title)

  const link = document.createElement('a')
  link.className = 'control-link'
  link.href = `https://github.com/${encodeURIComponent(route.owner)}/${encodeURIComponent(route.repo)}/commit/${encodeURIComponent(route.commitSha)}`
  link.target = '_blank'
  link.rel = 'noopener noreferrer'
  link.textContent = `${route.owner}/${route.repo} @ ${shortSha(route.commitSha)}`
  controlBarEl.appendChild(link)

  const badge = document.createElement('span')
  badge.className = 'ref-badge'
  badge.textContent = shortRef(route.notesRef)
  controlBarEl.appendChild(badge)

  const spacer = document.createElement('span')
  spacer.className = 'control-spacer'
  controlBarEl.appendChild(spacer)

  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'control-btn'
  copyBtn.textContent = 'Copy raw'
  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(note.content).then(
      () => {
        copyBtn.textContent = 'Copied'
        setTimeout(() => {
          copyBtn.textContent = 'Copy raw'
        }, 1200)
      },
      (err: unknown) => {
        console.debug('gitnotes hub: clipboard write failed', err)
        copyBtn.textContent = 'Copy failed'
        setTimeout(() => {
          copyBtn.textContent = 'Copy raw'
        }, 1200)
      },
    )
  })
  controlBarEl.appendChild(copyBtn)

  const rawBtn = document.createElement('button')
  rawBtn.type = 'button'
  rawBtn.className = 'control-btn'
  rawBtn.textContent = 'Raw'
  rawBtn.setAttribute('aria-pressed', String(rawMode))
  rawBtn.addEventListener('click', () => {
    rawMode = !rawMode
    rawBtn.setAttribute('aria-pressed', String(rawMode))
    renderBody(route, note)
  })
  controlBarEl.appendChild(rawBtn)
}

function renderBody(route: HubNoteRoute, note: NoteResult): void {
  viewerBodyEl.textContent = ''
  sandboxFrame = null // the previous render's iframe (if any) just left the DOM

  if (rawMode) {
    const pre = document.createElement('pre')
    pre.className = 'raw-view'
    pre.textContent = note.content
    viewerBodyEl.appendChild(pre)
    return
  }

  if (note.parsed.kind === 'typed' && note.parsed.envelope.type === 'html') {
    // Dynamic HTML notes only ever run inside the manifest-sandboxed iframe.
    // Always a FRESH iframe — the sandbox one-shots (document.write replaces
    // its message listener).
    const body = note.parsed.envelope.body
    const iframe = document.createElement('iframe')
    iframe.src = 'sandbox.html'
    iframe.addEventListener('load', () => {
      iframe.contentWindow?.postMessage({ type: 'renderHtml', html: body }, '*')
    })
    sandboxFrame = iframe // only this frame's messages are trusted (see init)
    viewerBodyEl.appendChild(iframe)
    return
  }

  viewerBodyEl.appendChild(
    renderNote(note, {
      surface: 'hub',
      owner: route.owner,
      repo: route.repo,
      onDiffLink: (href) => {
        const target = parseDiffTarget(href)
        if (target) navigateDiffTarget(target)
      },
    }),
  )
}

// --- Note/diff split -------------------------------------------------------
//
// Vertical split: note pane on top (flex-basis = ratio), draggable divider,
// diff pane below. Collapsing only hides a pane — the note pane's DOM (and
// its one-shot sandbox iframe) is never destroyed by split interactions.

interface SplitState {
  ratio: number
  noteCollapsed: boolean
  diffCollapsed: boolean
}

function loadSplitState(): void {
  let raw: string | null = null
  try {
    raw = localStorage.getItem(SPLIT_STORAGE_KEY)
  } catch (err) {
    console.debug('gitnotes hub: split state read failed', err)
  }
  if (!raw) return
  try {
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return
    const state = parsed as Partial<Record<keyof SplitState, unknown>>
    const ratio = state.ratio
    if (typeof ratio === 'number' && ratio >= 0.05 && ratio <= 0.95) {
      splitRatio = ratio
    }
    if (typeof state.noteCollapsed === 'boolean') noteCollapsed = state.noteCollapsed
    if (typeof state.diffCollapsed === 'boolean') diffCollapsed = state.diffCollapsed
    // Never restore into a both-collapsed state.
    if (noteCollapsed && diffCollapsed) diffCollapsed = false
  } catch {
    // Corrupt value — keep the defaults silently.
  }
}

function saveSplitState(): void {
  const state: SplitState = { ratio: splitRatio, noteCollapsed, diffCollapsed }
  try {
    localStorage.setItem(SPLIT_STORAGE_KEY, JSON.stringify(state))
  } catch (err) {
    console.debug('gitnotes hub: split state write failed', err)
  }
}

/** Reflect ratio + collapse state into the DOM (classes, flex-basis, ARIA). */
function applySplit(): void {
  viewerSplitEl.classList.toggle('note-collapsed', noteCollapsed)
  viewerSplitEl.classList.toggle('diff-collapsed', diffCollapsed)
  viewerBodyEl.style.flexBasis = `${(splitRatio * 100).toFixed(2)}%`
  splitDividerEl.setAttribute('aria-valuenow', String(Math.round(splitRatio * 100)))

  collapseNoteBtn.textContent = noteCollapsed ? '▾' : '▴'
  const noteLabel = noteCollapsed ? 'Restore note pane' : 'Collapse note pane'
  collapseNoteBtn.setAttribute('aria-label', noteLabel)
  collapseNoteBtn.title = noteLabel
  collapseNoteBtn.setAttribute('aria-expanded', String(!noteCollapsed))

  collapseDiffBtn.textContent = diffCollapsed ? '▴' : '▾'
  const diffLabel = diffCollapsed ? 'Restore diff pane' : 'Collapse diff pane'
  collapseDiffBtn.setAttribute('aria-label', diffLabel)
  collapseDiffBtn.title = diffLabel
  collapseDiffBtn.setAttribute('aria-expanded', String(!diffCollapsed))
}

/** Kick off the (possibly deferred) diff load for the current selection. */
function loadDiffIfNeeded(): void {
  if (viewerSectionEl.hidden || diffCollapsed) return
  const route = parseRoute(location.hash)
  if (route) void showDiff(route)
}

function setPaneCollapsed(pane: 'note' | 'diff', collapsed: boolean): void {
  if (pane === 'note') {
    if (noteCollapsed === collapsed) return
    noteCollapsed = collapsed
    if (collapsed) diffCollapsed = false // never both
  } else {
    if (diffCollapsed === collapsed) return
    diffCollapsed = collapsed
    if (collapsed) noteCollapsed = false // never both
  }
  applySplit()
  saveSplitState()
  loadDiffIfNeeded() // no-op unless the diff pane just became visible
}

/** Clamp the note-pane ratio so neither pane goes under MIN_PANE_PX. */
function clampSplitRatio(ratio: number): number {
  const available = viewerSplitEl.clientHeight - splitDividerEl.offsetHeight
  if (available <= MIN_PANE_PX * 2) return DEFAULT_SPLIT_RATIO
  const min = MIN_PANE_PX / available
  return Math.min(Math.max(ratio, min), 1 - min)
}

function nudgeSplit(delta: number): void {
  const wasDiffCollapsed = diffCollapsed
  noteCollapsed = false
  diffCollapsed = false
  splitRatio = clampSplitRatio(splitRatio + delta)
  applySplit()
  saveSplitState()
  if (wasDiffCollapsed) loadDiffIfNeeded()
}

function resetSplit(): void {
  const wasDiffCollapsed = diffCollapsed
  noteCollapsed = false
  diffCollapsed = false
  splitRatio = DEFAULT_SPLIT_RATIO
  applySplit()
  saveSplitState()
  if (wasDiffCollapsed) loadDiffIfNeeded()
}

function initSplit(): void {
  loadSplitState()
  applySplit()

  collapseNoteBtn.addEventListener('click', () =>
    setPaneCollapsed('note', !noteCollapsed),
  )
  collapseDiffBtn.addEventListener('click', () =>
    setPaneCollapsed('diff', !diffCollapsed),
  )

  /** Active drag pointer, or null. Pointer capture keeps the moves coming;
   * body.split-dragging turns off pointer events on viewer iframes (the
   * html-note sandbox would otherwise swallow pointermove mid-drag). */
  let dragPointerId: number | null = null

  const endDrag = (ev: PointerEvent): void => {
    if (dragPointerId !== ev.pointerId) return
    dragPointerId = null
    document.body.classList.remove('split-dragging')
    saveSplitState()
  }

  splitDividerEl.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0 || dragPointerId !== null) return
    if (ev.target instanceof Element && ev.target.closest('button')) return
    dragPointerId = ev.pointerId
    splitDividerEl.setPointerCapture(ev.pointerId)
    document.body.classList.add('split-dragging')
  })

  splitDividerEl.addEventListener('pointermove', (ev) => {
    if (dragPointerId !== ev.pointerId) return
    const rect = viewerSplitEl.getBoundingClientRect()
    const available = rect.height - splitDividerEl.offsetHeight
    if (available <= MIN_PANE_PX * 2) return
    const noteHeight = ev.clientY - rect.top - splitDividerEl.offsetHeight / 2
    splitRatio = clampSplitRatio(noteHeight / available)
    if (noteCollapsed || diffCollapsed) {
      const wasDiffCollapsed = diffCollapsed
      noteCollapsed = false
      diffCollapsed = false
      applySplit()
      if (wasDiffCollapsed) loadDiffIfNeeded()
    } else {
      applySplit()
    }
  })

  splitDividerEl.addEventListener('pointerup', endDrag)
  splitDividerEl.addEventListener('pointercancel', endDrag)

  splitDividerEl.addEventListener('dblclick', (ev) => {
    if (ev.target instanceof Element && ev.target.closest('button')) return
    resetSplit()
  })

  splitDividerEl.addEventListener('keydown', (ev) => {
    switch (ev.key) {
      case 'ArrowUp':
        nudgeSplit(-0.05)
        break
      case 'ArrowDown':
        nudgeSplit(0.05)
        break
      case 'Home':
        setPaneCollapsed('note', true)
        break
      case 'End':
        setPaneCollapsed('diff', true)
        break
      default:
        return
    }
    ev.preventDefault()
  })
}

// --- Diff viewer ---------------------------------------------------------------
//
// Everything below renders UNTRUSTED repo content (filenames, patch text):
// only createElement/textContent — never innerHTML.

type DiffRowKind = 'hunk' | 'add' | 'del' | 'context' | 'meta'

/** One parsed patch line — shared by the unified and split renderers. */
interface DiffRow {
  kind: DiffRowKind
  /** Line content without the +/-/space marker (full line for hunk/meta). */
  text: string
  oldLine: number | null
  newLine: number | null
}

const HUNK_RE = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/

function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = []
  let oldLine = 0
  let newLine = 0
  const lines = patch.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line === '' && i === lines.length - 1) break // trailing newline
    const hunk = HUNK_RE.exec(line)
    if (hunk) {
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      rows.push({ kind: 'hunk', text: line, oldLine: null, newLine: null })
    } else if (line.startsWith('+')) {
      rows.push({ kind: 'add', text: line.slice(1), oldLine: null, newLine: newLine++ })
    } else if (line.startsWith('-')) {
      rows.push({ kind: 'del', text: line.slice(1), oldLine: oldLine++, newLine: null })
    } else if (line.startsWith('\\')) {
      // "\ No newline at end of file"
      rows.push({ kind: 'meta', text: line, oldLine: null, newLine: null })
    } else {
      // Context (' ' marker; GitHub sometimes emits blank context lines bare).
      rows.push({
        kind: 'context',
        text: line.startsWith(' ') ? line.slice(1) : line,
        oldLine: oldLine++,
        newLine: newLine++,
      })
    }
  }
  return rows
}

// --- Intraline (word-level) highlighting -----------------------------------
//
// When a deleted line pairs with an added line, the char-level common prefix
// and suffix are stripped and the differing middle of each side is wrapped in
// a tint span. One shared pairing pass feeds both the unified and split
// renderers so they always agree.

/** Char range [start, end) of a line to wrap in an intraline span. */
interface IntralineRange {
  start: number
  end: number
}

/** Differing middles of a paired del/add line, or null when the highlight
 * would be noise: either line empty, lines identical, or the differing middle
 * covers more than ~70% of the longer line (whole-line change). */
function intralineRanges(
  del: string,
  add: string,
): { del: IntralineRange; add: IntralineRange } | null {
  if (del.length === 0 || add.length === 0) return null
  const minLen = Math.min(del.length, add.length)
  let prefix = 0
  while (prefix < minLen && del[prefix] === add[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < minLen - prefix &&
    del[del.length - 1 - suffix] === add[add.length - 1 - suffix]
  ) {
    suffix += 1
  }
  const delRange = { start: prefix, end: del.length - suffix }
  const addRange = { start: prefix, end: add.length - suffix }
  const midLen = Math.max(delRange.end - delRange.start, addRange.end - addRange.start)
  if (midLen === 0) return null // identical lines
  if (midLen > Math.max(del.length, add.length) * 0.7) return null
  return { del: delRange, add: addRange }
}

/** Pair each contiguous run of '-' lines with the '+' run that immediately
 * follows it (i-th del against i-th add — the same pairing the split renderer
 * lays out) and record the intraline range for each highlighted row. */
function computeIntralineMap(rows: DiffRow[]): Map<DiffRow, IntralineRange> {
  const map = new Map<DiffRow, IntralineRange>()
  let i = 0
  while (i < rows.length) {
    const row = rows[i]
    if (!row || row.kind !== 'del') {
      i += 1
      continue
    }
    const dels: DiffRow[] = []
    while (i < rows.length) {
      const r = rows[i]
      if (!r || r.kind !== 'del') break
      dels.push(r)
      i += 1
    }
    const adds: DiffRow[] = []
    while (i < rows.length) {
      const r = rows[i]
      if (!r || r.kind !== 'add') break
      adds.push(r)
      i += 1
    }
    const pairs = Math.min(dels.length, adds.length)
    for (let j = 0; j < pairs; j++) {
      const del = dels[j]
      const add = adds[j]
      if (!del || !add) continue
      const ranges = intralineRanges(del.text, add.text)
      if (ranges) {
        map.set(del, ranges.del)
        map.set(add, ranges.add)
      }
    }
  }
  return map
}

/** Fill a code cell with `prefix + text`, wrapping text[range] in a span.
 * Text nodes + one span only — the no-innerHTML rule holds. */
function appendLineText(
  cell: HTMLElement,
  text: string,
  range: IntralineRange | null,
  spanClass: string,
  prefix = '',
): void {
  if (!range || range.end <= range.start) {
    cell.textContent = prefix + text
    return
  }
  const head = prefix + text.slice(0, range.start)
  if (head) cell.appendChild(document.createTextNode(head))
  const span = document.createElement('span')
  span.className = spanClass
  span.textContent = text.slice(range.start, range.end)
  cell.appendChild(span)
  if (range.end < text.length) {
    cell.appendChild(document.createTextNode(text.slice(range.end)))
  }
}

function diffKey(route: HubNoteRoute): string {
  return `${route.owner}/${route.repo}@${route.commitSha}`
}

function diffStatusLine(message: string, className = 'diff-status'): HTMLElement {
  const line = document.createElement('div')
  line.className = className
  line.textContent = message
  return line
}

/** Fetch (or reuse) the diff for the route and render it into #diff-body. */
async function showDiff(route: HubNoteRoute): Promise<void> {
  const key = diffKey(route)
  if (renderedDiffKey === key) return
  renderedDiffKey = key
  const seq = renderSeq

  const cached = diffCache.get(key)
  if (cached) {
    renderDiffPane(cached, route)
    return
  }

  diffBodyEl.textContent = ''
  diffBodyEl.appendChild(diffStatusLine('Loading diff…'))

  let response: GetDiffResponse
  try {
    response = await sendToWorker<GetDiffResponse>({
      type: 'getDiff',
      owner: route.owner,
      repo: route.repo,
      commitSha: route.commitSha,
    })
  } catch (err) {
    console.debug('gitnotes hub: getDiff failed', err)
    if (seq === renderSeq && renderedDiffKey === key) {
      renderedDiffKey = null // allow a retry on the next Diff activation
      diffBodyEl.textContent = ''
      diffBodyEl.appendChild(
        diffStatusLine('Failed to load the diff — see the console for details.'),
      )
    }
    return
  }
  diffCache.set(key, response)
  if (seq !== renderSeq || renderedDiffKey !== key) return // superseded
  renderDiffPane(response, route)
}

function renderDiffPane(response: GetDiffResponse, route: HubNoteRoute): void {
  diffBodyEl.textContent = ''
  resetDiffSearchState() // old marks left with the discarded DOM
  renderedDiffFiles = null
  renderedFilesEl = null

  if (response.errors?.length) {
    for (const message of response.errors) {
      diffBodyEl.appendChild(diffStatusLine(message, 'diff-error'))
    }
  }

  if (response.files.length === 0) {
    if (!response.errors?.length) {
      diffBodyEl.appendChild(diffStatusLine('No changes found for this commit.'))
    }
    completeDiffRender(route)
    return
  }

  // Build the file sections first — the summary toolbar (expand/collapse-all,
  // jump-to-file) targets them directly.
  const filesEl = document.createElement('div')
  filesEl.className = 'diff-files'
  for (const file of response.files) {
    filesEl.appendChild(renderDiffFile(file, route))
  }
  diffBodyEl.appendChild(buildDiffSummary(response, route, filesEl))
  diffBodyEl.appendChild(filesEl)
  renderedDiffFiles = response.files
  renderedFilesEl = filesEl

  // A layout toggle (or any re-render) discards the previous marks — re-apply
  // the active search to the fresh DOM, without stealing the scroll position.
  if (diffSearchQuery) runDiffSearch(diffSearchQuery, 'silent')
  completeDiffRender(route)
}

function buildDiffSummary(
  response: GetDiffResponse,
  route: HubNoteRoute,
  filesEl: HTMLElement,
): HTMLElement {
  const bar = document.createElement('div')
  bar.className = 'diff-summary'

  let additions = 0
  let deletions = 0
  for (const file of response.files) {
    additions += file.additions
    deletions += file.deletions
  }

  const totals = document.createElement('span')
  totals.className = 'diff-totals'
  const count = response.files.length
  totals.textContent = `${count} changed ${count === 1 ? 'file' : 'files'}, `
  totals.appendChild(diffCount('+', additions, 'diff-count-add'))
  totals.appendChild(document.createTextNode(' '))
  totals.appendChild(diffCount('−', deletions, 'diff-count-del'))
  bar.appendChild(totals)

  if (response.truncated) {
    const notice = document.createElement('span')
    notice.className = 'diff-truncated'
    notice.textContent =
      'GitHub caps this listing at 300 files — showing the first 300'
    bar.appendChild(notice)
  }

  const spacer = document.createElement('span')
  spacer.className = 'control-spacer'
  bar.appendChild(spacer)

  bar.appendChild(buildDiffSearchControls())

  // Jump-to-file: option index i targets the i-th section in filesEl (both
  // are built from response.files in order).
  const jump = document.createElement('select')
  jump.className = 'diff-jump'
  jump.setAttribute('aria-label', 'Jump to file')
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = 'Jump to file…'
  jump.appendChild(placeholder)
  response.files.forEach((file, index) => {
    const option = document.createElement('option')
    option.value = String(index)
    option.textContent = truncate(file.filename, 90)
    jump.appendChild(option)
  })
  jump.addEventListener('change', () => {
    const raw = jump.value
    jump.value = '' // reset to the placeholder
    if (raw === '') return
    const section = filesEl.children[Number(raw)]
    if (!(section instanceof HTMLElement)) return
    setSectionCollapsed(section, false)
    section.scrollIntoView({ block: 'start' })
    flashSectionHeader(section)
  })
  bar.appendChild(jump)

  for (const [label, collapsed] of [
    ['Expand all', false],
    ['Collapse all', true],
  ] as const) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'control-btn'
    btn.textContent = label
    btn.addEventListener('click', () => {
      for (const section of filesEl.querySelectorAll<HTMLElement>('.diff-file')) {
        setSectionCollapsed(section, collapsed)
      }
    })
    bar.appendChild(btn)
  }

  for (const layout of ['unified', 'split'] as const) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'control-btn'
    btn.textContent = layout === 'unified' ? 'Unified' : 'Split'
    btn.setAttribute('aria-pressed', String(diffLayout === layout))
    btn.addEventListener('click', () => {
      if (diffLayout === layout) return
      diffLayout = layout
      renderDiffPane(response, route)
    })
    bar.appendChild(btn)
  }

  return bar
}

function diffCount(sign: string, n: number, className: string): HTMLElement {
  const span = document.createElement('span')
  span.className = className
  span.textContent = `${sign}${n}`
  return span
}

// --- Diff search -------------------------------------------------------------
//
// Case-insensitive search across the rendered diff's code text and filenames.
// Matches are wrapped in <mark> by splitting the existing text nodes — never
// innerHTML — so intraline spans (and anything else) survive intact. The query
// outlives re-renders (layout toggles re-apply it); the marks never do.

/** Hard cap on wrapped matches — keeps huge diffs responsive. */
const DIFF_SEARCH_MAX = 500
const DIFF_SEARCH_DEBOUNCE_MS = 200

let diffSearchQuery = ''
/** All current <mark class="diff-match"> elements, in document order. */
let diffSearchMarks: HTMLElement[] = []
/** Index of the current match in diffSearchMarks; -1 = none. */
let diffSearchIndex = -1
/** True when the match cap was hit — the count shows "+more". */
let diffSearchTruncated = false
/** Count element of the currently rendered summary bar (rebuilt per render). */
let diffSearchCountEl: HTMLElement | null = null
let diffSearchDebounce: ReturnType<typeof setTimeout> | undefined

/** Forget mark references without touching the DOM — for when the rendered
 * diff DOM has just been (or is about to be) discarded wholesale. */
function resetDiffSearchState(): void {
  diffSearchMarks = []
  diffSearchIndex = -1
  diffSearchTruncated = false
}

/** Unwrap every mark in the live DOM (replace with its text, then normalize
 * parents so future searches see contiguous text nodes). */
function clearDiffSearchMarks(): void {
  const parents = new Set<Node>()
  for (const mark of diffSearchMarks) {
    const parent = mark.parentNode
    if (!parent) continue
    parent.replaceChild(document.createTextNode(mark.textContent ?? ''), mark)
    parents.add(parent)
  }
  for (const parent of parents) parent.normalize()
  resetDiffSearchState()
}

function updateDiffSearchCount(): void {
  if (!diffSearchCountEl || !diffSearchCountEl.isConnected) return
  if (!diffSearchQuery) {
    diffSearchCountEl.textContent = ''
    return
  }
  const total = `${diffSearchMarks.length}${diffSearchTruncated ? '+' : ''}`
  const current = diffSearchMarks.length === 0 ? 0 : diffSearchIndex + 1
  diffSearchCountEl.textContent = `${current}/${total}`
}

/** How to reveal a newly current match:
 * 'navigate' — expand its collapsed section and scroll to it (Prev/Next);
 * 'typing'   — scroll only when already visible (never expands on keystrokes);
 * 'silent'   — mark it current but do not move the viewport (re-renders). */
type DiffSearchReveal = 'navigate' | 'typing' | 'silent'

function setDiffSearchCurrent(index: number, reveal: DiffSearchReveal): void {
  if (diffSearchIndex >= 0) {
    diffSearchMarks[diffSearchIndex]?.classList.remove('diff-match-current')
  }
  diffSearchIndex = index
  const mark = diffSearchMarks[index]
  if (mark) {
    mark.classList.add('diff-match-current')
    const section = mark.closest<HTMLElement>('.diff-file')
    const collapsed = section?.classList.contains('collapsed') ?? false
    if (reveal === 'navigate') {
      if (section && collapsed) setSectionCollapsed(section, false)
      mark.scrollIntoView({ block: 'center', inline: 'nearest' })
    } else if (reveal === 'typing' && !collapsed) {
      mark.scrollIntoView({ block: 'center', inline: 'nearest' })
    }
  }
  updateDiffSearchCount()
}

function navigateDiffSearch(delta: number): void {
  const total = diffSearchMarks.length
  if (total === 0) return
  setDiffSearchCurrent((diffSearchIndex + delta + total) % total, 'navigate')
}

/** Run (or clear, for '') the search against the currently rendered diff.
 * One text-node pass per target element; matches never span node boundaries
 * (by design — this is what preserves the intraline spans). */
function runDiffSearch(query: string, reveal: DiffSearchReveal): void {
  clearDiffSearchMarks()
  diffSearchQuery = query
  if (!query) {
    updateDiffSearchCount()
    return
  }

  const needle = query.toLowerCase()
  const targets = diffBodyEl.querySelectorAll<HTMLElement>(
    '.diff-filename, .diff-code',
  )
  const marks: HTMLElement[] = []
  outer: for (const target of targets) {
    // Snapshot the text nodes first — wrapping mutates the tree under us.
    const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT)
    const textNodes: Text[] = []
    for (let n = walker.nextNode(); n !== null; n = walker.nextNode()) {
      textNodes.push(n as Text)
    }
    for (const node of textNodes) {
      const text = node.data
      const lower = text.toLowerCase()
      let from = lower.indexOf(needle)
      if (from === -1) continue
      const frag = document.createDocumentFragment()
      let cursor = 0
      while (from !== -1 && marks.length < DIFF_SEARCH_MAX) {
        if (from > cursor) {
          frag.appendChild(document.createTextNode(text.slice(cursor, from)))
        }
        const mark = document.createElement('mark')
        mark.className = 'diff-match'
        mark.textContent = text.slice(from, from + needle.length)
        frag.appendChild(mark)
        marks.push(mark)
        cursor = from + needle.length
        from = lower.indexOf(needle, cursor)
      }
      if (cursor < text.length) {
        frag.appendChild(document.createTextNode(text.slice(cursor)))
      }
      node.replaceWith(frag)
      if (marks.length >= DIFF_SEARCH_MAX) {
        diffSearchTruncated = true
        break outer
      }
    }
  }

  diffSearchMarks = marks
  if (marks.length > 0) {
    setDiffSearchCurrent(0, reveal)
  } else {
    updateDiffSearchCount()
  }
}

/** Search input + n/m count + Prev/Next, rebuilt with each summary bar. */
function buildDiffSearchControls(): HTMLElement {
  const group = document.createElement('span')
  group.className = 'diff-search'

  const input = document.createElement('input')
  input.type = 'search'
  input.className = 'diff-search-input'
  input.placeholder = 'Search diff…'
  input.autocomplete = 'off'
  input.spellcheck = false
  input.setAttribute('aria-label', 'Search diff')
  input.value = diffSearchQuery
  group.appendChild(input)

  const runFromInput = (reveal: DiffSearchReveal): void => {
    clearTimeout(diffSearchDebounce)
    runDiffSearch(input.value, reveal)
  }

  input.addEventListener('input', () => {
    clearTimeout(diffSearchDebounce)
    diffSearchDebounce = setTimeout(() => {
      runDiffSearch(input.value, 'typing')
    }, DIFF_SEARCH_DEBOUNCE_MS)
  })
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault()
      if (input.value !== diffSearchQuery) {
        // Debounce still pending — search the latest text instead of stepping.
        runFromInput('navigate')
      } else {
        navigateDiffSearch(ev.shiftKey ? -1 : 1)
      }
    } else if (ev.key === 'Escape') {
      ev.preventDefault()
      input.value = ''
      runFromInput('silent')
    }
  })

  const count = document.createElement('span')
  count.className = 'diff-search-count'
  count.setAttribute('aria-live', 'polite')
  group.appendChild(count)
  diffSearchCountEl = count
  updateDiffSearchCount()

  for (const [label, delta] of [
    ['Prev', -1],
    ['Next', 1],
  ] as const) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'control-btn diff-search-btn'
    btn.textContent = label
    btn.setAttribute('aria-label', `${label === 'Prev' ? 'Previous' : 'Next'} match`)
    btn.addEventListener('click', () => navigateDiffSearch(delta))
    group.appendChild(btn)
  }

  return group
}

function diffChipClass(status: string): string {
  switch (status) {
    case 'added':
      return 'diff-chip-add'
    case 'removed':
      return 'diff-chip-del'
    case 'modified':
    case 'changed':
      return 'diff-chip-mod'
    case 'renamed':
      return 'diff-chip-ren'
    case 'copied':
      return 'diff-chip-copy'
    default:
      return 'diff-chip-neutral'
  }
}

/** GitHub-style 5-square stat bar, proportionally green/red/neutral. */
function buildStatBar(additions: number, deletions: number): HTMLElement {
  const barEl = document.createElement('span')
  barEl.className = 'diff-statbar'
  barEl.setAttribute('aria-hidden', 'true')
  const total = additions + deletions
  let green = 0
  let red = 0
  if (total > 0) {
    green = Math.round((additions / total) * 5)
    red = Math.round((deletions / total) * 5)
    if (additions > 0 && green === 0) green = 1
    if (deletions > 0 && red === 0) red = 1
    while (green + red > 5) {
      if (green >= red) green -= 1
      else red -= 1
    }
  }
  for (let i = 0; i < 5; i++) {
    const square = document.createElement('span')
    square.className =
      i < green
        ? 'stat-square stat-add'
        : i < green + red
          ? 'stat-square stat-del'
          : 'stat-square stat-neutral'
    barEl.appendChild(square)
  }
  return barEl
}

/** SHA-256 hex digest — GitHub's commit-page anchors are `#diff-<sha256(path)>`. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Link target for a diff file header: the file as it exists at this commit.
 * Removed files have no blob at the commit, so they link to the file's diff
 * anchor on the GitHub commit page instead (anchor filled in async). */
function fileLinkHref(file: DiffFile, route: HubNoteRoute, a: HTMLAnchorElement): void {
  const repoUrl = `https://github.com/${route.owner}/${route.repo}`
  if (file.status === 'removed') {
    a.href = `${repoUrl}/commit/${route.commitSha}`
    void sha256Hex(file.filename).then((hex) => {
      a.href = `${repoUrl}/commit/${route.commitSha}#diff-${hex}`
    })
    return
  }
  const path = file.filename.split('/').map(encodeURIComponent).join('/')
  a.href = `${repoUrl}/blob/${route.commitSha}/${path}`
}

/** Single source of truth for a file section's collapsed state — used by the
 * per-file chevron, the toolbar expand/collapse-all, jump-to-file, and search
 * navigation, so all of them stay consistent. */
function setSectionCollapsed(section: HTMLElement, collapsed: boolean): void {
  const body = section.querySelector<HTMLElement>('.diff-file-body')
  const chevron = section.querySelector<HTMLButtonElement>('.diff-chevron')
  if (!body || !chevron) return
  section.classList.toggle('collapsed', collapsed)
  body.hidden = collapsed
  chevron.textContent = collapsed ? '▸' : '▾'
  chevron.setAttribute('aria-expanded', String(!collapsed))
}

function renderDiffFile(file: DiffFile, route: HubNoteRoute): HTMLElement {
  const section = document.createElement('section')
  section.className = 'diff-file'

  const header = document.createElement('div')
  header.className = 'diff-file-header'

  const chevron = document.createElement('button')
  chevron.type = 'button'
  chevron.className = 'diff-chevron'
  chevron.textContent = '▾'
  chevron.setAttribute('aria-expanded', 'true')
  chevron.setAttribute('aria-label', `Toggle diff for ${file.filename}`)
  header.appendChild(chevron)

  const chip = document.createElement('span')
  chip.className = `diff-chip ${diffChipClass(file.status)}`
  chip.textContent = file.status
  header.appendChild(chip)

  const name = document.createElement('a')
  name.className = 'diff-filename'
  name.textContent = file.previousFilename
    ? `${file.previousFilename} → ${file.filename}`
    : file.filename
  name.title = `${file.filename} — view at this commit on GitHub`
  name.target = '_blank'
  name.rel = 'noopener noreferrer'
  fileLinkHref(file, route, name)
  header.appendChild(name)

  const spacer = document.createElement('span')
  spacer.className = 'control-spacer'
  header.appendChild(spacer)

  const counts = document.createElement('span')
  counts.className = 'diff-counts'
  counts.appendChild(diffCount('+', file.additions, 'diff-count-add'))
  counts.appendChild(document.createTextNode(' '))
  counts.appendChild(diffCount('−', file.deletions, 'diff-count-del'))
  header.appendChild(counts)

  header.appendChild(buildStatBar(file.additions, file.deletions))
  section.appendChild(header)

  const body = document.createElement('div')
  body.className = 'diff-file-body'
  if (file.patch === undefined) {
    body.appendChild(diffStatusLine('No preview available', 'diff-nopreview'))
  } else {
    const rows = parsePatch(file.patch)
    body.appendChild(
      diffLayout === 'split' ? renderSplitRows(rows) : renderUnifiedRows(rows),
    )
  }
  section.appendChild(body)

  chevron.addEventListener('click', () => {
    setSectionCollapsed(section, !section.classList.contains('collapsed'))
  })

  return section
}

function fullWidthRow(row: DiffRow, colSpan: number): HTMLTableRowElement {
  const tr = document.createElement('tr')
  const cell = document.createElement('td')
  cell.colSpan = colSpan
  cell.className = `diff-cell-full diff-${row.kind}`
  cell.textContent = row.text
  tr.appendChild(cell)
  return tr
}

function gutterCell(line: number | null, kind: DiffRowKind): HTMLTableCellElement {
  const cell = document.createElement('td')
  cell.className = `diff-gutter diff-g-${kind}`
  cell.textContent = line === null ? '' : String(line)
  return cell
}

function renderUnifiedRows(rows: DiffRow[]): HTMLElement {
  const intraline = computeIntralineMap(rows)
  const table = document.createElement('table')
  table.className = 'diff-table'
  const tbody = document.createElement('tbody')
  for (const row of rows) {
    if (row.kind === 'hunk' || row.kind === 'meta') {
      tbody.appendChild(fullWidthRow(row, 3))
      continue
    }
    const tr = document.createElement('tr')
    tr.appendChild(gutterCell(row.oldLine, row.kind))
    tr.appendChild(gutterCell(row.newLine, row.kind))
    const code = document.createElement('td')
    code.className = `diff-code diff-${row.kind}`
    const marker = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '
    appendLineText(
      code,
      row.text,
      intraline.get(row) ?? null,
      row.kind === 'del' ? 'intraline-del' : 'intraline-add',
      marker,
    )
    tr.appendChild(code)
    tbody.appendChild(tr)
  }
  table.appendChild(tbody)
  return table
}

/** One half of a split row; null renders as an empty side. */
function appendSplitSide(
  tr: HTMLTableRowElement,
  row: DiffRow | null,
  side: 'old' | 'new',
  intraline: Map<DiffRow, IntralineRange>,
): void {
  const gutter = document.createElement('td')
  const code = document.createElement('td')
  if (row === null) {
    gutter.className = 'diff-gutter diff-g-empty'
    code.className = 'diff-code diff-empty'
  } else {
    gutter.className = `diff-gutter diff-g-${row.kind}`
    code.className = `diff-code diff-${row.kind}`
    const line = side === 'old' ? row.oldLine : row.newLine
    gutter.textContent = line === null ? '' : String(line)
    appendLineText(
      code,
      row.text,
      intraline.get(row) ?? null,
      row.kind === 'del' ? 'intraline-del' : 'intraline-add',
    )
  }
  tr.appendChild(gutter)
  tr.appendChild(code)
}

function renderSplitRows(rows: DiffRow[]): HTMLElement {
  const intraline = computeIntralineMap(rows)
  const table = document.createElement('table')
  table.className = 'diff-table diff-table-split'
  const tbody = document.createElement('tbody')

  const emitPair = (left: DiffRow | null, right: DiffRow | null): void => {
    const tr = document.createElement('tr')
    appendSplitSide(tr, left, 'old', intraline)
    appendSplitSide(tr, right, 'new', intraline)
    tbody.appendChild(tr)
  }

  let i = 0
  while (i < rows.length) {
    const row = rows[i]
    if (!row) break
    if (row.kind === 'hunk' || row.kind === 'meta') {
      tbody.appendChild(fullWidthRow(row, 4))
      i += 1
      continue
    }
    if (row.kind === 'context') {
      emitPair(row, row)
      i += 1
      continue
    }
    // Classic pairing: a run of deletions against the run of additions that
    // follows it, row by row; leftovers get an empty opposite side.
    const dels: DiffRow[] = []
    const adds: DiffRow[] = []
    while (i < rows.length) {
      const r = rows[i]
      if (!r || r.kind !== 'del') break
      dels.push(r)
      i += 1
    }
    while (i < rows.length) {
      const r = rows[i]
      if (!r || r.kind !== 'add') break
      adds.push(r)
      i += 1
    }
    const span = Math.max(dels.length, adds.length)
    for (let j = 0; j < span; j++) {
      emitPair(dels[j] ?? null, adds[j] ?? null)
    }
  }

  table.appendChild(tbody)
  return table
}

// --- Diff-target navigation (gitnotes:diff/ links) ---------------------------
//
// Notes may deep-link into the diff pane: `gitnotes:diff/<path>[#R29[-R40]]`.
// Targets arrive from three untrusted sources — markdown notes (onDiffLink),
// the html-note sandbox (postMessage, see init), and the openHub deep-link
// URL — all funneled through parseDiffTarget + navigateDiffTarget. Row lookup
// walks the rendered gutter cells (both layouts carry them), so search marks
// and intraline spans inside code cells never interfere.

/** Parsed `gitnotes:diff/...` link. side/line/endLine come from the fragment;
 * a bare line number means the new ('R') side. */
interface DiffTarget {
  path: string
  side?: 'L' | 'R'
  line?: number
  endLine?: number
}

const DIFF_LINK_PREFIX = 'gitnotes:diff/'
/** Fragment grammar: `<side><n>` or `<side><n>-<side><m>`; side omitted = R.
 * The range's side comes from the first endpoint — the second's is tolerated
 * but ignored. */
const DIFF_FRAGMENT_RE = /^([LlRr]?)(\d+)(?:-[LlRr]?(\d+))?$/

/** Queued navigation applied right after the current selection's diff renders.
 * One-shot: cleared on apply and on selection change — a later re-render
 * (e.g. a layout toggle) never replays it. */
let pendingDiffTarget: DiffTarget | null = null
/** diffKey whose response has fully rendered into #diff-body; null = none. */
let renderedDiffDoneKey: string | null = null
/** Files + section container of the rendered diff (index-aligned with
 * `.diff-file` sections); null while nothing is rendered. */
let renderedDiffFiles: DiffFile[] | null = null
let renderedFilesEl: HTMLElement | null = null
/** Sandbox iframe of the current html-note render — only messages whose
 * event.source is its contentWindow are accepted (see init). */
let sandboxFrame: HTMLIFrameElement | null = null

/** Parse a gitnotes:diff/ href per the grammar. Malformed → debug log + null. */
function parseDiffTarget(href: string): DiffTarget | null {
  if (!href.toLowerCase().startsWith(DIFF_LINK_PREFIX)) {
    console.debug('gitnotes hub: unsupported gitnotes link', href)
    return null
  }
  const rest = href.slice(DIFF_LINK_PREFIX.length)
  const hashAt = rest.indexOf('#')
  const rawPath = hashAt === -1 ? rest : rest.slice(0, hashAt)
  const fragment = hashAt === -1 ? null : rest.slice(hashAt + 1)
  let path = rawPath
  try {
    path = decodeURIComponent(rawPath)
  } catch {
    // Tolerated — treat the path as literal.
  }
  if (!path) {
    console.debug('gitnotes hub: diff link has no file path', href)
    return null
  }
  if (fragment === null) return { path }
  const m = DIFF_FRAGMENT_RE.exec(fragment)
  if (!m) {
    console.debug('gitnotes hub: malformed diff link fragment', href)
    return null
  }
  const side: 'L' | 'R' = m[1]?.toUpperCase() === 'L' ? 'L' : 'R'
  const target: DiffTarget = { path, side, line: Number(m[2]) }
  if (m[3] !== undefined) target.endLine = Number(m[3])
  return target
}

/** Navigate the diff pane to a parsed target: expand the pane if collapsed,
 * and either apply now (diff rendered) or queue until renderDiffPane runs. */
function navigateDiffTarget(target: DiffTarget): void {
  if (diffCollapsed) setPaneCollapsed('diff', false) // also kicks off the load
  const route = parseRoute(location.hash)
  if (!route) {
    console.debug('gitnotes hub: diff link ignored — no note selected')
    return
  }
  if (renderedDiffDoneKey !== diffKey(route)) {
    pendingDiffTarget = target
    loadDiffIfNeeded() // no-op when the load is already in flight
    return
  }
  applyDiffTarget(target)
}

/** renderDiffPane epilogue: mark the diff rendered and flush the queue. */
function completeDiffRender(route: HubNoteRoute): void {
  renderedDiffDoneKey = diffKey(route)
  if (pendingDiffTarget) {
    const target = pendingDiffTarget
    pendingDiffTarget = null
    applyDiffTarget(target)
  }
}

/** Locate the file section for a target path: exact filename, then exact
 * previousFilename, then unique '/'-suffix match; ambiguous → null. */
function findDiffSection(path: string): HTMLElement | null {
  const files = renderedDiffFiles
  const filesEl = renderedFilesEl
  if (!files || !filesEl) return null
  let index = files.findIndex((f) => f.filename === path)
  if (index === -1) index = files.findIndex((f) => f.previousFilename === path)
  if (index === -1) {
    const suffix = `/${path}`
    const matches: number[] = []
    files.forEach((f, i) => {
      if (f.filename.endsWith(suffix)) matches.push(i)
    })
    if (matches.length !== 1) return null
    index = matches[0] ?? -1
  }
  if (index === -1) return null
  const section = filesEl.children[index]
  return section instanceof HTMLElement ? section : null
}

/** Brief header pulse — shared by jump-to-file and diff-link navigation. */
function flashSectionHeader(section: HTMLElement): void {
  const header = section.querySelector<HTMLElement>('.diff-file-header')
  if (!header) return
  header.classList.add('jump-flash')
  setTimeout(() => header.classList.remove('jump-flash'), 1300)
}

/** Rows whose gutter number on the requested side falls within [start, end].
 * Both layouts render each data row's gutter cells in (old, new) DOM order —
 * L reads the first, R the second; hunk/meta full-width rows have none. */
function findTargetRows(
  section: HTMLElement,
  side: 'L' | 'R',
  start: number,
  end: number,
): HTMLTableRowElement[] {
  const rows: HTMLTableRowElement[] = []
  const trs = section.querySelectorAll<HTMLTableRowElement>('.diff-file-body tr')
  for (const tr of trs) {
    const gutters = tr.querySelectorAll<HTMLTableCellElement>('td.diff-gutter')
    if (gutters.length < 2) continue
    const cell = side === 'L' ? gutters[0] : gutters[1]
    const text = cell?.textContent?.trim() ?? ''
    if (!/^\d+$/.test(text)) continue // empty side of a split row, etc.
    const line = Number(text)
    if (line >= start && line <= end) rows.push(tr)
  }
  return rows
}

function clearDiffTargetRows(): void {
  for (const row of diffBodyEl.querySelectorAll('.diff-target-row')) {
    row.classList.remove('diff-target-row')
  }
}

/** Apply a parsed target to the rendered diff: expand + scroll the file
 * section; with a line/range, highlight the matching rows and scroll to the
 * first. Missing file or out-of-hunk lines degrade gracefully (debug log). */
function applyDiffTarget(target: DiffTarget): void {
  clearDiffTargetRows()
  const section = findDiffSection(target.path)
  if (!section) {
    console.debug('gitnotes hub: diff link file not found or ambiguous', target.path)
    return
  }
  setSectionCollapsed(section, false)
  if (target.line === undefined) {
    section.scrollIntoView({ block: 'start' })
    flashSectionHeader(section)
    return
  }
  let start = target.line
  let end = target.endLine ?? target.line
  if (end < start) [start, end] = [end, start]
  const rows = findTargetRows(section, target.side ?? 'R', start, end)
  if (rows.length === 0) {
    // Line outside the diff's hunks — fall back to the file position.
    section.scrollIntoView({ block: 'start' })
    flashSectionHeader(section)
    console.debug('gitnotes hub: diff link line not in the diff', target)
    return
  }
  // Force a style flush so re-navigating to the same rows restarts the pulse.
  void section.offsetWidth
  for (const row of rows) row.classList.add('diff-target-row')
  rows[0]?.scrollIntoView({ block: 'center', inline: 'nearest' })
}

async function recordViewOnce(route: HubNoteRoute, note: NoteResult): Promise<void> {
  const key = routeKey(route)
  if (recordedKey === key) return
  recordedKey = key
  try {
    await sendToWorker<RecordViewResponse>({
      type: 'recordView',
      owner: route.owner,
      repo: route.repo,
      notesRef: route.notesRef,
      commitSha: route.commitSha,
      blobSha: note.blobSha,
      surface: 'hub',
    })
    await refreshSidebar()
  } catch (err) {
    console.debug('gitnotes hub: recordView failed', err)
  }
}

async function renderRoute(): Promise<void> {
  const seq = ++renderSeq
  const route = parseRoute(location.hash)
  updateSelectionHighlight()

  if (!route) {
    showEmptyState()
    return
  }

  emptyStateEl.hidden = true
  viewerSectionEl.hidden = false
  rawMode = false
  renderedDiffKey = null
  renderedDiffDoneKey = null
  renderedDiffFiles = null
  renderedFilesEl = null
  pendingDiffTarget = null // queued navigation dies with its selection
  diffBodyEl.textContent = ''
  resetDiffSearchState() // marks left with the discarded diff DOM
  controlBarEl.textContent = ''
  applySplit()
  showViewerError('Loading…')

  try {
    const note = await loadNote(route)
    if (seq !== renderSeq) return // superseded by a newer navigation
    if (!note) {
      showViewerError(
        `No note found for ${route.owner}/${route.repo}@${shortSha(route.commitSha)} on ${route.notesRef}.`,
      )
      return
    }
    buildControlBar(route, note)
    renderBody(route, note)
    void recordViewOnce(route, note)
    // Diff loads with the selection unless its pane is collapsed — then the
    // fetch is deferred until the pane is first expanded for this selection.
    if (!diffCollapsed) void showDiff(route)
    // Deep link (#/note/.../diff/{encoded href}): navigate once the note is
    // up — typically queues via pendingDiffTarget until the diff renders.
    const diffHref = routeDiffHref(location.hash)
    if (diffHref) {
      const target = parseDiffTarget(diffHref)
      if (target) navigateDiffTarget(target)
    }
  } catch (err) {
    console.debug('gitnotes hub: failed to render note', err)
    if (seq === renderSeq) {
      showViewerError('Failed to load this note — see the console for details.')
    }
  }
}

// --- Init ---------------------------------------------------------------------

function init(): void {
  initSplit()
  tabViewedBtn.addEventListener('click', () => setTab('viewed'))
  tabCachedBtn.addEventListener('click', () => setTab('cached'))
  searchInput.addEventListener('input', () => renderSidebar())
  repoFilterEl.addEventListener('change', () => {
    repoFilter = repoFilterEl.value
    renderSidebar()
  })
  window.addEventListener('hashchange', () => {
    void renderRoute()
  })

  // Link clicks forwarded by the html-note sandbox. Trust boundary: only the
  // iframe this hub created for the current selection may speak, and every
  // field is treated as an untrusted string (parsed/validated, never rendered).
  window.addEventListener('message', (event: MessageEvent) => {
    if (!sandboxFrame?.contentWindow || event.source !== sandboxFrame.contentWindow) {
      return
    }
    const data: unknown = event.data
    if (typeof data !== 'object' || data === null) return
    const msg = data as { type?: unknown; href?: unknown }
    if (typeof msg.href !== 'string') return
    if (msg.type === 'gitnotesLink') {
      const target = parseDiffTarget(msg.href)
      if (target) navigateDiffTarget(target)
    } else if (msg.type === 'gitnotesExternalLink') {
      if (msg.href.startsWith('http://') || msg.href.startsWith('https://')) {
        window.open(msg.href, '_blank', 'noopener')
      } else {
        console.debug('gitnotes hub: blocked non-http external link', msg.href)
      }
    }
  })

  void (async () => {
    try {
      await loadData()
    } catch (err) {
      console.debug('gitnotes hub: initial data load failed', err)
    }
    renderSidebar()
    await renderRoute()
  })()
}

init()
