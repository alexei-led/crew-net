# app

Use cases of `crew-net`: the sync jobs, the read commands, the session
registry and the watcher. Depends on `core`, `protocol` and `ports` only;
`cli` and `watch` build the [`AppPorts`](ports.ts) from adapters.

## Sync (design §8.2)

`runSync(ports, here?)` runs every due job once, each through
`store.jobs.run(name, interval, fn)`: a job another process runs is `busy`,
one that ran within its interval on this laptop is `fresh`. A failing job is
logged (`sync-error` in `events.ndjson`) and the others still run; after a
401 or SSO error the host's other GitHub jobs are skipped. A rate limit
becomes the notice `crew-net: rate-limited until HH:MM` in `sync:status`.

| Job             | Name               | Interval                       | Does                                                                                                                   |
| --------------- | ------------------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Inbox           | `inbox:<host>`     | 60 s, or `X-Poll-Interval`     | Notifications since the cursor; each kept thread's new comments (and reviews on PRs) become items                      |
| Repo state      | `repo:<host/o/r>`  | 60 s active, 15 min watched    | Open PRs with parsed state blocks → `snapshot.json`                                                                    |
| Fetch and radar | `radar:<host/o/r>` | 5 min, active only             | `git fetch`, my work vs others' PRs and bare branches (same base) → findings; new ones become items, then `radar.json` |
| Dependencies    | `deps`             | 5 min; 60 s while I am blocked | Reads each dependency of my PRs; `auto-merge-off`, `dependency-closed`, `unblocked`, `waits-on-you` items              |

- **Scope.** Active: the repo of a live session heartbeat, plus the
  command's own working copy. Watched: a session there in the last 14 days
  (kv `watched`), plus `watch` in `config.json`. `mute` drops a repo.
- **Durability.** Every job writes its items before it moves what records
  progress: comment and review cursors, then the notification cursor; the
  finding items, then `radar.json`; the dependency items, then
  `deps:state`. A killed sync replays from the old position; `putItem`
  skips an id already in the inbox.
- **Notification cursor.** Set to the newest thread `updatedAt` GitHub
  returned, never the laptop clock. A thread that fails holds the cursor
  just before it (and pins its comment cursor) so the next pass retries it;
  after 3 failures in a row it is skipped (deleted issue, lost access) so
  the host's inbox does not stall. Rate limits and auth errors stop the
  pass with the cursor unmoved.
- **Messages.** A comment with a crew marker becomes `ask`, `review`, `fix`,
  `bug` or `info`; `addressed` when its first line mentions me. A `reply`
  to one of my outbox requests from its recipient moves the request
  (`accepted` → in progress, else closed) after the item is stored. Other
  comments are `comment`, reviews `pr-review`. Requests carry `msgId`, the
  marker id `crew-net reply` answers with `re=`. My own comments, GitHub Apps
  (`*[bot]`) and the built-in bots are skipped.
- **Radar.** Mine: the branches of this clone's worktrees (not a deploy
  branch, not someone else's PR) and my open PRs. Theirs: others' open PRs
  on origin and remote branches without a PR pushed within 3 days whose
  commit email names a login. `merge-tree` runs only for pairs that change
  a common file. Fork PRs (head repo ≠ repo) are left out, and a colleague's
  branch I have checked out counts as mine only. `stale` comes from first-parent history since my fork
  point; a commit names its PR by `(#N)` or `Merge pull request #N`. The
  repo config is `.github/crew-net.yml` on `origin/HEAD` (else `main`,
  `master`). Cross-repo `order` pairs are not built yet: they need the
  changed files of PRs in repos without a clone. Bare branches are diffed
  against the default base; a merge commit names whoever merged it.
- **Item ids:** `comment:<host>/<o>/<r>#<n>:<id>`, `review:…`,
  `finding:<key>`, `automerge-off:…`, `dep-closed:…`, `unblocked:…`,
  `waits:…`.

## Reads (no network)

| Function                          | For                                                                             |
| --------------------------------- | ------------------------------------------------------------------------------- |
| `buildDigest(ports, ref, branch)` | `crew-net`: `core/digest` input from snapshot, radar, deps, inbox and outbox    |
| `who(store, repos, paths)`        | `crew-net who`: others' PRs and bare branches whose scope or diff touches paths |
| `inboxView(store, now)`           | `crew-net inbox`: unread items, unanswered requests to me, my open requests     |
| `stats(events)`                   | `crew-net stats`: per repo and ISO week                                         |
| `doctor(ports, probes, here)`     | `crew-net doctor`: checks, adoption level and next step (one live `GET /user`)  |

A digest is `stale` when the repo has no snapshot or it is older than 3
minutes. `crew-net reply` sets kv `replied:<item-id>`; such a request leaves
"requests to you". Peer text in `inbox` and `who` output goes through
`core/digest` `clean` (quotes, control and bidi characters).

## Sessions and watcher

`beat` writes a heartbeat with the worktree root, branch and repo
(`host/owner/repo`), keeps the last prompt time unless the beat is a prompt,
and marks the repo watched. `end` removes it. `Watcher` (see
[watch](../watch/README.md)) heartbeats, syncs, routes unclaimed items with
`core/routing`, claims them and emits them.

```sh
bun test src/app
```
