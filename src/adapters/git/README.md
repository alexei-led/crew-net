# Git adapter

`new GitAdapter(repoDir, runner?)` implements `GitPort` with the `git` binary.
Git 2.38 or later is required for `merge-tree --write-tree`.

| Method                     | Command                                                                                                                          |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `fetch()`                  | `git fetch --prune origin`                                                                                                       |
| `checkout()`               | `git rev-parse --path-format=absolute --show-toplevel --git-common-dir`, `git symbolic-ref -q HEAD` → `{ root, clone, branch? }` |
| `worktreeBranches()`       | `git worktree list --porcelain -z` → `{ path, branch }`, detached and bare skipped                                               |
| `remoteBranches()`         | `git for-each-ref refs/remotes/origin/` → `{ name, lastCommitAt }`                                                               |
| `branchAuthor(base, tip)`  | `git log --first-parent --no-merges --max-count=1 base..tip` → `{ authorEmail, loginHint }`, `undefined` when none               |
| `mergeBase(a, b)`          | `git merge-base`; `undefined` when the refs share no history                                                                     |
| `mergeTree(a, b)`          | `git merge-tree --write-tree --name-only --no-messages -z`                                                                       |
| `showFile(ref, path)`      | `git show <ref>:<path>`; `undefined` when the ref or path is missing, an error otherwise                                         |
| `landed(from, to)`         | `git log --first-parent -m --name-only -z --max-count=100 from..to`: newest first, with paths and `loginHint`                    |
| `changedFiles(base, head)` | `git diff --name-only -z --no-ext-diff --no-textconv --no-renames <base>...<head>`: a rename lists old and new path              |

- `checkout` answers for the adapter's directory: a subdirectory or a
  symlinked path gives the real worktree root. `clone` is the parent of the
  git common dir (`<clone>/.git`), or the common dir itself for a bare clone;
  the same for every worktree of a clone. No `branch` on a
  detached HEAD.
- `remoteBranches` skips the `origin/HEAD` symref. `loginHint` is the login in
  a `[id+]login@users.noreply.<host>` author email, else `null`; it is a hint
  for a bare branch's owner (design §10), not an identity. `branchAuthor`
  skips merge commits, so merging the base into a branch does not make the
  merger its owner.
- Timeouts: `fetch` 120 s, every other command 30 s. A killed command throws
  `GitCommandError` with "timed out".
- Git never prompts for credentials: `GIT_ASKPASS=""` (so git does not fall
  back to `core.askPass` or `SSH_ASKPASS`), `SSH_ASKPASS` removed and
  `GIT_TERMINAL_PROMPT=0`. SSH passphrase prompts are not suppressed (that
  would override `core.sshCommand`); the timeout bounds them.
- `GitCommandError` carries the args, stderr and exit code. URL userinfo and
  GitHub token shapes (`ghp_…`, `ghs_…`, `github_pat_…`) are redacted from the
  message and stderr; the underlying error is not kept as `cause`.
- Paths are NUL-delimited, so names with whitespace and newlines survive.

The runner `(repoDir, args, timeoutMs)` can be injected for tests.
