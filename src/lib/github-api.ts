// Pure fetch-based GitHub REST client for git-notes lookups.
// HARD CONSTRAINT: no chrome.* APIs, no DOM — must run in Node for testing.
// (type-only imports from types.ts are fine — they're erased at compile time.)

import type { DiffFile } from './types'

const API_BASE = 'https://api.github.com'

/** Thrown on 403/429 responses where x-ratelimit-remaining is 0. */
export class RateLimitError extends Error {
  constructor(endpoint: string) {
    super(`GitHub API rate limit exceeded (${endpoint})`)
    this.name = 'RateLimitError'
  }
}

/** Fanout depth of a notes tree: how many 2-hex-char directory levels. */
export type Fanout = 0 | 1 | 2

export interface DiscoveredRef {
  /** Fully qualified, e.g. "refs/notes/commits". */
  ref: string
  /** SHA of the commit the ref points at. */
  tipSha: string
}

export interface ResolvedNotesTree {
  treeSha: string
  /**
   * Fanout depths observed in the tree, most likely first. Usually one entry,
   * but git permits mixed fanout within a single notes tree (mid-transition,
   * after notes merges), so lookups must try each observed depth.
   */
  fanouts: Fanout[]
}

export interface FetchedNote {
  blobSha: string
  content: string
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers['Authorization'] = `Bearer ${token}`
  return headers
}

/** GET an API path; throws RateLimitError on exhausted rate limit. */
async function apiGet(path: string, token?: string): Promise<Response> {
  const res = await fetch(`${API_BASE}${path}`, { headers: buildHeaders(token) })
  if (
    (res.status === 403 || res.status === 429) &&
    res.headers.get('x-ratelimit-remaining') === '0'
  ) {
    throw new RateLimitError(path)
  }
  return res
}

/** GET an API path and parse JSON; throws on any non-OK status. */
async function apiGetJson<T>(path: string, token?: string): Promise<T> {
  const res = await apiGet(path, token)
  if (!res.ok) {
    throw new Error(`GitHub API responded ${res.status} for ${path}`)
  }
  return (await res.json()) as T
}

