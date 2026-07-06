import { describe, it, expect } from 'vitest';
import { RequestCoalescer } from '../src/coalesce.js';

describe('RequestCoalescer regression', () => {
  it('clears inFlight after rejected fetch', async () => {
    const co = new RequestCoalescer<string, number>();
    await expect(co.getOrFetch('bad', () => Promise.reject(new Error('nope'))))
      .rejects.toThrow('nope');
    expect(co.pendingCount()).toBe(0);
  });

  it('allows retry after failure', async () => {
    const co = new RequestCoalescer<string, number>();
    let attempt = 0;
    await expect(co.getOrFetch('k', () => {
      attempt++;
      return attempt === 1 ? Promise.reject(new Error('fail')) : Promise.resolve(7);
    })).rejects.toThrow();
    const val = await co.getOrFetch('k', () => Promise.resolve(7));
    expect(val).toBe(7);
  });
});
