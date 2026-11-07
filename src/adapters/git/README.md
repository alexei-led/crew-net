# Git adapter

`GitAdapter` implements `GitPort` using the Git executable in a repository
specified at construction. Git 2.38 or later is required for `merge-tree
--write-tree`. The runner can be injected for tests.

Commands: `git fetch --prune origin`, `git worktree list --porcelain -z`,
`git merge-tree --write-tree --name-only --no-messages -z -- <a> <b>`, and
`git diff --name-only -z --no-ext-diff --no-textconv --end-of-options
<base>...<a> --`. Paths are NUL-delimited, so names with whitespace and
newlines are preserved. `mergeTree` returns a clean flag and conflict paths;
Git failures throw `GitCommandError` with the arguments and stderr.
