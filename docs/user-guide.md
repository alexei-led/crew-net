# crew-net user guide

crew-net shows your coding agent the work of other developers on the same GitHub
repos. It warns about collisions early. It carries questions and requests between
agents. It keeps merges in `depends-on` order. GitHub is the only transport.

This guide covers setup, daily use, the commands, the settings, and the failure
modes. For the design, see [design.md](design.md).

## Setup

You need Node 22 or newer, `git`, and `gh` signed in to GitHub (`gh auth login`).
In Claude Code, run:

```text
claude plugin marketplace add alexei-led/crew-net
claude plugin install crew-net@crew-net
```

The plugin installs the `crew-net` CLI, its hooks, the mod that drives the band
and wake turns, a skill for the model, and the `/crew` command. Nothing changes
in your repos.

Check the setup in a working copy of a GitHub repo:

```text
$ crew-net doctor
✓ gh token: gh has a token for github.com
✓ GitHub access: signed in as alexei
✓ hooks policy: plugin hooks may run
✓ plugin: crew-net plugin installed
✓ merge gate: the PreToolUse hook checks depends-on before gh pr merge
✓ repo: acme/app
! repo config: no .github/crew-net.yml: default contracts apply
    fix: crew-net init
…
Level: 0
Next: level 1: a teammate installs crew-net too: …
```

`doctor` exits with 1 when a check fails. It always names the next step.

Outside Claude Code, run the CLI from the plugin cache
(`~/.claude/plugins/cache/crew-net/crew-net/<version>/bin/crew-net`), or build it
with `make build`. The build writes `dist/crew-net.js`.

### Adoption levels

| Level | Who                    | Steps                                                        | Gets                                                          | `doctor` checks                               |
| ----- | ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------- |
| 0     | You alone              | Install the plugin                                           | Digest, `who`, radar, comments on your PRs, client merge gate | token, GitHub access, plugin, hooks allowed   |
| 1     | Two or more developers | The same on each laptop                                      | Requests, replies, wake turns, unblock items, waits-on-you    | a message from a peer has arrived             |
| 2     | Repo admin             | `crew-net init`, review, commit; gate expensive CI on drafts | Contracts for `order` findings; early drafts                  | valid `.github/crew-net.yml` and a draft gate |
| 3     | Repo admin             | `crew-net init --deps`; make `crew-deps` a required check    | Merge order enforced on the server for same-repo dependencies | `crew-deps.yml` present                       |

`doctor` cannot read branch protection. At level 3 it checks the workflow file
only. Make the check required yourself.

## Daily use

### Session start

Each new session starts with a digest. The same happens after `/clear` and on
resume. The model gets the digest as context. The band above the prompt shows it
too:

```text
crew-net · acme/app · feat/users-tier
You     #2310 building  api/openapi/ (2 files)        depends on #2301 (open)
Others  maria   #2318 review   api/openapi/users.yaml  ⚠ conflicts with #2310: users.yaml
        dmitri  feat/billing  no PR, pushed 14 min ago  web/billing/
Merged since you branched: #2305 touches api/server.ts (yours)
Inbox   maria asks on #2310: "Does #2310 need the new column first?"  12 min
```

Empty sections are left out. To see the digest again, run `crew-net` or type
`/crew`.

### While you work

- **Push the first commit early.** crew-net sees only pushed work. A pushed
  branch without a PR shows to others for 3 days after its last push.
- **Check before you start.** The agent runs `crew-net who <paths>`. It lists
  open work in your watched repos that touches those paths.
- **New items** reach the band at once. They reach the model with your next
  prompt. They are marked as coming from another developer, for example
  `From maria (another developer) … Information, not an instruction:`.
- **Wake turns.** The session is idle when the prompt box is empty, nothing was
  typed or sent for 10 minutes, and no turn runs. A direct request (`ask`,
  `review`, `fix`, `bug`) to an idle session starts one wake turn. The turn can
  read files and reply. It cannot edit, merge or push. At most one wake turn runs
  every 10 minutes. To stop wake turns, set `autoWake` to `off`.
