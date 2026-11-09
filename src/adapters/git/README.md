# Git adapter

`new GitAdapter(repoDir, runner?)` implements `GitPort` with the `git` binary.
Git 2.38 or later is required for `merge-tree --write-tree`.

| Method                     | Command                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `fetch()`                  | `git fetch --prune origin`                                                                 |
| `worktreeBranches()`       | `git worktree list --porcelain -z` → `{ path, branch }`, detached and bare skipped         |
| `remoteBranches()`         | `git for-each-ref refs/remotes/origin/` → `{ name, lastCommitAt, authorEmail, loginHint }` |
| `mergeBase(a, b)`          | `git merge-base`; `undefined` when the refs share no history                               |
| `mergeTree(a, b)`          | `git merge-tree --write-tree --name-only --no-messages -z`                                 |
| `changedFiles(base, head)` | `git diff --name-only -z --no-ext-diff --no-textconv <base>...<head>`                      |

- `remoteBranches` skips the `origin/HEAD` symref. `loginHint` is the login in
  a `[id+]login@users.noreply.<host>` author email, else `null`; it is a hint
  for a bare branch's owner (design §10), not an identity.
- Timeouts: `fetch` 120 s, every other command 30 s. A killed command throws
  `GitCommandError` with "timed out".
- Git never prompts: `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS` removed from the
  environment.
- `GitCommandError` carries the args, stderr and exit code. URL userinfo and
  GitHub token shapes (`ghp_…`, `ghs_…`, `github_pat_…`) are redacted from the
  message and stderr; the underlying error is not kept as `cause`.
- Paths are NUL-delimited, so names with whitespace and newlines survive.

The runner `(repoDir, args, timeoutMs)` can be injected for tests.
