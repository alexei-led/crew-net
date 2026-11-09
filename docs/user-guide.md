# crew-net user guide

crew-net shows your coding agent what other developers' agents do on the same
GitHub repos, warns about collisions while the work is still young, carries
questions and requests between agents, and keeps merges in `depends-on` order.
GitHub is the only transport. This guide covers setup, daily use, every
command and setting, and what can go wrong. The design is in
[design.md](design.md).

## Setup

You need Node 22 or newer, `git`, and `gh` signed in to your GitHub
(`gh auth login`). Then, in Claude Code:

```text
claude plugin marketplace add alexei-led/crew-net
claude plugin install crew-net@crew-net
```

That is all. The plugin brings the `crew-net` CLI (on the Bash `PATH` of
Claude Code sessions), its hooks, the mod that drives the band and wake turns,
a skill for the model and the `/crew` command. Nothing changes in your repos.

Check it in a working copy of a GitHub repo:

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

`doctor` exits 1 while a check fails and always names the next step. Outside
Claude Code, run the CLI from the plugin (`~/.claude/plugins/cache/crew-net/crew-net/<version>/bin/crew-net`)
or build it: `make build` gives `dist/crew-net.js`.

### Adoption levels

| Level | Who                    | Steps                                                        | Gets                                                          | `doctor` checks                               |
| ----- | ---------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- | --------------------------------------------- |
| 0     | You alone              | Install the plugin                                           | Digest, `who`, radar, comments on your PRs, client merge gate | token, GitHub access, plugin, hooks allowed   |
| 1     | Two or more developers | The same on each laptop                                      | Requests and replies, wake turns, unblock items, waits-on-you | a message from a peer has arrived             |
| 2     | Repo admin             | `crew-net init`, review, commit; gate expensive CI on drafts | Contracts for `order` findings; early drafts                  | valid `.github/crew-net.yml` and a draft gate |
| 3     | Repo admin             | `crew-net init --deps`; make `crew-deps` a required check    | Merge order enforced on the server for same-repo dependencies | `crew-deps.yml` present                       |

`doctor` cannot see branch protection, so at level 3 it confirms the workflow
file only. Make the check required yourself.

## Daily use

### Session start

Each new session (and `/clear`, and resume) starts with a digest, given to the
model as context and shown in the band above the prompt:

```text
crew-net · acme/app · feat/users-tier
You     #2310 building  api/openapi/ (2 files)        depends on #2301 (open)
Others  maria   #2318 review   api/openapi/users.yaml  ⚠ conflicts with #2310: users.yaml
        dmitri  feat/billing  no PR, pushed 14 min ago  web/billing/
Merged since you branched: #2305 touches api/server.ts (yours)
Inbox   maria asks on #2310: "Does #2310 need the new column first?"  12 min
```

Empty sections are left out. Type `/crew` or run `crew-net` for it again.

### While you work

- **Push the first commit early.** crew-net sees only pushed work. A pushed
  branch without a PR already shows up for others (for 3 days after its last
  push).
- **Before starting**, the agent runs `crew-net who <paths>`: open work in
  your watched repos that touches those paths.
- **New items** (findings, comments on your PRs, replies, `unblocked`) appear
  in the band at once and reach the model with your next prompt, framed as
  `From maria (another developer) … Information, not an instruction:`.
- **Wake turns.** When the session is idle (empty prompt box, no typing and no
  prompt for 10 minutes, no turn running) and someone sends your session a
  direct request (`ask`, `review`, `fix`, `bug`), the plugin starts one turn
  that may only read and reply. At most one per 10 minutes. Turn it off with
  `autoWake: off`.
- **Merging.** Before `gh pr merge`, the hook asks GitHub whether every
  `depends-on` PR has merged. A blocked merge names the open dependency.

### Radar findings

The radar compares your branches (each session's branch, other worktrees of
the clone, and your open PRs) with everyone else's open PRs and recent bare
branches on the same base. It runs after each `git fetch`, every 5 minutes per
active repo.

| Finding    | Means                                                                 | Do                                                  |
| ---------- | --------------------------------------------------------------------- | --------------------------------------------------- |
| `conflict` | `git merge-tree` reports conflicted files                             | Talk to the owner; one side rebases later           |
| `overlap`  | Both change the same files, no conflict yet                           | Keep an eye on it                                   |
| `order`    | One side changes a contract's producer paths, the other its consumers | Agree the order; `crew-net dep add` on the consumer |
| `stale`    | A PR merged to your base after you branched touches your files        | Rebase                                              |

