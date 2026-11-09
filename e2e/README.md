# End-to-end tests

Two kinds:

- `*.test.ts` run with `make test`: the architecture gates (`fitness`), one
  version across CLI, package, plugin and marketplace (`release`), and
  `doctor` on a planted MDM plist (`doctor-mdm`, macOS only).
- `laptops/`: the cross-machine scenarios of [plan.md](../docs/plan.md),
  run by hand against `alexei-led/crew-net-sandbox`. They write to that repo
  only.

## Simulated laptops

Each laptop is a clone of the sandbox with its own `XDG_STATE_HOME`,
`XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR` and `GH_CONFIG_DIR`.

```sh
make build
W=$TMPDIR/crew-e2e CN=$PWD/dist/crew-net.js
export W CN
source e2e/laptops/env.sh
setup a; setup b
pretend a maria-sim          # one GitHub account: laptop a acts as another login
git -C "$W/a/repo" config user.email maria-sim@users.noreply.github.com
cn a session beat --session sess-a --pid "$(sleep 20000 & echo $!)"
cn b session beat --session sess-b --pid "$(sleep 20000 & echo $!)"
cn a sync --once; cn a        # digest as laptop a
```

| Script         | Does                                                                 |
| -------------- | -------------------------------------------------------------------- |
| `env.sh`       | `setup`, `lap` (run in a laptop's clone), `cn` (crew-net), `pretend` |
| `watch.mjs`    | Runs `crew-net watch` for a session, prints events, SIGKILLs it      |
| `killsync.mjs` | Starts `crew-net sync --once` and SIGKILLs it after N ms             |
| `budget.mjs`   | Two watchers on laptop `d` (two repos), every `fetch` logged         |
| `count.mjs`    | `--import` preload for `budget.mjs`: method, path, status per fetch  |

One account plays two developers: `pretend` plants laptop A's cached login, so
B's PRs are "someone else's" on A, and A's commits use a
`maria-sim@users.noreply.github.com` address, so B sees A's bare branch as
maria-sim's. What needs a second real account (GitHub sends no notification
for your own comments) is marked `[2]` and skipped.

## Results, 2026-11-09

crew-net 0.1.0 (main at #20), Claude Code 2.1.319, macOS, sandbox PRs #7-#9.

| #   | Scenario                                                       | Result | Evidence                                                                                                                                                                                                                                                                                                      |
| --- | -------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Digest shows the other side's PR and bare branch               | pass   | A: `Others  alexei-led #7  open  2 files  ⚠ conflicts…`. B: `Others  maria-sim e2e-a-readme  no PR, pushed <1 min ago`. Through Claude Code: `claude -p` in B's clone quotes the `<crew-net-digest>` that `SessionStart` added (245 ms). After `/clear`: `plugin/tests/watcher.test.ts` (no `/clear` in `-p`) |
| 1a  | Plugin installs from the local marketplace on a clean config   | pass   | `claude plugin marketplace add <repo>`, `claude plugin install crew-net@crew-net` into an empty `CLAUDE_CONFIG_DIR`; debug log: `SessionStart … provided additionalContext (689 chars)`, mod `crew-net@crew-net loaded`; `doctor` reaches level 0                                                             |
| 2   | Conflict within one fetch cycle, on each side                  | pass   | Both sides edit `README.md` line 1 and push: the first sync on each laptop reports `⚠ conflicts with … README.md`                                                                                                                                                                                             |
| 3   | `[2]` Ask and reply, band, inject, wake                        | skip   | Needs a second account. Covered by `plugin/tests/delivery.test.ts`. Posting works live: `ask @maria-sim --on #7` posted with the marker and shows under "Your open requests"; `fixes #3` refused                                                                                                              |
| 4   | `[2]` Two sessions of one developer: one delivery              | pass   | Run with findings instead of messages: a second session `sess-b2` in the same clone got no item; `delivered/` holds one claim per item                                                                                                                                                                        |
| 5   | `depends-on` blocks `gh pr merge` and `--auto`; `unblocked`    | pass   | `dep add #8` on #7; `gate` and the installed `PreToolUse` hook deny `gh pr merge 7 --squash`, `gh pr merge --auto --squash 7` and a bare `gh pr merge` on the branch; allow `#8`. After #8 merged: `allow` at once, `unblocked` item on the next 60 s dependency poll                                         |
| 5a  | Auto-merge turned off when a dependency is added               | skip   | The sandbox repo has auto-merge disabled. Covered by app tests                                                                                                                                                                                                                                                |
| 6   | `[2]` A peer comment asking to merge or edit causes only reply | skip   | Needs a second account. Covered by `plugin/tests/gate.test.ts`                                                                                                                                                                                                                                                |
| 7   | Killed watcher and killed sync: no duplicate delivery          | pass   | Watcher SIGKILLed after 2 items; restart replays the same 2 ids to the same session (the mod dedupes, `watcher.test.ts`), claims unchanged. Sync SIGKILLed mid-run holding a lock: the next run took the stale lock, ran every job, inbox 2 → 3 with the third a new finding                                  |
| 8   | Token swap: one re-read, then a clear error                    | pass   | Invalid token in `GH_CONFIG_DIR`: a `gh` shim logged exactly 2 `gh auth token` calls; `sync`, `ask` and `doctor` say `GitHub authentication failed for github.com. Run: gh auth refresh --hostname github.com`; `gate` denies (fail closed)                                                                   |
| 8a  | `doctor` flags a planted `allowManagedHooksOnly`               | pass   | `e2e/doctor-mdm.test.ts`: real binary plist, real `plutil`. The CLI reads only system paths, which need root to plant                                                                                                                                                                                         |
| 9   | One hour, two sessions, two repos: under 400 primary requests  | pass   | 19.5 min, sandbox + crew-net clones: 83 requests, 40 with `200` and 43 `304`. About 123 primary an hour, including start-up reads and real PR activity                                                                                                                                                        |
| -   | `stale` and "merged since you branched"                        | pass   | #9 merged a file A changes: `Merged since you branched: #9 touches web/src/api/client.ts (yours)` and a `stale` item                                                                                                                                                                                          |

`claude plugin test plugin`: 33 pass (run by `make check`, not in CI).

Bugs found and fixed: #18 (store prune never ran), #19 (squash-merged
branches left on origin showed as bare work with false conflicts), #20
(blocked merges missing from per-repo stats; error messages), #21 (a
worker session could post).
