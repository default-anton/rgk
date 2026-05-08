# rgk

`rgk` is `rg` plus one extra option:

```bash
rgk PATTERN --keep "natural language condition"
```

`rg` still does the fast lexical search. `--keep` sends the matching lines to Codex, keeps only results that satisfy the condition, and prints kept results ranked strongest first.

Without `--keep`, `rgk` execs `rg` directly. `--help`, `-h`, and `--version` show normal `rg` output with a short `rgk` section appended.

## Installation

```bash
npm install -g @akuzmenko/rgk
```

Requirements:

- Node.js 24+
- `rg` on `PATH`
- `codex` on `PATH`, authenticated and ready to run `codex exec`

## Usage

```bash
rgk "TODO" --keep "security-sensitive follow-up"
rgk "fetch" src --keep "network calls without timeout"
rgk "class .*Error" --keep "errors shown to end users"
echo "foo\nbar" | rgk foo --keep "the foo line"
```

In `--keep` mode, output is normalized and match-centered for agents and scripts:

```text
path/to/file:line:column:compact matched text
```

Long lines are shortened around the matched span before they reach the agent context. Search semantics pass through to `rg`; presentation becomes plain, no-color, and line-oriented so ranking and filtering are reliable in pipes, editors, and coding-agent workflows. `--keep` rejects `rg` output modes that do not return match lines, such as count and files-with-matches modes.

## Privacy

Without `--keep`, `rgk` execs `rg` directly and does not call Codex. With `--keep`, the keep condition, matched paths, and compact matched lines are sent to Codex for filtering and ranking. Narrow your `rg` query first when searching private or sensitive code.

## Configuration

Environment variables:

| Variable                    | Default               | Description                                         |
| --------------------------- | --------------------- | --------------------------------------------------- |
| `RGK_MODEL`                 | `gpt-5.3-codex-spark` | Codex model                                         |
| `RGK_REASONING_EFFORT`      | `low`                 | Codex reasoning effort                              |
| `RGK_KEEP_LIMIT`            | `300`                 | Max candidates sent to Codex                        |
| `RGK_PROMPT_MAX_BYTES`      | `180000`              | Max prompt bytes sent to Codex                      |
| `RGK_PROMPT_LINE_MAX_BYTES` | `600`                 | Max matched-line bytes sent per candidate (min `4`) |
| `RGK_OUTPUT_LINE_MAX_BYTES` | `300`                 | Max matched-line bytes printed per result (min `4`) |
| `RGK_CODEX_TIMEOUT_MS`      | `300000`              | Codex timeout                                       |
| `RGK_RG_PATH`               | `rg`                  | ripgrep executable                                  |
| `RGK_CODEX_PATH`            | `codex`               | Codex executable                                    |
| `RGK_DEBUG`                 | unset                 | Set `1` or `true` to show Codex diagnostics         |

## Exit codes

- `0`: kept results printed
- `1`: no `rg` matches, or no kept results
- `2`: invalid usage, `rg` error, or Codex/filter failure

## Development

```bash
pnpm install
pnpm run verify
```

## License

MIT
