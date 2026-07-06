import { Tokenizer } from '../src/tokenizer';

function collect(input: string): string[] {
  const t = new Tokenizer(input);
  const out: string[] = [];
  for (;;) {
    const tok = t.consume();
    out.push(tok.kind);
    if (tok.kind === 'eof') break;
  }
  return out;
}

// Demo assertions — run with: node --test tests/
export function testEofOnEmpty(): void {
  const kinds = collect('');
  if (kinds.length !== 1 || kinds[0] !== 'eof') {
    throw new Error('expected single eof token');
  }
}

export function testTrailingWhitespace(): void {
  const kinds = collect('{ }   ');
  if (kinds[kinds.length - 1] !== 'eof') {
    throw new Error('expected clean eof after trailing ws');
  }
}
