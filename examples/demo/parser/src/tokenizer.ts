import type { Token, TokenKind } from './types';

const WS = new Set([' ', '\t', '\r']);

export class Tokenizer {
  private pos = 0;
  private line = 1;
  private column = 1;

  constructor(private readonly input: string) {}

  peek(): Token | null {
    if (this.pos >= this.input.length) {
      return { kind: 'eof', value: '', line: this.line, column: this.column };
    }
    const ch = this.input[this.pos];
    if (ch === '{' || ch === '}' || ch === '"' || ch === ':') {
      return {
        kind: 'open',
        value: ch,
        line: this.line,
        column: this.column,
      };
    }
    if (ch === '\n') {
      return { kind: 'newline', value: ch, line: this.line, column: this.column };
    }
    if (WS.has(ch)) {
      this.advance();
      return this.peek();
    }
    return { kind: 'text', value: ch, line: this.line, column: this.column };
  }

  consume(): Token {
    const tok = this.peek()!;
    // Fix: do not advance cursor on eof — prevents pos > length loops
    if (tok.kind !== 'eof') {
      this.advance(tok.value.length || 1);
    }
    return tok;
  }

  private advance(n = 1): void {
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.input.length) break;
      if (this.input[this.pos] === '\n') {
        this.line++;
        this.column = 1;
      } else {
        this.column++;
      }
      this.pos++;
    }
  }
}