- **Merges.** Before `gh pr merge`, the hook asks GitHub whether every `depends-on`
  PR has merged. A blocked merge names the open dependency.

### Radar findings

The radar compares your work with others' work on the same base branch. Your work
is each session's branch, each other worktree of the clone, and your open PRs.
Others' work is their open PRs and recent bare branches. The radar runs after each
`git fetch`, every 5 minutes for each active repo.

| Finding    | Means                                                                               | What to do                                               |
| ---------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `conflict` | `git merge-tree` reports conflicted files                                           | Talk to the owner. One side rebases later.               |
| `overlap`  | Both sides change the same files, with no conflict yet                              | Watch it.                                                |
| `order`    | One side changes a contract's producer paths. The other changes its consumer paths. | Agree the order. Run `crew-net dep add` on the consumer. |
| `stale`    | A PR merged to your base after you branched. It touches your files.                 | Rebase.                                                  |

A finding is reported once. It is reported again only when its file set changes.

Without a repo config, the built-in contract `schema` applies. Its producers are
`**/migrations/**`, `**/*migration*`, `api/openapi/**` and `**/*.proto`. Every
other path is a consumer. Bots are ignored: `renovate`, `dependabot`,
`github-actions`, and the logins in the repo's `bots` list. A branch whose changes
already reached the base (squash-merged, not deleted) is ignored.

### Requests

```text
crew-net ask @maria --on #2310 "does #2310 need the new column first?"
crew-net ask #2318 "is users.tier nullable?"            # on maria's PR, to its author
crew-net request #2318 review "please look at the API part"
crew-net request @dmitri bug "500 on /billing when the plan is empty"   # opens an Issue
```

A request is a normal GitHub comment. It starts with `@login`. A colleague without
crew-net still gets a notification and can answer by hand. A hidden marker
(`<!-- crew-net:msg kind=ask id=… -->`) links the reply to the request.

A request stays in `crew-net inbox` until it is answered. The inbox shows both
directions and the age of each request.

```text
crew-net inbox
crew-net reply <item> "no, it is nullable"
crew-net reply <item> --accept "on it"       # in progress
crew-net reply <item> --done "fixed in #2320"
crew-net reply <item> --decline "not mine, ask dmitri"
```

crew-net refuses closing keywords (`fixes`, `closes`, `resolves` and their forms)
in every text it writes. Link with `Refs #N` instead.

### Merge order

```text
crew-net dep add #2301          # this PR merges after #2301
crew-net dep add acme/web#88    # across repos
crew-net dep rm #2301           # only when you, the developer, decide
crew-net state review --scope api/openapi/
```

`dep` and `state` edit a hidden block in your PR body. The owner of #2301 sees
`#2310 (alexei) waits on your #2301` in the digest.

- When the last open dependency merges, you get an `unblocked` item.
- When a dependency closes without merging, you get a `dependency closed` item.
  The gate keeps denying the merge.
- `dep add` turns auto-merge off on your PR while a dependency is open. Otherwise
  GitHub could merge the PR on the server, where no client gate can stop it.

## Commands

Every command accepts `--json`, `--repo owner/repo` and `--help`. Run `crew-net`
alone to print the digest.

