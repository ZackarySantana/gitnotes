// MV3 service worker: owns all GitHub API calls, caching, and coalescing.

import {
  discoverNotesRefs,
  expandSha,
  fetchCommitDiff,
  fetchCommitInfo,
  fetchNote,
  resolveNotesTree,
  RateLimitError,
} from '../lib/github-api'
import {
  addViewEvent,
  getBlob,
  getCommitInfo,
  getCommitNote,
  getRepoRefs,
  putBlob,
  putCommitInfo,
  putCommitNote,
  putRepoRefs,
  repoRefsKey,
  type RepoRefInfo,
} from '../lib/db'
import { parseNote } from '../lib/envelope'
import { loadSettings } from '../lib/types'
import type {
  CommitInfo,
  GetCommitInfoResponse,
  GetDiffResponse,
  GetNotesResponse,
  NoteResult,
  RecordViewResponse,
  WorkerRequest,
} from '../lib/types'

const REFS_TTL_MS = 5 * 60 * 1000
const RATE_LIMIT_MESSAGE =
  'GitHub API rate limit exceeded — add a token in the extension options for 5000 req/hr'
const FULL_SHA_RE = /^[0-9a-f]{40}$/i

/** Coalesce concurrent identical in-flight ref discovery per repo. */
const inFlightRefs = new Map<string, Promise<RepoRefInfo[]>>()

/** Notes refs for a repo: fresh cache, else discover + resolve + store. */
async function getRepoNotesRefs(
  owner: string,
  repo: string,
  token?: string,
): Promise<RepoRefInfo[]> {
  const cached = await getRepoRefs(owner, repo)
  if (cached && Date.now() - cached.cachedAt < REFS_TTL_MS) return cached.refs

  const key = repoRefsKey(owner, repo)
  let pending = inFlightRefs.get(key)
  if (!pending) {
    pending = discoverAndStoreRefs(owner, repo, token).finally(() => {
      inFlightRefs.delete(key)
    })
    inFlightRefs.set(key, pending)
  }
  return pending
}

async function discoverAndStoreRefs(
  owner: string,
  repo: string,
  token?: string,
): Promise<RepoRefInfo[]> {
  const discovered = await discoverNotesRefs(owner, repo, token)
  const refs: RepoRefInfo[] = []
  for (const { ref, tipSha } of discovered) {
    const { treeSha, fanouts } = await resolveNotesTree(owner, repo, tipSha, token)
    refs.push({ ref, tipSha, treeSha, fanouts })
  }
  // Zero notes refs is cached too, so such repos answer instantly.
  await putRepoRefs({ owner, repo, refs, cachedAt: Date.now() })
  return refs
}

function makeNoteResult(notesRef: string, blobSha: string, content: string): NoteResult {
  return { notesRef, blobSha, content, parsed: parseNote(content) }
}

/** One (ref, commit) lookup: valid cache entry, else fetch + cache. */
async function lookupNote(
  owner: string,
  repo: string,
  ref: RepoRefInfo,
  commitSha: string,
  token?: string,
): Promise<NoteResult | null> {
  const cached = await getCommitNote(owner, repo, ref.ref, commitSha)
  if (cached && cached.tipSha === ref.tipSha) {
    if (cached.blobSha === null) return null // known no-note
    const blob = await getBlob(cached.blobSha)
    if (blob) return makeNoteResult(ref.ref, cached.blobSha, blob.content)
    // Blob record missing — fall through and re-fetch.
  }

  const fetched = await fetchNote(owner, repo, ref.ref, ref.fanouts, commitSha, token)
  const now = Date.now()
  if (fetched) {
    await putBlob({
      blobSha: fetched.blobSha,
      content: fetched.content,
      size: new TextEncoder().encode(fetched.content).length,
      fetchedAt: now,
    })
  }
  await putCommitNote({
    owner,
    repo,
    notesRef: ref.ref,
    commitSha,
    blobSha: fetched ? fetched.blobSha : null,
    tipSha: ref.tipSha,
    cachedAt: now,
  })
  return fetched ? makeNoteResult(ref.ref, fetched.blobSha, fetched.content) : null
}

