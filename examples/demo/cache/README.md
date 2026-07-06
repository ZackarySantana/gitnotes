# Demo LRU cache

Small TypeScript LRU cache with request coalescing for GitNotes demo screenshots.

## Modules

| File | Role |
|------|------|
| `src/lru.ts` | Size-bounded LRU with hit/miss stats |
| `src/coalesce.ts` | Single-flight dedup for async fetches |
| `src/ttl.ts` | Time-based expiry wrapper |

## Composition

Wrap coalescer around LRU for blob fetches:

```ts
const lru = new LRUCache<string, Blob>({ maxSize: 128 });
const co = new RequestCoalescer<string, Blob>();

async function getBlob(sha: string): Promise<Blob> {
  const hit = lru.get(sha);
  if (hit) return hit;
  return co.getOrFetch(sha, async () => {
    const blob = await fetchFromOrigin(sha);
    lru.set(sha, blob);
    return blob;
  });
}
```

Run `npm test` and `npm run bench` from this directory.

## Status

Feature-complete for demo — all modules exported from `src/index.ts`.