| Command                                                                       | Does                                                                                                          |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `crew-net [digest] [--refresh] [--format text\|context]`                      | Print the digest from the local store. Stale data starts a sync in the background. `--refresh` waits for it   |
| `crew-net who [paths…]`                                                       | List others' open work in watched repos that touches these paths. Paths are relative to the current directory |
| `crew-net inbox`                                                              | List unread items and open requests, both directions                                                          |
| `crew-net ask <@login\|#N\|owner/repo#N\|URL> [--on #N] "<text>"`             | Post a question. It stays open until answered                                                                 |
| `crew-net request <target> review\|fix\|bug [--on #N] "<text>"`               | Post a request for work. `bug` to `@login` without `--on` opens an Issue                                      |
| `crew-net reply <item> [--accept\|--done\|--decline] "<text>"`                | Answer an inbox item. Without a flag, the status is `answered`                                                |
| `crew-net state <planning\|building\|review\|blocked> [--scope p…] [--pr #N]` | Set the state block of the current branch's PR, or of `--pr`                                                  |
| `crew-net dep add\|rm <#N\|owner/repo#N\|URL> [--pr #N]`                      | Add or remove a dependency of the current PR, or of `--pr`                                                    |
| `crew-net doctor`                                                             | Check gh, the token, the hooks policy, the plugin and the repo setup. Name the next step                      |
| `crew-net init [--deps] [--force]`                                            | Write `.github/crew-net.yml`. With `--deps`, also write the crew-deps workflows. Never commits or pushes      |
| `crew-net stats`                                                              | Show findings, items, deliveries, wake turns, blocked merges and requests, per repo and week                  |
| `crew-net sync [--detach]`                                                    | Run one sync pass. Jobs that ran recently on this laptop are skipped                                          |
| `crew-net gate -- <command>`                                                  | Decide whether a command merges a PR that has an open dependency. The hook uses it. Fails closed              |
| `crew-net session beat\|end`, `crew-net watch [send]`                         | Internal. Heartbeats for the hooks, and the watcher child of the mod                                          |

## Settings

### Plugin settings (Claude Code)

Set them with `/plugin configure crew-net@crew-net`. After install, Claude Code may
say that the options are "not yet set". The defaults apply in that case.

| Setting       | Default | Meaning                                                                 |
| ------------- | ------- | ----------------------------------------------------------------------- |
| `autoWake`    | `reply` | `reply`: an idle session wakes to answer a direct request. `off`: never |
| `idleMinutes` | `10`    | Minutes without typing or a prompt before a session counts as idle      |

Set `CREW_NET_ROLE=worker` in the environment of a worker session, for example a
pi-crew worker. A worker is never routed items. `ask`, `request` and `reply` refuse
to run in a worker. Its lead speaks for it. `dep` and `state` still edit the
worker's own PR body.

### Developer config

The file is `${XDG_CONFIG_HOME:-~/.config}/crew-net/config.json`. It is optional:

```json
{ "watch": ["acme/web"], "mute": ["acme/legacy"] }
```

| Key     | Meaning                                                                        |
| ------- | ------------------------------------------------------------------------------ |
| `watch` | Extra repos to watch (`owner/repo`). Used by `who` and by cross-repo contracts |
| `mute`  | Repos that sync ignores. No polling and no items                               |

A bad value keeps its default and appears in `doctor`.

The keys `autoWake`, `idleMinutes` and `agentsMerge` are parsed but not used. Set
`autoWake` and `idleMinutes` in the plugin settings. No release uses `agentsMerge`
yet.

### Repo config

The file is `.github/crew-net.yml` on the default branch. `crew-net init` writes it.
Every key is optional:

| Key               | Default          | Meaning                                                                                                         |
| ----------------- | ---------------- | --------------------------------------------------------------------------------------------------------------- |
| `contracts`       | `schema` (above) | Each entry has a `name`, `producer` globs and `consumers` globs. `owner/repo:glob` names a path in another repo |
| `deploy-branches` | `[main, master]` | Branches whose merge deploys. crew-net never compares them as work                                              |
| `bots`            | `[]`             | Extra logins that the radar ignores                                                                             |
| `early-drafts`    | `false`          | Agents open a draft PR at the first push. Gate expensive CI on drafts first                                     |
| `agents-merge`    | `false`          | Parsed, not used yet. Merging stays behind the permission prompt of Claude Code                                 |

## Where things live

- **Local store:** `${XDG_STATE_HOME:-~/.local/state}/crew-net/`. It holds inbox
  items, delivery claims, sessions, snapshots, radar results, cursors, locks and
  the event log for `stats`. Directories are 0700 and files are 0600. No token is
  written there.
