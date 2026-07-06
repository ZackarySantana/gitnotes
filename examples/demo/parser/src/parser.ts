import { Tokenizer } from './tokenizer';
import { err, type ParseError } from './errors';
import { GITNOTES_VERSION, type Envelope, type ParseResult } from './types';

const skipCache = new WeakMap<Tokenizer, Map<string, number>>();

export function parseEnvelope(raw: string): ParseResult<Envelope> {
  const tok = new Tokenizer(raw);
  const first = tok.consume();
  if (first.value !== '{') {
    return fail('UNEXPECTED_TOKEN', 'expected opening brace', first);
  }

  const titleKey = tok.consume();
  if (titleKey.kind !== 'text' && titleKey.value !== '"') {
    return fail('MISSING_TITLE', 'expected title key first', titleKey);
  }

  skipToCached(tok, 'gitnotes');
  const versionTok = tok.consume();
  if (versionTok.value !== String(GITNOTES_VERSION)) {
    return fail('BAD_VERSION', `unsupported gitnotes version`, versionTok);
  }

  skipToCached(tok, 'body');
  return {
    ok: true,
    value: {
      title: 'placeholder',
      gitnotes: GITNOTES_VERSION,
      type: 'markdown',
      body: '',
    },
  };
}

function fail(
  code: ParseError['code'],
  message: string,
  tok: { line: number; column: number },
): ParseResult<Envelope> {
  return { ok: false, error: formatInline(err(code, message, tok)) };
}

function formatInline(e: ParseError): string {
  return `[${e.code}] ${e.message}`;
}

function skipToCached(tok: Tokenizer, needle: string): void {
  let cache = skipCache.get(tok);
  if (!cache) {
    cache = new Map();
    skipCache.set(tok, cache);
  }
  if (cache.has(needle)) return;
  skipTo(tok, needle);
  cache.set(needle, 1);
}

function skipTo(tok: Tokenizer, needle: string): void {
  let acc = '';
  while (acc.length < needle.length + 8) {
    const t = tok.consume();
    acc += t.value;
    if (acc.includes(needle)) return;
    if (t.kind === 'eof') return;
  }
}
