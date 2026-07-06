// IndexedDB wrapper shared by the MV3 service worker and (later) the Hub.
// `indexedDB` is available globally in the worker. No external libraries.

import type { Fanout } from './github-api'
import type { ViewSurface } from './types'

const DB_NAME = 'gitnotes'
const DB_VERSION = 2

const BLOBS = 'blobs'
const COMMIT_NOTES = 'commitNotes'
const REPO_REFS = 'repoRefs'
const VIEW_EVENTS = 'viewEvents'
const NOTE_META = 'noteMeta'
const COMMITS = 'commits'

/** Content-addressed note blob; immutable, deduped. */
export interface BlobRecord {
  blobSha: string
  content: string
  /** UTF-8 byte size of content. */
  size: number
  fetchedAt: number
}

/** Browse-time cache entry, including negative ("no note") results. */
export interface CommitNoteRecord {
  owner: string
  repo: string
  notesRef: string
  commitSha: string
  /** null = known no-note for this tipSha. */
  blobSha: string | null
  tipSha: string
  cachedAt: number
}

export interface RepoRefInfo {
  ref: string
  tipSha: string
  treeSha: string
  /** Fanout depths observed in the notes tree, most likely first. */
  fanouts: Fanout[]
}

export interface RepoRefsRecord {
  owner: string
  repo: string
  /** Empty array = repo has no notes refs (cached negative result). */
  refs: RepoRefInfo[]
  cachedAt: number
}

/** Append-only record of an explicit note open. */
export interface ViewEventRecord {
  owner: string
  repo: string
  notesRef: string
  commitSha: string
  blobSha: string
  viewedAt: number
  surface: ViewSurface
}

export interface NoteMetaRecord {
  pinned: boolean
  tags?: string[]
}

/** Commit metadata for sidebar display; commits are immutable → cached forever. */
export interface CommitInfoRecord {
  owner: string
  repo: string
  commitSha: string
  /** First line of the commit message. */
  subject: string
  /** Committer date, epoch ms. */
  committedAt: number
  fetchedAt: number
}

export function commitInfoKey(owner: string, repo: string, commitSha: string): string {
  return `${owner}/${repo}|${commitSha}`
}

export function commitNoteKey(
  owner: string,
  repo: string,
  notesRef: string,
  commitSha: string,
): string {
  return `${owner}/${repo}|${notesRef}|${commitSha}`
}

export function repoRefsKey(owner: string, repo: string): string {
  return `${owner}/${repo}`
}

let dbPromise: Promise<IDBDatabase> | null = null

function openDb(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION)
      req.onupgradeneeded = () => {
        // Idempotent per store so any prior version upgrades cleanly.
        const db = req.result
        const has = (name: string) => db.objectStoreNames.contains(name)
        if (!has(BLOBS)) db.createObjectStore(BLOBS, { keyPath: 'blobSha' })
        if (!has(COMMIT_NOTES)) db.createObjectStore(COMMIT_NOTES)
        if (!has(REPO_REFS)) db.createObjectStore(REPO_REFS)
        if (!has(VIEW_EVENTS)) {
          const viewEvents = db.createObjectStore(VIEW_EVENTS, { autoIncrement: true })
          viewEvents.createIndex('viewedAt', 'viewedAt')
        }
        if (!has(NOTE_META)) db.createObjectStore(NOTE_META)
        if (!has(COMMITS)) db.createObjectStore(COMMITS)
      }
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error ?? new Error('Failed to open gitnotes database'))
    })
    // Allow a retry on failure instead of caching the rejection forever.
    dbPromise.catch(() => {
      dbPromise = null
    })
  }
  return dbPromise
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'))
  })
}

async function storeGet<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb()
  const store = db.transaction(storeName, 'readonly').objectStore(storeName)
  return requestToPromise(store.get(key)) as Promise<T | undefined>
}

async function storePut(storeName: string, value: unknown, key?: IDBValidKey): Promise<void> {
  const db = await openDb()
  const store = db.transaction(storeName, 'readwrite').objectStore(storeName)
  await requestToPromise(store.put(value, key))
}

// --- blobs -----------------------------------------------------------------

export function getBlob(blobSha: string): Promise<BlobRecord | undefined> {
  return storeGet<BlobRecord>(BLOBS, blobSha)
}

export function putBlob(record: BlobRecord): Promise<void> {
  return storePut(BLOBS, record)
}

// --- commitNotes -----------------------------------------------------------

export function getCommitNote(
  owner: string,
  repo: string,
  notesRef: string,
  commitSha: string,
): Promise<CommitNoteRecord | undefined> {
  return storeGet<CommitNoteRecord>(COMMIT_NOTES, commitNoteKey(owner, repo, notesRef, commitSha))
}

