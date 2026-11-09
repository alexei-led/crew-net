# Repo kit

The files here are opt-in. The crew-net client does not need them.

- `workflows/crew-deps.yml` checks the same-repo `depends-on` PRs of every PR. It runs
  on drafts and body edits, and on `merge_group` for a merge queue. The check fails
  when a PR is missing, closed without merge, or unreadable. It also fails on a
  `depends-on` value that is not a PR reference. Cross-repo references are reported,
  not enforced.
- `workflows/crew-deps-rerun.yml` reruns the latest check of the open dependent PRs
  when a dependency merges. If no matching run exists, or the rerun fails, rerun the
  dependent's latest check by hand.
- `scripts/crew-deps.mjs` is the dependency-free reader and GitHub API client. Both
  workflows use it. It reads the current state block and the old `<!-- crew-net v1 -->`
  block. `lead` is ignored. It fails closed in three cases. The first is a block that does
  not close. The second is a second `<!-- crew-net` or a nested `<!--`. The third is a
  `depends-on` that is not on a line of its own. In the rerun workflow, an unreadable
  block fails the job.
- `snippets/draft-gate.md` shows how to skip expensive jobs on draft PRs.

## Adopt

1. Copy both workflows to `.github/workflows/`.
2. Copy the script to `.github/scripts/crew-deps.mjs`.
3. Do this on the default branch.
4. Require the `crew-deps` job in branch protection or a ruleset.

The client merge gate is a convenience. Only a correctly configured required check
on the server enforces the order.

The check reads the script from the base revision of the PR, not from its head.
Protect workflow and script changes with repository rules and trusted reviewers.
Anyone who can change or bypass the required check can defeat it.

GitHub's token limits on forked PRs can stop the rerun workflow from writing to
Actions. If so, rerun the checks by hand, or use a trusted GitHub App. API failures
fail the check.

With a merge queue, `crew-deps.yml` also runs on `merge_group`. It takes the PR number
from the queue branch name (`gh-readonly-queue/<base>/pr-<N>-<sha>`). It reads that PR
body from the API, then checks it as above. The branch name holds one PR number. With
a queue group size above 1, only that PR is checked again. The other PRs in the group
passed the `pull_request` check when they entered the queue.

A dependency that is queued ahead of its dependent has not merged yet. So the
dependent's queue check fails. Queue a dependent only after its dependency has merged.
Do not change `depends-on` while a PR is queued.
