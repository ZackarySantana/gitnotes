/** Config validation helpers. */

import type { ConfigShape } from './types.js';

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly code: 'INVALID_SCHEMA' | 'INVALID_VALUE'
  ) {
    super(message);
    this.name = 'ConfigError';
  }
}

function isUnset(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

export function validateConfig(config: ConfigShape): void {
  if (config.output !== 'text' && config.output !== 'json') {
    throw new ConfigError(`invalid output mode: ${config.output}`, 'INVALID_VALUE');
  }
  if (typeof config.verbose !== 'boolean') {
    throw new ConfigError('verbose must be boolean', 'INVALID_SCHEMA');
  }
  // optional theme: empty string treated as unset (fix for commit 26 regression)
  if (!isUnset(config.theme) && config.theme.trim() === '') {
    throw new ConfigError('theme cannot be whitespace-only', 'INVALID_VALUE');
  }
}
