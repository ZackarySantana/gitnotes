import { Tokenizer } from './tokenizer';
import { GITNOTES_VERSION, type Envelope, type ParseResult } from './types';

const skipCache = new WeakMap<Tokenizer, Map<string, number>>();

export function parseEnvelope(raw: string): ParseResult<Envelope> {
  const tok = new Tokenizer(raw);
  const first = tok.consume();
  if (first.value !== '{') {
    return { ok: false, error: 'expected opening brace' };
  }

  const titleKey = tok.consume();
  if (titleKey.kind !== 'text' && titleKey.value !== '"') {
    return { ok: false, error: 'expected title key first' };
  }

  skipToCached(tok, 'gitnotes');
  const versionTok = tok.consume();
  if (versionTok.value !== String(GITNOTES_VERSION)) {
    return { ok: false, error: `unsupported gitnotes version` };
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