/** Decode a GitHub contents-API base64 payload as UTF-8. */
function decodeBase64Utf8(b64: string): string {
  const clean = b64.replace(/\s+/g, '')
  const bytes = Uint8Array.from(atob(clean), (c) => c.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}

const HEX2_RE = /^[0-9a-f]{2}$/
const FULL_SHA_RE = /^[0-9a-f]{40}$/i

interface MatchingRefEntry {
  ref: string
  object: { sha: string }
}

interface GitCommitResponse {
  tree: { sha: string }
}

interface TreeEntry {
  path: string
  type: string
  sha: string
}

interface TreeResponse {
  sha: string
  tree: TreeEntry[]
}

interface ContentsResponse {
  sha: string
  content: string
}

/** List all refs under refs/notes/ with their tip commit SHAs (paginated). */
export async function discoverNotesRefs(
  owner: string,
  repo: string,
  token?: string,
): Promise<DiscoveredRef[]> {
  const PER_PAGE = 100
  const refs: DiscoveredRef[] = []
  for (let page = 1; ; page++) {
    const path = `/repos/${owner}/${repo}/git/matching-refs/notes/?per_page=${PER_PAGE}&page=${page}`
    const res = await apiGet(path, token)
    if (res.status === 404) return refs
    if (!res.ok) throw new Error(`GitHub API responded ${res.status} for ${path}`)
    const entries = (await res.json()) as MatchingRefEntry[]
    refs.push(...entries.map((e) => ({ ref: e.ref, tipSha: e.object.sha })))
    if (entries.length < PER_PAGE) return refs
  }
}

async function getTree(
  owner: string,
  repo: string,
  treeSha: string,
  token?: string,
): Promise<TreeResponse> {
  return apiGetJson<TreeResponse>(`/repos/${owner}/${repo}/git/trees/${treeSha}`, token)
}

/** Resolve a notes ref tip commit to its tree SHA and detect fanout depth. */
export async function resolveNotesTree(
  owner: string,
  repo: string,
  tipSha: string,
  token?: string,
): Promise<ResolvedNotesTree> {
  const commit = await apiGetJson<GitCommitResponse>(
    `/repos/${owner}/${repo}/git/commits/${tipSha}`,
    token,
  )
  const treeSha = commit.tree.sha
  const top = await getTree(owner, repo, treeSha, token)

  // 2-hex-char subtrees mean fanned-out entries; 40-char blob names mean flat
  // entries. Both can coexist in one tree, so report every depth observed.
  const flatBlobs = top.tree.some((e) => e.type === 'blob' && FULL_SHA_RE.test(e.path))
  const firstSubtree = top.tree.find((e) => e.type === 'tree' && HEX2_RE.test(e.path))

  const fanouts: Fanout[] = []
  if (firstSubtree) {
    // Descend one level: another 2-hex-char tree level → depth 2 present;
    // 38-char blob names → depth 1 present (a merged tree can hold both).
    const sub = await getTree(owner, repo, firstSubtree.sha, token)
    const hasSecondLevel = sub.tree.some((e) => e.type === 'tree' && HEX2_RE.test(e.path))
    const hasDepth1Blobs = sub.tree.some((e) => e.type === 'blob' && e.path.length === 38)
    if (hasSecondLevel) fanouts.push(2)
    if (hasDepth1Blobs) fanouts.push(1)
    if (fanouts.length === 0) fanouts.push(1) // empty/odd subtree: assume depth 1
  }
  if (flatBlobs || fanouts.length === 0) fanouts.push(0)
  return { treeSha, fanouts }
}

/** Split a full 40-char commit SHA into the fanned-out contents path. */
function fanoutPath(commitSha: string, fanout: Fanout): string {
  switch (fanout) {
    case 0:
      return commitSha
    case 1:
      return `${commitSha.slice(0, 2)}/${commitSha.slice(2)}`
    case 2:
      return `${commitSha.slice(0, 2)}/${commitSha.slice(2, 4)}/${commitSha.slice(4)}`
  }
}

/**
 * Fetch the note blob for a commit on a notes ref; null when no note exists.
 * Tries every observed fanout depth (uniform trees = exactly one request).
 */
export async function fetchNote(
  owner: string,
  repo: string,
  notesRef: string,
  fanouts: readonly Fanout[],
  commitSha: string,
  token?: string,
): Promise<FetchedNote | null> {
  const depths = fanouts.length > 0 ? fanouts : ([0] as const)
  for (const fanout of depths) {
    const path = `/repos/${owner}/${repo}/contents/${fanoutPath(commitSha, fanout)}?ref=${encodeURIComponent(notesRef)}`
    const res = await apiGet(path, token)
    if (res.status === 404) continue
    if (!res.ok) throw new Error(`GitHub API responded ${res.status} for ${path}`)
    const data = (await res.json()) as ContentsResponse
    return { blobSha: data.sha, content: decodeBase64Utf8(data.content) }
  }
  return null
}

interface CommitFilesEntry {
  filename: string
  previous_filename?: string
  status: string
  additions: number
  deletions: number
  patch?: string
}

/**
 * Fetch a commit's changed files with unified-diff patches. GitHub returns at
 * most 300 files on this endpoint; `truncated` flags when that cap was hit.
 */
export async function fetchCommitDiff(
  owner: string,
  repo: string,
  commitSha: string,
  token?: string,
): Promise<{ files: DiffFile[]; truncated: boolean }> {
  const FILE_CAP = 300
  const data = await apiGetJson<{ files?: CommitFilesEntry[] }>(
    `/repos/${owner}/${repo}/commits/${commitSha}`,
    token,
  )
  const files = (data.files ?? []).map((f) => {
    const file: DiffFile = {
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    }
    if (f.previous_filename !== undefined) file.previousFilename = f.previous_filename
    if (f.patch !== undefined) file.patch = f.patch
    return file
  })
  return { files, truncated: files.length >= FILE_CAP }
}

/** Fetch a commit's subject line and committer time. */
export async function fetchCommitInfo(
  owner: string,
  repo: string,
  commitSha: string,
  token?: string,
): Promise<{ subject: string; committedAt: number }> {
  const data = await apiGetJson<{
    commit: { message: string; committer?: { date?: string }; author?: { date?: string } }
  }>(`/repos/${owner}/${repo}/commits/${commitSha}`, token)
  const subject = data.commit.message.split('\n', 1)[0] ?? ''
  const dateStr = data.commit.committer?.date ?? data.commit.author?.date
  const committedAt = dateStr ? Date.parse(dateStr) : 0
  return { subject, committedAt }
}

/** Expand a short commit SHA to the full 40-char SHA. */
export async function expandSha(
  owner: string,
  repo: string,
  shortSha: string,
  token?: string,
): Promise<string> {
  if (FULL_SHA_RE.test(shortSha)) return shortSha
  const commit = await apiGetJson<{ sha: string }>(
    `/repos/${owner}/${repo}/commits/${shortSha}`,
    token,
  )
  return commit.sha
}