async function handleGetNotes(
  msg: Extract<WorkerRequest, { type: 'getNotes' }>,
): Promise<GetNotesResponse> {
  const notes: Record<string, NoteResult[]> = {}
  const errors: string[] = []

  // Already-full SHAs are guaranteed a key in the response even if we bail early.
  for (const sha of msg.shas) {
    if (FULL_SHA_RE.test(sha)) notes[sha.toLowerCase()] = []
  }

  try {
    const settings = await loadSettings()
    const token = settings.githubToken
    const refs = await getRepoNotesRefs(msg.owner, msg.repo, token)

    for (const sha of msg.shas) {
      const fullSha = (await expandSha(msg.owner, msg.repo, sha.toLowerCase(), token)).toLowerCase()
      const results = (notes[fullSha] ??= [])
      for (const ref of refs) {
        const note = await lookupNote(msg.owner, msg.repo, ref, fullSha, token)
        if (note) results.push(note)
      }
    }
  } catch (err) {
    if (err instanceof RateLimitError) {
      // Stop fetching; return what we have so far.
      errors.push(RATE_LIMIT_MESSAGE)
    } else {
      errors.push(err instanceof Error ? err.message : String(err))
    }
  }

  return errors.length > 0 ? { notes, errors } : { notes }
}

async function handleRecordView(
  msg: Extract<WorkerRequest, { type: 'recordView' }>,
): Promise<RecordViewResponse> {
  await addViewEvent({
    owner: msg.owner,
    repo: msg.repo,
    notesRef: msg.notesRef,
    commitSha: msg.commitSha,
    blobSha: msg.blobSha,
    viewedAt: Date.now(),
    surface: msg.surface,
  })
  return { ok: true }
}

async function handleOpenHub(
  msg: Extract<WorkerRequest, { type: 'openHub' }>,
): Promise<RecordViewResponse> {
  let url = chrome.runtime.getURL('hub.html')
  if (msg.route) {
    const { owner, repo, notesRef, commitSha } = msg.route
    url += `#/note/${owner}/${repo}/${encodeURIComponent(notesRef)}/${commitSha}`
    if (msg.diffTarget) url += `/diff/${encodeURIComponent(msg.diffTarget)}`
  }
  await chrome.tabs.create({ url })
  return { ok: true }
}

async function handleGetDiff(
  msg: Extract<WorkerRequest, { type: 'getDiff' }>,
): Promise<GetDiffResponse> {
  const settings = await loadSettings()
  try {
    const { files, truncated } = await fetchCommitDiff(
      msg.owner,
      msg.repo,
      msg.commitSha,
      settings.githubToken,
    )
    return truncated ? { files, truncated } : { files }
  } catch (err) {
    const message =
      err instanceof RateLimitError
        ? RATE_LIMIT_MESSAGE
        : err instanceof Error
          ? err.message
          : String(err)
    return { files: [], errors: [message] }
  }
}

async function handleGetCommitInfo(
  msg: Extract<WorkerRequest, { type: 'getCommitInfo' }>,
): Promise<GetCommitInfoResponse> {
  const settings = await loadSettings()
  const commits: Record<string, CommitInfo> = {}
  const errors: string[] = []
  for (const sha of msg.shas) {
    const cached = await getCommitInfo(msg.owner, msg.repo, sha)
    if (cached) {
      commits[sha] = { subject: cached.subject, committedAt: cached.committedAt }
      continue
    }
    try {
      const info = await fetchCommitInfo(msg.owner, msg.repo, sha, settings.githubToken)
      await putCommitInfo({
        owner: msg.owner,
        repo: msg.repo,
        commitSha: sha,
        subject: info.subject,
        committedAt: info.committedAt,
        fetchedAt: Date.now(),
      })
      commits[sha] = info
    } catch (err) {
      if (err instanceof RateLimitError) {
        errors.push(RATE_LIMIT_MESSAGE)
        break // stop burning the remaining quota
      }
      // Individual misses (deleted commits, force-pushed repos) are non-fatal:
      // the caller falls back to the note title for that sha.
    }
  }
  return errors.length > 0 ? { commits, errors } : { commits }
}

function handle(
  msg: WorkerRequest,
): Promise<GetNotesResponse | RecordViewResponse | GetDiffResponse | GetCommitInfoResponse> {
  switch (msg.type) {
    case 'getNotes':
      return handleGetNotes(msg)
    case 'recordView':
      return handleRecordView(msg)
    case 'openHub':
      return handleOpenHub(msg)
    case 'getDiff':
      return handleGetDiff(msg)
    case 'getCommitInfo':
      return handleGetCommitInfo(msg)
  }
}

chrome.runtime.onMessage.addListener(
  (msg: WorkerRequest, _sender, sendResponse: (response: unknown) => void) => {
    handle(msg).then(sendResponse, (err: unknown) => {
      // Never leave the channel hanging (e.g. an IndexedDB failure).
      const message = err instanceof Error ? err.message : String(err)
      sendResponse(
        msg.type === 'getNotes' || msg.type === 'getDiff' || msg.type === 'getCommitInfo'
          ? { notes: {}, files: [], commits: {}, errors: [message] }
          : { ok: false },
      )
    })
    return true // keep the message channel open for the async response
  },
)
