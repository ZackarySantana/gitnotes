import { Tokenizer } from './tokenizer';
import { GITNOTES_VERSION, type Envelope, type ParseResult } from './types';

export function parseEnvelope(raw: string): ParseResult<Envelope> {
  const tok = new Tokenizer(raw);
  const first = tok.consume();
  if (first.value !== '{') {
    return { ok: false, error: 'expected opening brace' };
  }

  // Demo: only validate structure markers, not full JSON
  const titleKey = tok.consume();
  if (titleKey.kind !== 'text' && titleKey.value !== '"') {
    return { ok: false, error: 'expected title key first' };
  }

  skipTo(tok, 'gitnotes');
  const versionTok = tok.consume();
  if (versionTok.value !== String(GITNOTES_VERSION)) {
    return { ok: false, error: `unsupported gitnotes version` };
  }

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

function skipTo(tok: Tokenizer, needle: string): void {
  let acc = '';
  while (acc.length < needle.length) {
    const t = tok.consume();
    acc += t.value;
    if (acc.endsWith(needle)) return;
  }
}
