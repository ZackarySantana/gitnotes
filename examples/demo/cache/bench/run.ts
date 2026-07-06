/** Microbenchmark harness for LRUCache. */
import { LRUCache } from '../src/lru.js';

const OPS = 500_000;
const MAX = 256;
const READ_RATIO = 0.7;

function run(label: string): number {
  const cache = new LRUCache<string, number>({ maxSize: MAX });
  for (let i = 0; i < MAX; i++) cache.set('k' + i, i);

  const t0 = performance.now();
  for (let i = 0; i < OPS; i++) {
    const key = 'k' + (i % MAX);
    if (Math.random() < READ_RATIO) cache.get(key);
    else cache.set(key, i);
  }
  const ms = performance.now() - t0;
  console.log(label + ': ' + (OPS / ms * 1000).toFixed(0) + ' ops/s (' + ms.toFixed(1) + 'ms)');
  return ms;
}

run('lru-mixed');
