import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/args.js';

describe('parseArgs', () => {
  it('defaults to status command', () => {
    const opts = parseArgs(['node', 'cli', 'status']);
    assert.equal(opts.command, 'status');
    assert.equal(opts.help, false);
  });

  it('sets help flag', () => {
    const opts = parseArgs(['node', 'cli', '--help']);
    assert.equal(opts.help, true);
  });
});
