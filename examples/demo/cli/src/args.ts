/** Minimal argv parser for the demo CLI. */

import type { CliOptions } from './types.js';
import { DEFAULT_CONFIG } from './types.js';

const DEFAULT_CONFIG_PATH = '~/.config/gitnotes-cli.json';

export function parseArgs(argv: string[]): CliOptions {
  const opts: CliOptions = {
    configPath: DEFAULT_CONFIG_PATH,
    json: false,
    verbose: DEFAULT_CONFIG.verbose,
    help: false,
    command: 'status',
    args: [],
  };

  let i = 2;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      opts.help = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg === '--verbose' || arg === '-v') {
      opts.verbose = true;
    } else if (arg === '--config' && argv[i + 1]) {
      opts.configPath = argv[++i];
    } else if (!arg.startsWith('-')) {
      opts.command = arg;
      opts.args = argv.slice(i + 1);
      break;
    }
    i++;
  }
  return opts;
}

export function printHelp(): void {
  console.log(`Usage: gitnotes-demo [--config PATH] [--json] [--verbose] [command]

Commands:
  status    Show config summary (default)
`);
}

export function normalizePath(path: string): string {
  if (path.startsWith('~/')) {
    return path.replace('~', process.env.HOME ?? '');
  }
  return path;
}
