/** Output formatting — text, verbose, and JSON modes. */

import type { ConfigShape } from './types.js';

export interface ResultPayload {
  command: string;
  config: ConfigShape;
  ok: boolean;
}

const MAX_VALUE_LEN = 80;

function truncate(value: string): string {
  return value.length > MAX_VALUE_LEN ? value.slice(0, 77) + '...' : value;
}

export function formatJson(payload: ResultPayload, pretty = false): string {
  const body = {
    command: payload.command,
    ok: payload.ok,
    config: payload.config,
  };
  return JSON.stringify(body, null, pretty ? 2 : undefined) + '\n';
}

export function formatResult(payload: ResultPayload, verbose = false): string {
  const lines: string[] = [];
  lines.push(`command: ${payload.command}`);
  lines.push(`status:  ${payload.ok ? 'ok' : 'error'}`);
  if (verbose) {
    for (const [key, val] of Object.entries(payload.config)) {
      lines.push(formatKeyValue(key, String(val)));
    }
  }
  return lines.join('\n') + '\n';
}

function formatKeyValue(key: string, value: string): string {
  const pad = key.padEnd(10);
  return `  ${pad} ${truncate(value)}`;
}