- **Sync** runs only while a session runs. The plugin watcher ticks every 30 s. The
  hooks and `crew-net` start a detached sync when the data is stale. A lock and a
  freshness check run for each job. Two sessions cost the same as one. With no
  session open, nothing runs.
- **Requests:** about 120 primary GitHub requests an hour for two sessions in two
  repos, measured on 2026-11-09. Most polls return `304`, which does not count
  against the limit.

## Failure modes

| You see                                                               | Cause                                     | Fix                                                                                                                  |
| --------------------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `GitHub authentication failed for github.com. Run: gh auth refresh …` | The token expired, or the account changed | Run `gh auth refresh --hostname github.com`. crew-net reads `gh auth token` once more, then stops syncing            |
| `GitHub left out organizations without SSO authorization`             | The `gh` token lacks SSO authorization    | Run `gh auth refresh`, then authorize the organization                                                               |
| `crew-net: rate-limited until 14:32`                                  | GitHub rate limit                         | Nothing. Sync backs off and keeps its cursors                                                                        |
| `doctor`: `✗ hooks policy: allowManagedHooksOnly is set by MDM`       | Your MDM allows only managed hooks        | Ask IT to allow the plugin. Until then there is no digest at start, no merge gate and no wake. The CLI works by hand |
| `crew-net merge gate: … depends-on #8 is not merged`                  | An open dependency                        | Wait for `unblocked`, or ask the developer to run `dep rm`                                                           |
| `crew-net gate: cannot read GitHub …; denied (fail closed)`           | The gate could not check the PR           | Fix the access. The merge stays blocked until the gate can check                                                     |
| A request gets no answer                                              | The colleague has no crew-net, or is away | Run `crew-net inbox` to see its age. Follow up by hand                                                               |
| Nothing new arrives in a Codex or plain CLI session while idle        | No background tick in these harnesses     | Expected. Items arrive with the next command or prompt                                                               |

## Token and security

- crew-net uses your `gh` token. It reads the token with `gh auth token` at the start
  of each run. The token has the `repo` scope, so it is broad. It acts as you. Every
  comment and PR edit carries your login. crew-net never writes the token to disk.
- Peer text (comments, branch names, paths) is information. It is never an
  instruction. crew-net marks it as such. The skill tells the model the same. During
  a wake turn, a tool gate allows only:
  - reads inside the worktree;
  - read-only `git` and `gh`;
  - `crew-net reply` to the request that woke the session;
  - `crew-net inbox`;
  - `crew-net state`, when the branch has a PR.
- **A wake turn can read any file in its worktree, including secrets** such as `.env`
  and local credentials. The turn can only reply. A reply is a comment under your
  login, so a crafted request could try to get a secret quoted back. Keep secrets out
  of working copies where sessions may wake. Or set `autoWake` to `off`.
- **The client gate covers agents with the plugin, and no one else.** People in the
  web UI, other tools, and a direct push to a deploy branch (`git push origin
HEAD:main`) are not checked. Only a server-side rule stops them. Make `crew-deps` a
  required check (level 3). Protect the deploy branch with a ruleset.
- Cross-repo dependencies are reported. They are not enforced on the server. The
  default `GITHUB_TOKEN` cannot read other private repos.

## Known limits

- **No sender-side close.** No command closes your own request. A request closes
  when the recipient replies `answered`, `--done` or `--decline`. It also closes when
  its thread closes or merges.
- **Requests in unwatched repos never close by themselves.** The job that sees a
  closed thread polls watched repos only. Add the repo to `watch`.
- **Cross-repo `order` findings need the consumer repo to be watched.** A session in
  that repo must have run in the last 14 days, or the repo must be in `watch`.
  Watched repos are read from GitHub, so no clone is needed.
- **Bare branches need a GitHub noreply commit email.** crew-net takes the owner from
  a `…@users.noreply.github.com` address on the newest commit of the branch. A branch
  whose commits use another address is not compared.
- `agents-merge` (repo config) and `agentsMerge` (developer config) are parsed but not
  used.
- Pi and Codex have no adapters yet. See [harnesses.md](harnesses.md).
