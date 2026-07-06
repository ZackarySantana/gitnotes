# GitNotes Demo CLI

Small fictional TypeScript CLI demonstrating args parsing, config loading,
environment overrides, and formatted output. Part of the `examples/demo/cli`
slice on the demo branch.

## Usage

```
gitnotes-demo [--config PATH] [--json] [--verbose] [command]
```

### Commands

| Command | Description              | Exit code |
|---------|--------------------------|-----------|
| status  | Show config summary      | 0         |
| (other) | Unknown command          | 2         |

### Flags

- `--config PATH` — JSON config file (default: `~/.config/gitnotes-cli.json`)
- `--json` — emit JSON on stdout (overrides text formatter)
- `--verbose` / `-v` — include config key-value lines
- `--help` / `-h` — print usage

### Environment

| Variable              | Effect                          |
|-----------------------|---------------------------------|
| GITNOTES_CLI_VERBOSE  | Set to `1` to force verbose     |
| GITNOTES_CLI_OUTPUT   | `text` or `json`                |
| GITNOTES_CLI_THEME    | Override theme string           |
| GITNOTES_CLI_DEBUG    | Log applied env overrides       |

## Troubleshooting

**Exit code 3 / config error on empty theme:** commit 26 rejected `""` for
optional fields. Commit 30 treats empty strings as unset via `isUnset()` in
`validate.ts`. Use `fixtures/minimal.json` as the reference shape.

## Tests

```
npm test
```
