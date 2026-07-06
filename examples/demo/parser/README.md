# Demo Envelope Parser

Small TypeScript module that parses GitNotes JSON envelopes and provides
markdown emphasis utilities. Used by the GitNotes demo branch for screenshot
content — not production code.

## Quick start

```typescript
import { tryParseNote, scanEmphasis } from './src';

const raw = '{"title":"Hi","gitnotes":1,"type":"markdown","body":"*bold*"}';
const parsed = tryParseNote(raw);
const spans = scanEmphasis('*review* this **diff**');
```

## API

| Export | Purpose |
|--------|---------|
| `parseEnvelope` | Token-scan envelope skeleton |
| `tryParseNote` | parse + non-empty title check |
| `scanEmphasis` | Find `*italic*` / `**bold**` spans |
| `formatError` | Human-readable `[CODE] message` |

## Error codes

- `UNEXPECTED_TOKEN` — malformed opening
- `MISSING_TITLE` — title must be first key
- `BAD_VERSION` — only `gitnotes: 1` supported
- `TRUNCATED_INPUT` — reserved for future strict mode

## Status

- [x] Shared types (`src/types.ts`)
- [x] Tokenizer + EOF fix
- [x] Envelope parser skeleton + perf cache
- [x] Markdown emphasis helpers
- [x] Unit tests under `tests/`

## Notes for reviewers

This module intentionally stops short of a full JSON parser — real envelopes
are validated with `JSON.parse` in the extension. The demo code models how
agent-authored review tooling might walk note structure.
