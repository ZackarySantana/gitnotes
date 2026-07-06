/** Shared types for the demo CLI module. */

export interface CliOptions {
  configPath: string;
  json: boolean;
  verbose: boolean;
  help: boolean;
  command: string;
  args: string[];
}

export interface ConfigShape {
  verbose: boolean;
  output: 'text' | 'json';
  theme: string;
}

export const DEFAULT_CONFIG: ConfigShape = {
  verbose: false,
  output: 'text',
  theme: 'default',
};
