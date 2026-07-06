/** Environment variable overrides for demo CLI config. */

import type { ConfigShape } from './types.js';

const PREFIX = 'GITNOTES_CLI_';

export function applyEnvOverrides(config: ConfigShape): ConfigShape {
  const next = { ...config };
  if (process.env[`${PREFIX}VERBOSE`] === '1') {
    next.verbose = true;
  }
  const output = process.env[`${PREFIX}OUTPUT`];
  if (output === 'json' || output === 'text') {
    next.output = output;
  }
  const theme = process.env[`${PREFIX}THEME`];
  if (theme) {
    next.theme = theme;
  }
  return next;
}
