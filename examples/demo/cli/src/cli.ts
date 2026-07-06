/** Demo CLI entry — wires args, config, and output. */

import { parseArgs, printHelp } from './args.js';
import { loadConfig } from './config.js';
import { formatResult } from './output.js';
import type { ConfigShape } from './types.js';

export function runCommand(command: string, config: ConfigShape): boolean {
  switch (command) {
    case 'status':
      return true;
    default:
      console.error(`unknown command: ${command}`);
      return false;
  }
}

export function main(argv: string[] = process.argv): number {
  const opts = parseArgs(argv);
  if (opts.help) {
    printHelp();
    return 0;
  }
  const config = loadConfig(opts.configPath);
  const ok = runCommand(opts.command, config);
  const out = formatResult(
    { command: opts.command, config, ok },
    opts.verbose || config.verbose
  );
  process.stdout.write(out);
  return ok ? 0 : 2;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
