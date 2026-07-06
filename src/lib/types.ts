// Shared contracts between the service worker, content script, options page,
// and (later) the Hub. Keep this file dependency-free.

/** A typed GitNotes envelope (schema v1): the note blob is a single JSON object. */
export interface NoteEnvelope {
  /** Schema version. Required — its presence is what marks a note as typed. */
  gitnotes: number
  /** 'html' (the standard) | 'markdown' | 'text'. Unknown values render as text. */
  type: string
  /** Hub sidebar label; writers keep it the first key for raw-git readability. */
  title?: string
  /** The payload. */
  body: string
}

/** Result of parsing raw note content. Bare non-JSON content is plain text. */
export type ParsedNote =
  | { kind: 'typed'; envelope: NoteEnvelope }
  | { kind: 'text'; content: string }

/** One note found for a commit, on one notes ref. */
export interface NoteResult {
  /** Fully qualified, e.g. "refs/notes/commits". */
  notesRef: string
  /** Git blob SHA of the note content (content-addressed cache key). */
  blobSha: string
  /** Raw note content (UTF-8). */
  content: string
  parsed: ParsedNote
}

export type ViewSurface = 'inline' | 'hub'

/** Messages from content script / hub to the service worker. */
export type WorkerRequest =
  | {
      type: 'getNotes'
      owner: string
      repo: string
      /** Commit SHAs; short SHAs are expanded by the worker. */
      shas: string[]
    }
  | {
      type: 'recordView'
      owner: string
      repo: string
      notesRef: string
      commitSha: string
      blobSha: string
      surface: ViewSurface
    }
  | {
      type: 'openHub'
      /** Note to select on open; omitted = hub landing view. */
      route?: HubNoteRoute
      /** Optional gitnotes:diff/... href — the hub navigates its diff pane
       * there after the note renders. Only meaningful with a route. */
      diffTarget?: string
    }
  | { type: 'getDiff'; owner: string; repo: string; commitSha: string }
  | {
      /** Commit subject + committer time for sidebar display; db-cached forever. */
      type: 'getCommitInfo'
      owner: string
      repo: string
      shas: string[]
    }

/** Deep link into the Hub: hub.html#/note/{owner}/{repo}/{encodeURIComponent(notesRef)}/{commitSha} */
export interface HubNoteRoute {
  owner: string
  repo: string
  notesRef: string
  commitSha: string
}

export interface GetNotesResponse {
  /** Keyed by full 40-char commit SHA; value lists notes across all discovered
   * notes refs (empty array = commit has no notes). */
  notes: Record<string, NoteResult[]>
  /** Non-fatal problems surfaced to the UI (e.g. rate limited, bad token). */
  errors?: string[]
}

export interface RecordViewResponse {
  ok: boolean
}

/** One changed file in a commit, as reported by the GitHub commits API. */
export interface DiffFile {
  filename: string
  /** Present for renames. */
  previousFilename?: string
  /** added | removed | modified | renamed | copied | changed | unchanged */
  status: string
  additions: number
  deletions: number
  /** Unified diff hunks; absent for binary or very large files. */
  patch?: string
}

export interface GetDiffResponse {
  files: DiffFile[]
  /** True when GitHub truncated the file list (commits touching >300 files). */
  truncated?: boolean
  errors?: string[]
}

export interface CommitInfo {
  /** First line of the commit message. */
  subject: string
  /** Committer date, epoch ms. */
  committedAt: number
}

export interface GetCommitInfoResponse {
  /** Keyed by requested sha; missing key = lookup failed (caller falls back). */
  commits: Record<string, CommitInfo>
  errors?: string[]
}

/** Extension settings, stored in chrome.storage.local under SETTINGS_KEY. */
export interface Settings {
  /** Fine-grained PAT with contents:read. Optional — public repos work without. */
  githubToken?: string
}

export const SETTINGS_KEY = 'settings'

export async function loadSettings(): Promise<Settings> {
  const raw = await chrome.storage.local.get(SETTINGS_KEY)
  return (raw[SETTINGS_KEY] as Settings | undefined) ?? {}
}

/** Context handed to renderers (src/lib/render.ts). */
export interface RenderContext {
  surface: ViewSurface
  owner: string
  repo: string
  /** Invoked when the user activates the "Open dynamic note" chip on an html
   * note. Absent while the Hub doesn't exist (Phase 1) — renderers show a
   * disabled chip in that case. */
  onOpenHub?: (note: NoteResult) => void
  /** Invoked when the user clicks a diff-aware link (`gitnotes:diff/...`) in a
   * markdown note. Receives the full href. Inline surface: opens the Hub at
   * that diff position; Hub surface: navigates the diff pane directly.
   * Absent → the link is inert. */
  onDiffLink?: (href: string) => void
}

/**
 * Diff-aware link scheme (schema v1 extension), usable in markdown and html
 * note bodies:
 *   gitnotes:diff/<file-path>            jump to a file in the commit's diff
 *   gitnotes:diff/<file-path>#R29        line 29, new side (L = old side)
 *   gitnotes:diff/<file-path>#R29-R40    range highlight
 */
export const GITNOTES_LINK_SCHEME = 'gitnotes:'
