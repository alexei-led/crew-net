# order

The client merge gate (design §11, §12). Pure. The caller (`crew-net gate`) reads GitHub; these functions decide.

1. `detectMerge(command, { aliases? }) → none | merge(targets) | deny(reason)` reads a Bash command line.
2. For each target, the caller resolves the PR (`host` missing: gh's default host for a named repo, the remote's for the default repo; `repo` missing: gh's default repo of the Bash tool's cwd at call time; `pr` and `branch` missing: the PR of the current branch), reads its body, calls `dependencies(pr)` to learn which PRs to read, reads their state, and calls `gate(pr, states)`.

## `detectMerge`

- `gh pr merge [N|URL|branch]`, any flag order, `--auto`, `gh pr -R [host/]o/r merge`: `merge` with `host` (from `-R host/o/r` or the URL, lower case), `repo`, `pr` or `branch`. `gh api` targets take the host from `--hostname` or a full API URL (`api.github.com` is github.com, `api.<x>.ghe.com` is `<x>.ghe.com`).
- Flags before the command (`gh -R x pr merge`, `gh -X PUT api ...`) count as the command's.
- `gh api` merges through `repos/{owner}/{repo}/...`: `deny`; gh fills those by its own rules, so the repo must be named.
- A host with a port (`-R host:8443/o/r`, a URL with a port): `deny`.
- A merge whose host is not named on a line that may set `GH_HOST` (`GH_HOST=`/`+=`, any word naming `GH_HOST` or `GH_CONFIG_DIR`, `HOME=`, `XDG_CONFIG_HOME=`, `source`, `.`, `set -a`): `deny`; the gate cannot tell which value reaches gh.
- `gh pr merge --disable-auto`: `none`, it removes risk.
- `gh api` to `repos/o/r/pulls/N/merge` with a non-GET method, a body or a method override: `merge`.
- `gh api graphql` (or `api/graphql` on GHES) with `mergePullRequest`, `enablePullRequestAutoMerge` or `enqueuePullRequest`, a query from a file (`-F query=@f`, `--input`) or a non-literal field: `deny`.
- `gh api` POST to `repos/o/r/merges`: `deny`, branch merges are not gated.
- A gh alias (map from `gh alias list`): its expansion with `$N` filled in. An unknown gh command and no map: `merge` of the current PR.
- A merge whose target, repo, command or subcommand is not literal (`$N`, `$(...)`, `xargs`, `find -exec ... {}`): `deny`.
- A merge without `-R` or a URL on a line that runs `cd`/`pushd`/`popd`, uses `env -C`, names a `GH_HOST`/`GH_REPO`/`GH_CONFIG_DIR` or `GIT_DIR`/`GIT_WORK_TREE`/`GIT_COMMON_DIR`/`GIT_CONFIG*` variable, sets `HOME`/`XDG_CONFIG_HOME`, or runs `source`, `.` or `set -a`: `deny`, the cwd repo may not be the target.
- `sh -c`, `bash -c`, `eval` with a literal script: the script's result. Non-literal, or a shell reading stdin (`echo ... | bash`, `bash <<EOF`): `deny`.

Short flag clusters are read as gh reads them (`-iXPUT`, `-sR o/r`). Commands are found inside `;`, `&&`, `||`, `|`, `&`, newlines, `( )`, `{ }`, `$( )`, backticks, `<( )`, after `VAR=x`, `if`/`then`/`do`, and `${...:-...}`, unquoted here-documents, and behind `env`, `command`, `builtin`, `exec`, `nohup`, `time`, `nice`, `timeout`, `sudo`, `xargs`, `stdbuf`, `caffeinate`, `coproc`, `find -exec`. Quotes are removed as bash does (`g'h' pr merge` is a merge). Quoted here-document bodies and comments are data. Other commands (`git merge gh-pages`, `echo gh pr merge`) are `none`.

Limits: a command name in a variable (`$GH pr merge`), a script file, and moving the base branch directly (`git push origin HEAD:main`, a ref PATCH) are not detected. The `crew-deps` required check covers those on the server.

## `gate(pr, states)`

- No state block: allow.
- Unreadable block, or a `depends-on` value the parser skipped: deny (fail closed).
- Every dependency, same-repo or cross-repo: `merged` allows; `open` denies; `closed` denies with "dependency closed"; no state given denies as unknown. Two states for one dependency: the less merged one counts.
