# Changelog

## 0.1.1 (unreleased)

### Changed

- The plugin has an icon for the Claude Code plugin catalog. No behaviour change.

## 0.1.0 - 2026-11-09

First release. A Claude Code plugin with the `crew-net` CLI: coding-agent
sessions on different laptops coordinate through GitHub alone.

### Added

- **Digest** at session start, after `/clear` and on resume: your PRs and
  their dependencies, others' open PRs and pushed branches with findings,
  what merged since you branched, inbox and open requests. `crew-net` and
  `/crew` print it.
- **Radar** after each `git fetch` (5 min): `conflict` (`git merge-tree`),
  `overlap`, `order` (contract producer vs consumer paths, also across
  watched repos) and `stale`. Each finding is reported once per file set.
- **`crew-net who [paths]`**: open work in watched repos that touches paths.
- **Requests**: `ask`, `request review|fix|bug`, `reply` with `--accept`,
  `--done`, `--decline`. Plain GitHub comments with an `@mention` and a hidden
  marker; tracked in `crew-net inbox` until answered. Closing keywords are
  refused in everything crew-net writes. Write budget: 20 a minute, 200 an
  hour.
- **Inbox from GitHub notifications** for every repo, plus comments and
  reviews by people on your PRs, delivered as information.
- **Delivery in Claude Code**: the band shows items at once; they reach the
  model with your next prompt, framed as coming from another developer. An
  idle session wakes for a direct request and may only read and reply (tool
  gate). One wake per 10 minutes; `autoWake: off` disables it.
- **Merge order**: `crew-net dep add|rm`, `crew-net state`; `unblocked`,
  `dependency closed` and `waits on you` items; auto-merge turned off while a
  dependency is open; a `PreToolUse` merge gate that denies `gh pr merge`
  (including `--auto`) and merge API calls while a dependency is open, and
  fails closed.
- **Repo kit**: `crew-net init` writes `.github/crew-net.yml` (contracts,
  deploy branches, bots, early drafts); `--deps` adds the `crew-deps`
  required-check workflows, with `merge_group` support.
- **`crew-net doctor`**: gh token, GitHub access, SSO, MDM
  `allowManagedHooksOnly`, plugin, merge gate, repo config, draft gate,
  crew-deps; the adoption level reached and the next step.
- **`crew-net stats`**: findings, items, deliveries, wakes, blocked merges and
  requests per repo and week, from a local event log.
- **No daemon**: short locked `crew-net sync` passes triggered by the plugin's
  watcher (every 30 s while a session is open) and hooks; ETag and
  `If-Modified-Since` polling. Measured about 120 primary requests an hour for
  two sessions in two repos.

### Fixed before release (found in end-to-end runs)

- The local store prune never ran; it now runs daily from sync. Review
  cursors dedupe by time and id, so pruned reviews never arrive again (#18).
- Squash-merged branches left on origin no longer show as bare work with
  false conflicts (#19).
- `stats` counts blocked merges per repo; clearer `doctor` and error
  messages; the built-in contract is named `schema` (#20).
- A worker session (`CREW_NET_ROLE=worker`) can no longer post (#21).

### Known limits

- Claude Code only. Pi and Codex get the CLI and an `AGENTS.md` snippet; their
  adapters come later.
- No sender-side command to close a request; requests in unwatched repos never
  close on their own.
- Cross-repo `order` findings need the consumer repo to be watched.
- The client gate covers agents with the plugin; a direct push to the deploy
  branch or a merge in the web UI is stopped only by a server-side rule.
- `agents-merge` (repo) and `agentsMerge` (developer) are read but not used.