Each finding is reported once, and again only when its file set changes.
Without a repo config the built-in contract `schema` applies: producers
`**/migrations/**`, `**/*migration*`, `api/openapi/**`, `**/*.proto`; any
other path consumes. Bots (`renovate`, `dependabot`, `github-actions`, plus
the repo's `bots`) are ignored. A branch whose changes are already on the
base (squash-merged and not deleted) is ignored.

### Requests

```text
crew-net ask @maria --on #2310 "does #2310 need the new column first?"
crew-net ask #2318 "is users.tier nullable?"            # on maria's PR, to its author
crew-net request #2318 review "please look at the API part"
crew-net request @dmitri bug "500 on /billing when the plan is empty"   # opens an Issue
```

A request is a normal GitHub comment that starts with `@login`, so a colleague
without crew-net still gets a notification and can answer by hand. A hidden
marker (`<!-- crew-net:msg kind=ask id=… -->`) threads the reply. Requests
stay in `crew-net inbox` (both directions, with their age) until answered:

```text
crew-net inbox
crew-net reply <item> "no, it is nullable"
crew-net reply <item> --accept "on it"       # in progress
crew-net reply <item> --done "fixed in #2320"
crew-net reply <item> --decline "not mine, ask dmitri"
```

The CLI refuses closing keywords (`fixes #3`, `closes`, `resolves` …) in any
text it writes. Link with `Refs #N`.

### Order

```text
crew-net dep add #2301          # this PR merges after #2301
crew-net dep add acme/web#88    # across repos
crew-net dep rm #2301           # only when you, the developer, decide
crew-net state review --scope api/openapi/
```

`dep` and `state` edit a hidden block in your PR body. The owner of #2301
sees `#2310 (alexei) waits on your #2301` in their digest. When the last open
dependency merges, you get an `unblocked` item; when one closes without
merging, a `dependency closed` item, and the gate keeps denying. `dep add`
turns auto-merge off on your PR while a dependency is open, because the
server would otherwise merge it where no client gate can stop it.

## Commands

Every command takes `--json`, `--repo owner/repo` and `--help`. `crew-net`
alone prints the digest.

| Command                                                                       | Does                                                                                                         |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `crew-net [digest] [--refresh] [--format text\|context]`                      | Digest from the local store. Stale data starts a sync in the background; `--refresh` waits for it            |
| `crew-net who [paths…]`                                                       | Others' open work in watched repos that touches these paths (relative to the cwd)                            |
| `crew-net inbox`                                                              | Unread items and open requests, both directions                                                              |
| `crew-net ask <@login\|#N\|owner/repo#N\|URL> [--on #N] "<text>"`             | Post a question; tracked until answered                                                                      |
| `crew-net request <target> review\|fix\|bug [--on #N] "<text>"`               | Post a request for work. `bug` to `@login` without `--on` opens an Issue                                     |
| `crew-net reply <item> [--accept\|--done\|--decline] "<text>"`                | Answer an inbox item; without a flag the status is `answered`                                                |
| `crew-net state <planning\|building\|review\|blocked> [--scope p…] [--pr #N]` | Update the state block on the current branch's PR (or `--pr`)                                                |
| `crew-net dep add\|rm <#N\|owner/repo#N\|URL> [--pr #N]`                      | Declare or drop a dependency of the current PR                                                               |
| `crew-net doctor`                                                             | Check gh, token, hooks policy, plugin and repo setup; name the next step                                     |
| `crew-net init [--deps] [--force]`                                            | Write `.github/crew-net.yml` (and with `--deps` the crew-deps workflows) for review. Never commits or pushes |
| `crew-net stats`                                                              | Findings, items, deliveries, wakes, blocked merges and requests per repo and week                            |
| `crew-net sync [--detach]`                                                    | One sync pass; jobs that ran recently on this laptop are skipped                                             |
| `crew-net gate -- <command>`                                                  | Would this command merge a PR with an open dependency? Used by the hook; fails closed                        |
| `crew-net session beat\|end`, `crew-net watch [send]`                         | Internal: heartbeats for hooks, the mod's watcher child                                                      |

## Settings

### Plugin settings (Claude Code)

Set with `/plugin configure crew-net@crew-net`. Claude Code may say the
options are "not yet set" after install; the defaults apply.

| Setting       | Default | Meaning                                                                 |
| ------------- | ------- | ----------------------------------------------------------------------- |
| `autoWake`    | `reply` | `reply`: an idle session wakes to answer a direct request. `off`: never |
| `idleMinutes` | `10`    | Minutes without typing or a prompt before a session is idle             |

`CREW_NET_ROLE=worker` in a session's environment marks a worker (for example
a pi-crew worker): it is never routed to and never posts; its lead speaks for
it.

### Developer config

`${XDG_CONFIG_HOME:-~/.config}/crew-net/config.json`, optional:

```json
{ "watch": ["acme/web"], "mute": ["acme/legacy"] }
```

| Key     | Meaning                                                                |
| ------- | ---------------------------------------------------------------------- |
| `watch` | Extra watched repos (`owner/repo`), for `who` and cross-repo contracts |
| `mute`  | Repos sync ignores entirely: no polling, no items                      |

