# Repo kit

These files are opt-in; the crew-net client does not depend on them.

- `workflows/crew-deps.yml` checks same-repo `depends-on` PRs on every PR,
  including drafts and body edits. Missing, closed-unmerged, or unreadable PRs
  fail the check. Cross-repo references are reported but not enforced.
- `workflows/crew-deps-rerun.yml` reruns the latest check on open dependent PRs
  when a dependency merges. Inspect this workflow for errors; if no matching run
  exists or rerun fails, manually rerun the dependent's latest check.
- `scripts/crew-deps.mjs` is the dependency-free reader and GitHub API client
  used by both workflows. It fails closed on malformed or unsupported blocks.
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

For a merge queue, required workflows also need a `merge_group` trigger and a
queue-aware implementation that checks each queued PR. These templates handle
`pull_request` only; do not require them on a merge queue unchanged. Do not
change `depends-on` while a PR is queued.
