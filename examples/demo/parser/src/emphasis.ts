export interface EmphasisSpan {
  kind: 'italic' | 'bold';
  start: number;
  end: number;
  text: string;
}

const ITALIC = /\*([^*]+)\*/g;
const BOLD = /\*\*([^*]+)\*\*/g;

export function scanEmphasis(input: string): EmphasisSpan[] {
  const spans: EmphasisSpan[] = [];
  for (const re of [BOLD, ITALIC]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(input)) !== null) {
      spans.push({
        kind: re === BOLD ? 'bold' : 'italic',
        start: m.index,
        end: m.index + m[0].length,
        text: m[1],
      });
    }
  }
  return spans.sort((a, b) => a.start - b.start);
}

export function stripEmphasis(input: string): string {
  return input.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/\*([^*]+)\*/g, '$1');
}
