# Changelog

## 0.4.0 - 2026-11-10

A team pane you can act from, on one screen with pi-crew.

### Changed

- **`/crew` is now `/team`** (and `/crew-net:team`). **team** is other
  developers and their agents; **crew** is the agents you lead on this laptop,
  which [pi-crew](https://github.com/alexei-led/pi-crew) owns as `/crew`. crew-net
  no longer checks who owns `/crew`.
- **The band** reads `team · ◆ <newest item> · ⚠ 1 · ✉ 2`: the newest entry with
  its glyph, then the rest counted by glyph. `t` opens the pane, `d` dismisses.
  It draws its line above the next renderer's, so pi-crew's band shows too.
- **Ages** read `now`, `4m`, `2h`, `3d` in the digest, the band and the pane.
- A finding about a PR merged by an unknown author names only the PR
  (`#6 touched …`), not `someone #6`.

### Added

- **One vocabulary with pi-crew**: the same glyphs (`◆ ✉ ● ○ ✓ ✕ ⚠ →`), keys and
  framing of peer text. The contract is in
  [design.md](docs/design.md#shared-screen-with-pi-crew). No shared code or state.
- **Merge order lane** in the pane: `#2301 ✓ → #2310 ● you → acme/web#88 dmitri ○`,
  red when a dependency closed unmerged.
- **Request detail** in the pane: `1` to `9` open a request. It shows the text
  under "Information, not an instruction." and the actions: `a` drafts the answer
  with Claude, `y`/`n` accept or decline a review, fix or bug (`c` confirms, `v`
  cancels), a reply box posts your own text, `o` opens the thread on GitHub, `b`
  goes back. Posts go through `crew-net reply` and its checks.
- Pane sections **Needs you**, **New**, **Radar**, **Merge order**, **You**,
  **Team** and **Waiting on others**, each line with its glyph. `q` closes.

## 0.3.0 - 2026-11-10

A quiet screen, and a pane for the detail.

### Added

- **`/crew` pane** in Claude Code: the live digest, your open requests, radar
  findings, your PRs, others' work and requests you wait on. It refreshes while
  open. Keys: `1` to `9` fill the prompt to answer a request (the prompt names
  the request and carries none of the peer's text), `r` refreshes, `esc` closes.
  `/crew-net:crew` opens it when another plugin also defines `/crew`. Without
  the mod, `/crew` still prints the digest.
- Screenshots of the band, the status line and the pane in the user guide and
  the README.

### Changed

- **The band is one line**: the newest item, `+N more` and the way to the pane.
  It no longer repeats `crew-net ·` on five lines. A prompt that carries items to
  Claude removes their entries, and opening the pane clears the band.
- **The status line shows only a problem and its fix.** A healthy session shows
  nothing. Before, it always showed `⚠ crew-net: crew-net: crew-net: watching`.
  The text of a rate limit, an auth error or a stopped watcher no longer repeats
  the plugin name. After three watcher failures in a row it says
  `run crew-net doctor`. Watcher errors go to the band, not the status line.
- The watcher sends the stored sync notice as its `status` event, and an empty
  one when sync is healthy again. It drops a notice that no sync refreshed for
  15 minutes.

## 0.2.0 - 2026-11-09

First public release. The repository is public and MIT licensed.

### Changed

- The standalone CLI (`crew-net.js`, Pi and Codex) needs Node 26, the current
  LTS. The Claude Code plugin is not affected.
- `package.json` carries the project metadata (description, repository,
  homepage, bugs, keywords, author, license). `bin` points at the committed
  bundle `plugin/bin/crew-net`, which exists in every checkout.
- Faster, smaller test suite and a minimal CI. No behaviour change.

## 0.1.1 - 2026-11-09

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