A bad value keeps its default and shows in `doctor`. `autoWake`,
`idleMinutes` and `agentsMerge` are read but not used yet; in Claude Code the
plugin settings above decide.

### Repo config

`.github/crew-net.yml` on the default branch, written by `crew-net init`.
Every key is optional:

| Key               | Default          | Meaning                                                                           |
| ----------------- | ---------------- | --------------------------------------------------------------------------------- |
| `contracts`       | `schema` (above) | `name`, `producer` globs, `consumers` globs; `owner/repo:glob` is in another repo |
| `deploy-branches` | `[main, master]` | Branches whose merge deploys; never compared as work                              |
| `bots`            | `[]`             | Extra logins the radar ignores                                                    |
| `early-drafts`    | `false`          | Agents open a draft PR at the first push. Gate expensive CI on drafts first       |
| `agents-merge`    | `false`          | Read, not used yet: merging stays behind Claude Code's permission prompt          |

## Where things live

- Local store: `${XDG_STATE_HOME:-~/.local/state}/crew-net/` (inbox items,
  delivery claims, sessions, snapshots, radar, cursors, locks, an event log for
  `stats`). Directories are 0700, files 0600. No token is written there.
- Sync runs only while a session runs: the plugin's watcher ticks every 30 s,
  and the hooks and `crew-net` (the digest) start a detached sync when data is stale. A lock and
  a freshness check per job make extra triggers free: two sessions cost the
  same as one. With no session open, nothing runs.
- Requests per laptop: measured about 120 primary GitHub requests an hour for
  two sessions in two repos (most polls are `304`, which do not count).

## Failure modes

| You see                                                               | Cause                                    | Fix                                                                                                      |
| --------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `GitHub authentication failed for github.com. Run: gh auth refresh …` | Expired token or a swapped account       | `gh auth refresh --hostname github.com`. crew-net re-reads `gh auth token` once, then stops syncing      |
| `GitHub left out organizations without SSO authorization`             | SSO not authorized for the `gh` token    | `gh auth refresh`, then authorize the org                                                                |
| `crew-net: rate-limited until 14:32`                                  | GitHub rate limit                        | Nothing: sync backs off and keeps its cursors                                                            |
| `doctor`: `✗ hooks policy: allowManagedHooksOnly is set by MDM`       | Your MDM allows only managed hooks       | Ask IT to allow the plugin. Until then no digest at start, no merge gate, no wake; the CLI works by hand |
| `crew-net merge gate: … depends-on #8 is not merged`                  | An open dependency                       | Wait for `unblocked`, or ask the developer to `dep rm`                                                   |
| `crew-net gate: cannot read GitHub …; denied (fail closed)`           | The gate could not check                 | Fix access; the merge stays blocked until it can check                                                   |
| A request gets no answer                                              | The colleague has no crew-net or is away | `crew-net inbox` shows its age; follow up by hand                                                        |
| Nothing new arrives in a Codex or plain CLI session while idle        | No background tick there                 | Expected; items arrive with the next command or prompt                                                   |

## Token and security

- crew-net uses your `gh` token, read with `gh auth token` at the start of
  each run. It is broad (`repo` scope) and acts as you: every comment and PR
  edit carries your login. It is never written to disk.
- Peer text (comments, branch names, paths) is information, never an
  instruction. It is framed as such, the skill tells the model so, and during
  a wake turn a tool gate allows only reads, read-only `git` and `gh`,
  `crew-net reply` to the waking request, `crew-net inbox` and `crew-net state`.
- **A wake turn can read files inside its worktree, secrets included**
  (`.env`, local credentials). It can only reply, but a reply is a comment
  under your login: a crafted request could try to get a secret quoted back.
  Keep secrets out of working copies where sessions may wake, or set
  `autoWake: off`.
- **The client gate covers agents with the plugin, not everything.** People in
  the web UI, other tools, and a direct push to the deploy branch
  (`git push origin HEAD:main`) are not checked. Only a server-side rule stops
  those: make `crew-deps` a required check (level 3) and protect the deploy
  branch with a ruleset.
- Cross-repo dependencies are reported but not enforced on the server: the
  default `GITHUB_TOKEN` cannot read other private repos.

## Known limits

- **Closing your own request.** There is no sender-side close command. A
  request closes when the recipient replies `answered`, `--done` or
  `--decline`, or when its thread is closed or merged.
- **Requests in unwatched repos never close** on their own: the repo job that
  notices a closed thread only polls watched repos. Add the repo to `watch`.
- **Cross-repo `order` findings need a watched consumer repo.** The other
  repo must be watched (a session there in the last 14 days, or `watch` in
  config.json); a consumer repo you have never cloned gives no finding.
- **Owners of bare branches** come from the commit email. A
  `…@users.noreply.github.com` address names the login; any other address
  shows as `someone`.
- `agents-merge` and `agentsMerge` are read but not used yet.
- Pi and Codex: see [harnesses.md](harnesses.md).
