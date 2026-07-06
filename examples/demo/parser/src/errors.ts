export type ParseErrorCode =
  | 'UNEXPECTED_TOKEN'
  | 'MISSING_TITLE'
  | 'BAD_VERSION'
  | 'TRUNCATED_INPUT';

export interface ParseError {
  code: ParseErrorCode;
  message: string;
  line?: number;
  column?: number;
}

export function err(
  code: ParseErrorCode,
  message: string,
  pos?: { line: number; column: number },
): ParseError {
  return { code, message, ...pos };
}

export function formatError(e: ParseError): string {
  const where =
    e.line != null ? ` at ${e.line}:${e.column ?? 0}` : '';
  return `[${e.code}]${where} ${e.message}`;
}
