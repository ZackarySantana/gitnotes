import type { NoteEnvelope, ParsedNote } from './types'

/**
 * Parse raw note content into a ParsedNote.
 *
 * A typed note is a JSON object with a numeric `gitnotes` (schema version) and
 * a string `body`. `type` defaults to 'html' (the standard) when absent;
 * `title` is kept only when it is a string. Anything else — parse failure,
 * arrays, missing/mistyped fields — falls back to plain text with the original
 * (untrimmed) content. Never throws. Zero dependencies (unit-tested in Node).
 */
export function parseNote(content: string): ParsedNote {
  const fallback: ParsedNote = { kind: 'text', content }

  const trimmed = content.trim()
  if (!trimmed.startsWith('{')) return fallback

  let value: unknown
  try {
    value = JSON.parse(trimmed)
  } catch {
    return fallback
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fallback
  }

  const obj = value as Record<string, unknown>
  if (typeof obj['gitnotes'] !== 'number') return fallback
  if (typeof obj['body'] !== 'string') return fallback

  const rawType = obj['type']
  if (rawType !== undefined && typeof rawType !== 'string') return fallback

  const envelope: NoteEnvelope = {
    gitnotes: obj['gitnotes'],
    type: typeof rawType === 'string' ? rawType : 'html',
    body: obj['body'],
  }
  if (typeof obj['title'] === 'string') envelope.title = obj['title']

  return { kind: 'typed', envelope }
}

/** The envelope title of a typed note, else undefined. Helper for UI layers. */
export function noteTitle(parsed: ParsedNote): string | undefined {
  return parsed.kind === 'typed' ? parsed.envelope.title : undefined
}
