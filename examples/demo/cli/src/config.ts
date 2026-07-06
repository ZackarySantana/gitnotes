/** Load JSON config from disk with fallback defaults. */

import { readFileSync } from 'node:fs';
import type { ConfigShape } from './types.js';
import { DEFAULT_CONFIG } from './types.js';
import { normalizePath } from './args.js';

export function loadConfig(configPath: string): ConfigShape {
  const resolved = normalizePath(configPath);
  try {
    const raw = readFileSync(resolved, 'utf8');
    const parsed = JSON.parse(raw) as Partial<ConfigShape>;
    return { ...DEFAULT_CONFIG, ...parsed };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}
