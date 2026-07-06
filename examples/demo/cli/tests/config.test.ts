import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { DEFAULT_CONFIG } from '../src/types.js';

describe('loadConfig', () => {
  it('returns defaults when file missing', () => {
    const cfg = loadConfig('/nonexistent/demo-config.json');
    assert.deepEqual(cfg, DEFAULT_CONFIG);
  });
});
