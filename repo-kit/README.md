# Repo kit

These files are opt-in; the crew-net client does not depend on them.

- `workflows/crew-deps.yml` checks same-repo `depends-on` PRs on every PR,
  including drafts and body edits, and on `merge_group` for a merge queue.
  Missing, closed-unmerged, or unreadable PRs fail the check, and so does a
  `depends-on` value that is not a PR reference. Cross-repo references are
  reported but not enforced.
- `workflows/crew-deps-rerun.yml` reruns the latest check on open dependent PRs
  when a dependency merges. Inspect this workflow for errors; if no matching run
  exists or rerun fails, manually rerun the dependent's latest check.
- `scripts/crew-deps.mjs` is the dependency-free reader and GitHub API client
  used by both workflows. It reads the unversioned block and the old
  `<!-- crew-net v1 -->` block (`lead` is ignored). It fails closed on a block
  that does not close, that holds a second `<!-- crew-net` or a nested `<!--`,
  and on a `depends-on` that is not on a line of its own; in the rerun workflow an unreadable block fails the job.
- `snippets/draft-gate.md` shows how to skip expensive jobs on draft PRs.

## Adoption

Copy both workflows to `.github/workflows/` and the script to
`.github/scripts/crew-deps.mjs` on the default branch. Require the `crew-deps`
job in branch protection or a ruleset. The client merge gate is a convenience;
only a correctly configured required server-side check enforces this ordering.

The check reads the script from the PR's base revision, not the PR head. Protect
workflow and script changes with repository rules and trusted reviews: anyone
who can alter or bypass the required check can defeat it. GitHub's fork PR token
restrictions may prevent the rerun workflow from writing Actions; if so, rerun
checks manually or use a trusted GitHub App. API failures fail the check.

With a merge queue, `crew-deps.yml` also runs on `merge_group`. It takes the PR
number from the queue branch name (`gh-readonly-queue/<base>/pr-<N>-<sha>`),
reads that PR's body from the API and checks it as above. The branch name holds
one PR number, so with a queue group size above 1 only that PR is checked
again; the other PRs in the group passed the `pull_request` check to enter the
queue. A dependency queued ahead of its dependent has not merged yet, so the
dependent's queue check fails; queue a dependent only after its dependency has
merged. Do not change `depends-on` while a PR is queued.
