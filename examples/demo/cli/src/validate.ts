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

export function validateConfig(config: ConfigShape): void {
  if (config.output !== 'text' && config.output !== 'json') {
    throw new ConfigError(`invalid output mode: ${config.output}`, 'INVALID_VALUE');
  }
  if (typeof config.verbose !== 'boolean') {
    throw new ConfigError('verbose must be boolean', 'INVALID_SCHEMA');
  }
  validateRequired(config);
}

function validateRequired(config: ConfigShape): void {
  if (config.theme === '') {
    throw new ConfigError('theme cannot be empty', 'INVALID_VALUE');
  }
}