export function putCommitNote(record: CommitNoteRecord): Promise<void> {
  return storePut(
    COMMIT_NOTES,
    record,
    commitNoteKey(record.owner, record.repo, record.notesRef, record.commitSha),
  )
}

// --- repoRefs --------------------------------------------------------------

export function getRepoRefs(owner: string, repo: string): Promise<RepoRefsRecord | undefined> {
  return storeGet<RepoRefsRecord>(REPO_REFS, repoRefsKey(owner, repo))
}

export function putRepoRefs(record: RepoRefsRecord): Promise<void> {
  return storePut(REPO_REFS, record, repoRefsKey(record.owner, record.repo))
}

/** Every cached commit-note entry, including negative (blobSha: null) ones. */
export async function listCommitNotes(): Promise<CommitNoteRecord[]> {
  const db = await openDb()
  const store = db.transaction(COMMIT_NOTES, 'readonly').objectStore(COMMIT_NOTES)
  return (await requestToPromise(store.getAll())) as CommitNoteRecord[]
}

// --- viewEvents ------------------------------------------------------------

export function addViewEvent(record: ViewEventRecord): Promise<void> {
  return storePut(VIEW_EVENTS, record)
}

/** All view events, most recent first (by the viewedAt index). */
export async function listViewEvents(): Promise<ViewEventRecord[]> {
  const db = await openDb()
  const index = db.transaction(VIEW_EVENTS, 'readonly').objectStore(VIEW_EVENTS).index('viewedAt')
  const events = await requestToPromise(index.getAll())
  return (events as ViewEventRecord[]).reverse()
}

// --- commits ---------------------------------------------------------------

export function getCommitInfo(
  owner: string,
  repo: string,
  commitSha: string,
): Promise<CommitInfoRecord | undefined> {
  return storeGet<CommitInfoRecord>(COMMITS, commitInfoKey(owner, repo, commitSha))
}

export function putCommitInfo(record: CommitInfoRecord): Promise<void> {
  return storePut(COMMITS, record, commitInfoKey(record.owner, record.repo, record.commitSha))
}

// --- removal (Hub "remove from library") -------------------------------------

/** Delete every view event for one note (cursor scan — the store has
 * out-of-line autoincrement keys, so records can't be deleted by value). */
export async function deleteViewEventsFor(
  owner: string,
  repo: string,
  notesRef: string,
  commitSha: string,
): Promise<void> {
  const db = await openDb()
  const store = db.transaction(VIEW_EVENTS, 'readwrite').objectStore(VIEW_EVENTS)
  await new Promise<void>((resolve, reject) => {
    const cursorReq = store.openCursor()
    cursorReq.onsuccess = () => {
      const cursor = cursorReq.result
      if (!cursor) {
        resolve()
        return
      }
      const ev = cursor.value as ViewEventRecord
      if (
        ev.owner === owner &&
        ev.repo === repo &&
        ev.notesRef === notesRef &&
        ev.commitSha === commitSha
      ) {
        cursor.delete()
      }
      cursor.continue()
    }
    cursorReq.onerror = () =>
      reject(cursorReq.error ?? new Error('IndexedDB cursor failed'))
  })
}

export async function deleteCommitNote(
  owner: string,
  repo: string,
  notesRef: string,
  commitSha: string,
): Promise<void> {
  const db = await openDb()
  const store = db.transaction(COMMIT_NOTES, 'readwrite').objectStore(COMMIT_NOTES)
  await requestToPromise(store.delete(commitNoteKey(owner, repo, notesRef, commitSha)))
}

/** Delete a blob unless another commitNotes entry still references it. */
export async function deleteBlobIfUnreferenced(blobSha: string): Promise<void> {
  const remaining = await listCommitNotes()
  if (remaining.some((cn) => cn.blobSha === blobSha)) return
  const db = await openDb()
  const store = db.transaction(BLOBS, 'readwrite').objectStore(BLOBS)
  await requestToPromise(store.delete(blobSha))
}

// --- noteMeta --------------------------------------------------------------

export function getNoteMeta(
  owner: string,
  repo: string,
  notesRef: string,
  commitSha: string,
): Promise<NoteMetaRecord | undefined> {
  return storeGet<NoteMetaRecord>(NOTE_META, commitNoteKey(owner, repo, notesRef, commitSha))
}

export function putNoteMeta(
  owner: string,
  repo: string,
  notesRef: string,
  commitSha: string,
  record: NoteMetaRecord,
): Promise<void> {
  return storePut(NOTE_META, record, commitNoteKey(owner, repo, notesRef, commitSha))
}
