# trust

What an inbound item may cause, how peer text is framed, and which tool calls a wake turn may make. Pure; the mod bundles it.

- `allowedEffects(source)`: peer text may only `reply` or `propose-own-state`.
- `frameUntrusted(text, { from, pr? }, nonce)`: labelled block naming sender and PR. Start and end markers carry `nonce` (at least 16 alphanumerics, generated per frame by the caller; throws otherwise). Copies of the nonce inside the text are removed.
- `wakeToolPolicy({ tool, command? }) → allow | deny(reason)`: strict allowlists, fail closed.

## Wake-turn allowlist

Tool names match exactly and case-sensitively.

| Tool or command                                   | Allowed                                                                                                                    |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `Read`, `Glob`, `Grep`, `LS`                      | yes                                                                                                                        |
| Everything else (`Edit`, `Write`, `WebFetch` ...) | denied                                                                                                                     |
| `crew-net post\|state\|inbox\|digest`             | any arguments                                                                                                              |
| `git log`                                         | `--oneline`, `--stat`, `-n N`, `-N`, `--max-count N`, `--format oneline\|short\|medium`, refs, repo-relative paths         |
| `git show`, `git diff`                            | `--stat`, `--name-only`, `--name-status`, refs, repo-relative paths                                                        |
| `git status`                                      | `-s`, `--short`, `--branch`, paths                                                                                         |
| `gh pr view N`                                    | `--json fields`, `--comments`                                                                                              |
| `gh pr diff N`                                    | `--name-only`                                                                                                              |
| `gh pr checks N`                                  | no flags                                                                                                                   |
| `gh pr list`                                      | `--state open\|closed\|merged\|all`, `--json fields`, `--limit N`                                                          |
| `gh api`                                          | one `repos/...` path without `..`; `-H`/`--header 'Name: value'` (no override or authorization), `--jq expr`, `--paginate` |

Rules for every Bash command:

- Printable ASCII only (0x20-0x7E). A reply therefore uses `crew -> dev/name`, not the arrow.
- No `;`, `&`, `|`, `<`, `>`, parentheses, newline, backslash outside quotes, backtick or `$` outside single quotes.
- The command word is the first word: no `VAR=x` prefix, no global flags (`git -C`, `gh -R`), no path to the binary.
- Any flag not listed is denied, as is `--`. Positional refs and paths cannot start with `-`, `~` or `/`, cannot hold a `..` segment, and cannot hold shell glob or brace characters.
