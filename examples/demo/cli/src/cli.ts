/** Demo CLI entry — wires args, config, env, validation, and output. */

import { parseArgs, printHelp, warnUnknownFlags } from './args.js';
import { loadConfig } from './config.js';
import { applyEnvOverrides } from './env.js';
import { formatJson, formatResult } from './output.js';
import { validateConfig, ConfigError } from './validate.js';
import type { ConfigShape } from './types.js';

export function runCommand(command: string, _config: ConfigShape): boolean {
  switch (command) {
    case 'status':
      return true;
    default:
      console.error(`unknown command: ${command}`);
      return false;
  }
}

function handleError(err: unknown): number {
  if (err instanceof ConfigError) {
    console.error(`config error: ${err.message}`);
    return err.code === 'INVALID_SCHEMA' ? 3 : 4;
  }
  console.error(String(err));
  return 1;
}

export function main(argv: string[] = process.argv): number {
  try {
    const { opts, unknownFlags } = parseArgs(argv);
    warnUnknownFlags(unknownFlags);
    if (opts.help) {
      printHelp();
      return 0;
    }
    let config = loadConfig(opts.configPath);
    config = applyEnvOverrides(config);
    if (process.env.GITNOTES_CLI_DEBUG === '1') {
      console.error('[debug] config after env overrides:', config);
    }
    validateConfig(config);
    const ok = runCommand(opts.command, config);
    const payload = { command: opts.command, config, ok };
    const useJson = opts.json || config.output === 'json';
    const out = useJson
      ? formatJson(payload)
      : formatResult(payload, opts.verbose || config.verbose);
    process.stdout.write(out);
    return ok ? 0 : 2;
  } catch (err) {
    return handleError(err);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
