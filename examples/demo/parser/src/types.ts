/** GitNotes envelope schema v1 — shared types for the demo parser. */

export const GITNOTES_VERSION = 1;

export type NoteType = 'html' | 'markdown' | 'text';

export interface Envelope {
  title: string;
  gitnotes: typeof GITNOTES_VERSION;
  type: NoteType;
  body: string;
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export type TokenKind = 'open' | 'close' | 'text' | 'newline' | 'eof';

export interface Token {
  kind: TokenKind;
  value: string;
  line: number;
  column: number;
}
