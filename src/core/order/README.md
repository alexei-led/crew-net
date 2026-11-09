# order

The client merge gate (design §11, §12). Pure. The caller (`crew-net gate`) reads GitHub; these functions decide.

1. `detectMerge(command, { aliases? }) → none | merge(targets) | deny(reason)` reads a Bash command line.
2. For each target, the caller resolves the PR (`repo` missing: the repo of the command's cwd; `pr` and `branch` missing: the PR of the current branch), reads its body, calls `dependencies(pr)` to learn which PRs to read, reads their state, and calls `gate(pr, states)`.

## `detectMerge`

- `gh pr merge [N|URL|branch]`, any flag order, `--auto`, `gh pr -R o/r merge`: `merge` with `repo`, `pr` or `branch`.
- `gh pr merge --disable-auto`: `none`, it removes risk.
- `gh api` to `repos/o/r/pulls/N/merge` with a non-GET method, a body or a method override: `merge`.
- `gh api graphql` with `mergePullRequest`, `enablePullRequestAutoMerge` or `enqueuePullRequest`, a query from a file (`-F query=@f`, `--input`) or a non-literal field: `deny`.
- `gh api` POST to `repos/o/r/merges`: `deny`, branch merges are not gated.
- A gh alias (map from `gh alias list`): its expansion with `$N` filled in. An unknown gh command and no map: `merge` of the current PR.
- A merge whose target, repo or subcommand is not literal (`$N`, `$(...)`, `xargs`): `deny`.
- `sh -c`, `bash -c`, `eval` with a literal script: the script's result. Non-literal: `deny`.

Commands are found inside `;`, `&&`, `||`, `|`, `&`, newlines, `( )`, `{ }`, `$( )`, backticks, `<( )`, after `VAR=x`, `if`/`then`/`do`, and behind `env`, `command`, `exec`, `nohup`, `time`, `nice`, `timeout`, `sudo`, `xargs`. Quotes are removed as bash does (`g'h' pr merge` is a merge). Here-document bodies and comments are data. Other commands (`git merge gh-pages`, `echo gh pr merge`) are `none`.

Limit: a command name in a variable (`$GH pr merge`) or a script file is not followed. The `crew-deps` required check covers those on the server.

## `gate(pr, states)`

- No state block: allow.
- Unreadable block, or a `depends-on` value the parser skipped: deny (fail closed).
- Every dependency, same-repo or cross-repo: `merged` allows; `open` denies; `closed` denies with "dependency closed"; no state given denies as unknown.
