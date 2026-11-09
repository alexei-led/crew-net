# Releasing crew-net

How a release works, what the workflow checks, and what to do when it fails.
The flow follows the other projects under `~/Workspace`: agentbundler and
pumba for the tag and CI gates, cc-thingz and codex-router for version parity
and CHANGELOG-driven notes.

## How users get a release

Users install the plugin from this repo's marketplace
(`claude plugin marketplace add alexei-led/crew-net`). The plugin ships built:
`plugin/bin/crew-net` and the hook and mod bundles are committed, and
`make plugin-fresh` fails CI when they are older than the sources. Plugins that
set a `version` are updated by Claude Code when it changes (the other plugin
projects here rely on this; confirm it on the first release, see "After a
release"), so **merging the `release X.Y.Z` commit is what ships a release**. The tag and the GitHub
release record it, add `crew-net.js` and `checksums.txt` for Pi and Codex
users, and verify it.

One version lives in four places: `package.json`,
`plugin/.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` and
`VERSION` in `src/cli/main.ts`. `scripts/release.ts check` fails when any of
them, the bundled CLI, or the CHANGELOG disagrees with the version.

## Release steps

Releases come from `main`. Run these yourself; nothing here is automatic
except the workflow after step 5.

1. **Notes.** Write the section in `CHANGELOG.md` as
   `## X.Y.Z (unreleased)`. Users read it as the release body.
2. **Prepare.** `bun scripts/release.ts prepare X.Y.Z` on a clean, current
   `main`. It dates the CHANGELOG section, sets the version everywhere,
   rebuilds the bundles with `make plugin`, runs the checks above, and commits
   `release X.Y.Z` on the branch `release/vX.Y.Z`. It refuses a tag that
   already exists: tags are never moved.
3. **Check.** `make check && make plugin-test`. `plugin-test` runs
   `claude plugin validate` and `claude plugin test` and prints SKIPPED when
   `claude` is not on `PATH`. CI does not run these, so run them before the PR.
4. **Merge.** Push the branch, open the PR, wait for CI, squash-merge, then
   `git switch main && git pull --ff-only`.
5. **Tag.** `git tag -a vX.Y.Z -m "crew-net X.Y.Z" && git push origin vX.Y.Z`.
   Pushing the tag publishes. The tag must be annotated and point at the merge
   commit on `main`.

## What the Release workflow does

`.github/workflows/release.yml`, on a pushed `v*` tag:

| Job        | Checks or does                                                                                                                                                                               |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `validate` | Tag is `vMAJOR.MINOR.PATCH`, annotated, points at the triggering commit, which is on `main`. CI (`make check`, `make plugin-fresh`) passed on that exact commit. `scripts/release.ts check`. |
| `release`  | Copies the committed `plugin/bin/crew-net` to `crew-net.js`, writes `checksums.txt`, takes the notes from the CHANGELOG section, runs `gh release create --verify-tag`.                      |
| `verify`   | Downloads the release, checks the checksum, runs `crew-net.js --version` against the tag, and confirms the release is not a draft.                                                           |

Only `release` has `contents: write`. Actions are pinned by SHA, and no job
restores a cache (a poisoned cache could reach a release). Runs for one tag
never overlap and are never cancelled.

## When something fails

- **`validate` fails on CI for the commit.** The tag was pushed before CI
  finished on `main`. Wait for CI, then re-run the failed workflow run.
- **`validate` fails on versions or the CHANGELOG.** The release commit is
  wrong. Do not move the tag. Fix on `main` with a new commit and release the next
  patch version. Exception: a tag that never produced a GitHub release may be
  deleted (`git push origin :refs/tags/vX.Y.Z`) and re-created on the fixed
  commit.
- **`release` fails after `validate` passed.** Re-run the workflow run. If a
  release already exists, delete it first (`gh release delete vX.Y.Z`), never
  edit assets by hand.
- **`verify` fails.** The release exists but is bad. Mark it as a draft
  (`gh release edit vX.Y.Z --draft`), fix forward with a patch release, and say
  why in that release's notes.

## After a release

- `gh run list --workflow Release --limit 1` is green and
  `gh release view vX.Y.Z` lists `crew-net.js` and `checksums.txt`.
- On a clean `CLAUDE_CONFIG_DIR`: install the plugin from the marketplace and
  run `crew-net doctor`. In an existing install: `claude plugin update crew-net`
  picks up the new version.

## Not done, on purpose

- No npm publish: the package is `private`. Publishing needs trusted
  publishing with provenance as in pi-model-router. Add it when a Pi package
  is wanted.
- No signing or attestations: none of the other projects have them for
  binaries, and GitHub documents attestations for private repos only on
  Enterprise Cloud (not checked for this repo). Checksums
  catch a corrupted download; they do not prove who built it.
- No automatic version bump or tag push: the release is a human decision.
