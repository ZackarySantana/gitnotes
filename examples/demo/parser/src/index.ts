export { parseEnvelope } from './parser';
export { scanEmphasis, stripEmphasis } from './emphasis';
export { err, formatError, type ParseError, type ParseErrorCode } from './errors';
export {
  GITNOTES_VERSION,
  type Envelope,
  type NoteType,
  type ParseResult,
  type Token,
} from './types';

/** Convenience: parse + validate minimum envelope shape. */
export function tryParseNote(raw: string) {
  const result = parseEnvelope(raw);
  if (!result.ok) return result;
  if (!result.value.title) {
    return { ok: false as const, error: '[MISSING_TITLE] empty title' };
  }
  return result;
}

import { parseEnvelope } from './parser';
