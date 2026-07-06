import { scanEmphasis, stripEmphasis } from '../src/emphasis';

export function testBoldSpan(): void {
  const spans = scanEmphasis('hello **world**');
  if (spans.length !== 1 || spans[0].kind !== 'bold') {
    throw new Error('expected one bold span');
  }
}

export function testStrip(): void {
  const plain = stripEmphasis('*a* and **b**');
  if (plain !== 'a and b') throw new Error(`unexpected: ${plain}`);
}
