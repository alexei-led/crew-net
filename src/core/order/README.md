# order

The client merge gate (design §11, §12). Pure. The caller (`crew-net gate`) reads GitHub; these functions decide.

1. `detectMerge(command, { aliases? }) → none | merge(targets) | deny(reason)` reads a Bash command line.
2. For each target, the caller resolves the PR (`repo` missing: the repo of the Bash tool's cwd at call time; `pr` and `branch` missing: the PR of the current branch), reads its body, calls `dependencies(pr)` to learn which PRs to read, reads their state, and calls `gate(pr, states)`.

## `detectMerge`

- `gh pr merge [N|URL|branch]`, any flag order, `--auto`, `gh pr -R o/r merge`: `merge` with `repo`, `pr` or `branch`.
- `gh pr merge --disable-auto`: `none`, it removes risk.
- `gh api` to `repos/o/r/pulls/N/merge` with a non-GET method, a body or a method override: `merge`.
- `gh api graphql` (or `api/graphql` on GHES) with `mergePullRequest`, `enablePullRequestAutoMerge` or `enqueuePullRequest`, a query from a file (`-F query=@f`, `--input`) or a non-literal field: `deny`.
- `gh api` POST to `repos/o/r/merges`: `deny`, branch merges are not gated.
- A gh alias (map from `gh alias list`): its expansion with `$N` filled in. An unknown gh command and no map: `merge` of the current PR.
- A merge whose target, repo, command or subcommand is not literal (`$N`, `$(...)`, `xargs`, `find -exec ... {}`): `deny`.
- A merge without `-R` or a URL on a line that runs `cd`/`pushd`/`popd`, sets `GH_REPO`/`GH_HOST` or uses `env -C`: `deny`, the cwd repo is not the target.
- `sh -c`, `bash -c`, `eval` with a literal script: the script's result. Non-literal, or a shell reading stdin (`echo ... | bash`, `bash <<EOF`): `deny`.

Short flag clusters are read as gh reads them (`-iXPUT`, `-sR o/r`). Commands are found inside `;`, `&&`, `||`, `|`, `&`, newlines, `( )`, `{ }`, `$( )`, backticks, `<( )`, after `VAR=x`, `if`/`then`/`do`, and `${...:-...}`, unquoted here-documents, and behind `env`, `command`, `builtin`, `exec`, `nohup`, `time`, `nice`, `timeout`, `sudo`, `xargs`, `stdbuf`, `caffeinate`, `coproc`, `find -exec`. Quotes are removed as bash does (`g'h' pr merge` is a merge). Quoted here-document bodies and comments are data. Other commands (`git merge gh-pages`, `echo gh pr merge`) are `none`.

Limits: a command name in a variable (`$GH pr merge`), a script file, and moving the base branch directly (`git push origin HEAD:main`, a ref PATCH) are not detected. The `crew-deps` required check covers those on the server.

## `gate(pr, states)`

- No state block: allow.
- Unreadable block, or a `depends-on` value the parser skipped: deny (fail closed).
- Every dependency, same-repo or cross-repo: `merged` allows; `open` denies; `closed` denies with "dependency closed"; no state given denies as unknown. Two states for one dependency: the less merged one counts.
