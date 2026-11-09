# End-to-end tests

There are two kinds of test here.

- `*.test.ts` run with `make test`. They check the architecture rules (`fitness`),
  one version across the CLI, package, plugin and marketplace (`release`), and
  `doctor` with a planted MDM plist (`doctor-mdm`, macOS only).
- `laptops/` holds the cross-machine scenarios. You run them by hand against
  `alexei-led/crew-net-sandbox`. They write to that repo only.

## Run the laptop scenarios

Each simulated laptop is a clone of the sandbox. It has its own `XDG_STATE_HOME`,
`XDG_CONFIG_HOME`, `CLAUDE_CONFIG_DIR` and `GH_CONFIG_DIR`. The scripts read the
token from `GH_TOKEN`. `env.sh` sets it for each call. The scripts never copy gh's
config.

```sh
make build
W=$TMPDIR/crew-e2e CN=$PWD/dist/crew-net.js
export W CN
source e2e/laptops/env.sh
setup a; setup b
pretend a maria-sim          # one GitHub account plays a second developer
git -C "$W/a/repo" config user.email maria-sim@users.noreply.github.com
cn a session beat --session sess-a --pid "$(sleep 20000 & echo $!)"
cn b session beat --session sess-b --pid "$(sleep 20000 & echo $!)"
cn a sync --once; cn a        # digest as laptop a
teardown                      # run when finished: the inbox job reads the whole account
```

| Script         | Does                                                                     |
| -------------- | ------------------------------------------------------------------------ |
| `env.sh`       | Defines `setup`, `lap` (run in a laptop's clone), `cn` and `pretend`     |
| `watch.mjs`    | Runs `crew-net watch` for a session, prints its events, then SIGKILLs it |
| `killsync.mjs` | Starts `crew-net sync --once` and SIGKILLs it after N ms                 |
| `budget.mjs`   | Runs two watchers on laptop `d` (two repos) and logs each `fetch`        |
| `count.mjs`    | `--import` preload for `budget.mjs`: method, path and status per fetch   |

`pretend` makes one account act as two developers. Laptop A uses the login of
laptop B's cached credentials. A's commits use a `maria-sim@users.noreply.github.com`
address. Scenarios that need a second GitHub account are marked `[2]`. Run them
with a second account, or skip them. GitHub sends no notification for your own
comments.

## Results: release 0.1.0

crew-net 0.1.0 on `main` after #21. Claude Code 2.1.319, macOS. Sandbox PRs #7 to #9.

| #   | Scenario                                                     | Result | Note                                                                                 |
| --- | ------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------ |
| 1   | Digest shows the other side's PR and bare branch             | pass   | Through Claude Code, `SessionStart` adds the digest in 245 ms                        |
| 1a  | Plugin installs from the local marketplace on a clean config | pass   | `doctor` reaches level 0                                                             |
| 2   | Conflict appears within one fetch cycle, on each side        | pass   | Both sides edit `README.md` line 1 and push                                          |
| 3   | `[2]` Ask and reply: band, injection, wake                   | skip   | Covered by `plugin/tests/delivery.test.ts`. Posting works live                       |
| 4   | `[2]` Two sessions of one developer: one delivery            | pass   | A second session in the same clone gets no item. `delivered/` holds one claim each   |
| 5   | `depends-on` blocks `gh pr merge` and `--auto`; `unblocked`  | pass   | The hook denies three merge forms. After the dependency merges, `unblocked` arrives  |
| 5a  | Auto-merge turns off when a dependency is added              | skip   | The sandbox repo has auto-merge disabled. Covered by app tests                       |
| 6   | `[2]` A peer comment asks to merge or edit: only a reply     | skip   | Covered by `plugin/tests/gate.test.ts`                                               |
| 7   | Killed watcher and killed sync: no duplicate delivery        | pass   | A restarted watcher replays the same items. The stale lock is taken over             |
| 8   | Token swap: one re-read, then a clear error                  | pass   | Two `gh auth token` calls. `gate` denies (fail closed)                               |
| 8a  | `doctor` flags a planted `allowManagedHooksOnly`             | pass   | `e2e/doctor-mdm.test.ts`. The CLI reads only system paths, so a plant needs root     |
| 9   | Request budget under 400 an hour                             | pass   | Extrapolated: about 123 an hour from a 19.5 minute run. Not measured for a full hour |
| -   | `stale` and "merged since you branched"                      | pass   | A merged PR touched a file that a session changed                                    |

`claude plugin test plugin` passes 33 tests. `make check` runs them. CI does not.

Bugs found by these runs were fixed in #18 to #21. See the [changelog](../CHANGELOG.md).
