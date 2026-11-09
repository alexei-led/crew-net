# trust

What an inbound item may cause, how peer text is framed, and which tool calls a wake turn may make. Pure; the mod bundles it.

- `allowedEffects(source)`: peer text may only `reply` or `propose-own-state`.
- `frameUntrusted(text, { from, pr? }, nonce)`: labelled block naming sender and PR. Start and end markers carry `nonce` (at least 16 alphanumerics, generated per frame by the caller; throws otherwise). Copies of the nonce inside the text are removed.
- `gate({ tool, input }, turn) → allow | deny(reason)`: the wake-turn tool gate (design: Trust and autonomy). `turn` is `{ kind: "normal" }` (always allow; the merge gate is separate) or `{ kind: "wake", root, repo, item, hasOwnPr }`. The caller runs wake-turn Bash with its cwd at `root`. Strict allowlists, fail closed.

## Wake-turn allowlist

Tool names match exactly and case-sensitively.

| Tool or command                                   | Allowed                                                                                                                                                    |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Read` (`file_path`), `LS` (`path`)               | absolute paths inside `root`                                                                                                                               |
| `Grep`, `Glob`                                    | `path` required, absolute, inside `root`; `pattern` / `glob` relative, no `..` anywhere, no `~`                                                            |
| Everything else (`Edit`, `Write`, `WebFetch` ...) | denied                                                                                                                                                     |
| `crew-net reply <item> [--done\|--decline] text`  | only `item` = the waking item; `--json`                                                                                                                    |
| `crew-net inbox`                                  | `--json`                                                                                                                                                   |
| `crew-net state <state> [paths]`                  | only when `hasOwnPr`; `--scope path`, `--json`, `--repo` equal to `repo`                                                                                   |
| `git log`                                         | `--oneline`, `--stat`, `-n N`, `-N`, `--max-count N`, `--format oneline\|short\|medium`, refs, repo-relative paths                                         |
| `git show`, `git diff`                            | `--stat`, `--name-only`, `--name-status`, refs, repo-relative paths                                                                                        |
| `git status`                                      | `-s`, `--short`, `--branch`, paths                                                                                                                         |
| `gh pr view N`                                    | `--json fields`, `--comments`                                                                                                                              |
| `gh pr diff N`                                    | `--name-only`                                                                                                                                              |
| `gh pr checks N`                                  | no flags                                                                                                                                                   |
| `gh pr list`                                      | `--state open\|closed\|merged\|all`, `--json fields`, `--limit N`                                                                                          |
| `gh api`                                          | one `repos/<repo>...` path (the session's repo only) without `..`; `-H`/`--header 'Name: value'` (no override or authorization), `--jq expr`, `--paginate` |

`--jq` filters may use `A-Z a-z 0-9 _ . [ ] | , : " = ! < > ( ) + -` and spaces, field access (`.name`), and listed builtins (`select`, `map`, `length`, `keys`, `join`, ...). No `$`, `\`, `@`, `;`, `env` or `input`.

Paths are resolved against `root` without following links: a symlink inside the worktree that points out is not caught.

Rules for every Bash command:

- Printable ASCII only (0x20-0x7E).
- No `;`, `&`, `|`, `<`, `>`, parentheses, newline, backtick, or `$` outside single quotes; no backslash outside quotes. Inside double quotes a backslash escapes only `$`, backtick, `"` and `\`, as in bash.
- No unquoted glob, brace or zsh extended-glob characters (`* ? [ ] { } ^ #`), no `~` at a word start or after `=` or `:`.
- The command word is the first word: no `VAR=x` prefix, no global flags (`git -C`, `gh -R`), no path to the binary.
- Any flag not listed is denied, as is `--`. Positional refs and paths cannot start with `-`, `~` or `/`, cannot hold a `..` segment, and cannot hold shell glob or brace characters.
