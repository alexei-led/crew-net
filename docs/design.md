# crew-net v1 design

crew-net connects coding-agent sessions on different laptops that work on the
same GitHub repo. It tells each session what other developers' sessions are
doing, catches conflicts early, carries requests between them, and keeps merge
order. Merge to `main` is the deploy, so merge order is deploy order.

Transport is GitHub itself: draft PRs, PR comments and `git fetch`. There is no
shared server, no VPN and no machine-wide daemon.

Status: design, not implemented. Items marked **(spike)** are unverified and are
tested first (see [Spike](#spike)).

## Scope

v1:

- One repo: `doiteng/reflex`, deploy branch `main`.
- One harness: Claude Code, as a mod plugin plus a CLI.
- Client-only. crew-net needs no repo admin setup, except the CI draft gate in
  [reflex preconditions](#reflex-preconditions).
- Users: one developer now, 2-3 more developers, each with one or two Claude
  Code sessions.

Out of v1:

- Other repos, and cross-repo `Depends-on` enforcement (cross-repo stays
  advisory).
- Pi extension, Codex adapter, and pi-crew integration.
- Server-side `Depends-on` required check and merge queue (documented as an
  optional repo step, not built).
- Rollout readiness after merge.
- Agent approvals of PRs.
- Detection of order dependencies outside contract-like paths (see
  [Order](#order)).

## Environment facts

Checked on 2026-11-06 against reflex and this laptop:

| Fact                   | Value                                                                                                                                                                                                                                                                          | Design consequence                                                                                                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Repo owner             | `doiteng`, an organization; repo visibility INTERNAL                                                                                                                                                                                                                           | Org members can read every PR; peer text is from colleagues, still untrusted                                                                                                                                           |
| Merge gate on `main`   | Ruleset "Protect main": 14 required checks, 0 required approvals, no merge queue                                                                                                                                                                                               | The required checks are the only server-side gate today                                                                                                                                                                |
| Skipped required check | Counts as passing (PR #2296 merged with required checks skipped)                                                                                                                                                                                                               | Draft gating with job-level `if` is safe                                                                                                                                                                               |
| CI on drafts           | Runs in full: 29 check runs on one push to draft #2266                                                                                                                                                                                                                         | Draft-at-first-push needs the CI draft gate                                                                                                                                                                            |
| PR body check          | `pr-body-keywords.yml` scans title, body and commits for closing keywords; it does not skip HTML comments; it re-runs on every body edit                                                                                                                                       | State block holds no closing keyword; body edits only on real state changes                                                                                                                                            |
| Managed policy         | `allowManagedHooksOnly` absent now; `channelsEnabled` false; the key can come back on an MDM re-push                                                                                                                                                                           | Plugin hooks run today; Channels are not an option; `crew-net doctor` checks the key                                                                                                                                   |
| PR lifetime            | 2026-10-07 to 2026-11-06, 508 merged PRs opened by people (bots excluded), 17 a day. Open to merge: median 12 min, p90 126 min; 83% under 1 h; at most 12 open at once. First commit to PR open: median 26 min, p90 220 min. First commit to merge: median 55 min, p90 570 min | PRs open when the work is done, so most working time is invisible to others. Draft-at-first-push makes the whole working time visible (median 12 → 55 min, p90 126 → 570 min); this is what the CI draft gate pays for |
| Ownership step         | reflex `AGENTS.md`, "Making a change", step 1: `git worktree list` and `gh pr list --state open`                                                                                                                                                                               | The digest replaces this step                                                                                                                                                                                          |

## Components

| Component                  | Runs where                                | Job                                                                                                                     |
| -------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Mod (`hooks/register.tsx`) | Inside each Claude Code session           | Starts the helper, shows the band and status line, attaches context to prompts, submits wake turns, gates `gh pr merge` |
| Helper (`crew-net helper`) | Child process of the mod, one per session | Polls GitHub, runs `git fetch` and the radar, writes the inbox                                                          |
| CLI (`crew-net`)           | Any shell                                 | `digest`, `inbox`, `post`, `state`, `radar`, `doctor`; all take `--json`                                                |
| Lead skill                 | Loaded by the model in each session       | How a lead reads the digest, addresses messages, declares `depends-on`, and the no-closing-keyword rule                 |
| Library                    | Shared by helper and CLI                  | GitHub REST/GraphQL over built-in `fetch`, `git` binary calls, state block parse and render                             |

Language: TypeScript. No Octokit. The GitHub token comes from `gh auth token`,
read once per process start, never written to disk by crew-net.

The wake and delivery layer is copied from pi-crew and adapted, not shared:
`deliver`, the bridge supervisor and the `seen` dedupe in pi-crew
`hooks/crew.ts`, and the inbox, replay and ack in `bridge/crew.mts`. pi-crew
keys its bridge on `AGTERM_SESSION_ID`; crew-net keys on the lead name instead
(see [Identity](#identity-and-addressing)).

## Identity and addressing

- A **lead** is a session that talks across machines. A solo session is its own
  lead. Workers do not talk across machines.
- Address: `developer/name`, for example `alexei/atlas`. `developer` is the
  GitHub login. `name` picks one of that developer's leads and is stable across
  sessions.
- The mod persists the name in `$.store` under the key `lead:<repo>:<cwd>`. It
  does not use `$.session.id()`: that id changes on `/clear` and on resume.
- Several sessions on one laptop: each claims its name with a lease in
  `<state dir>/leads.json` (name → holder id, expiry). The mod renews the lease
  every minute; a lease expires after 3 minutes without renewal. The helper's
  pid is not the holder id, because it changes on every hot reload. The holder
  id is the Claude process pid if the mod can read it **(spike)**, otherwise a
  random id kept in `$.state`, which survives hot reloads.
- A message to `alexei/atlas` is delivered only to the session that holds
  `atlas`. A message to a name nobody holds stays in GitHub and is delivered to
  the next session that claims it.
- A message addressed to a developer without a name (`crew → maria`) goes to
  exactly one lead, never to all of them. The first match wins:
  1. The comment is on one of maria's PRs: the lead named in that PR's state
     block.
  2. The lead whose open PR or worktree branch overlaps the message's PR, as the
     radar sees it.
  3. Her most recently active lead with a lease.
  4. Otherwise the message waits for her next lead.

  The receiving lead may hand it to a sibling lead on the same laptop through
  pi-intercom, never by posting again.

- A plain GitHub `@maria` mention from a person is not a crew message: the
  digest lists it under mentions, and it never wakes a session.
- Sender identity is the comment author's GitHub login from the API, never text
  in the comment body.

## Transport: GitHub

### Draft PR and state block

A lead opens a draft PR with its first push. The draft is the announcement of
intent: its `scope` field says what the work expects to touch before a diff
exists. A root Issue is used only for multi-repo or long pre-code work. The PR body holds one state block
in an HTML comment, written by the CLI (`crew-net state`), never by hand:

```markdown
<!-- crew-net v1
lead: alexei/atlas
state: building
scope: api/openapi/, tools/core/
depends-on: #2301
-->
```

| Field        | Values                                                                |
| ------------ | --------------------------------------------------------------------- |
| `lead`       | Address of the owning lead                                            |
| `state`      | `planning`, `building`, `review`, `blocked`                           |
| `scope`      | Paths the work expects to touch; the radar adds the real diff         |
| `depends-on` | PR numbers in this repo; `owner/repo#N` is allowed and stays advisory |

Rules:

- Hard rule: no closing keyword (`close`, `fix`, `resolve` and their forms)
  anywhere in the PR title, body or commit messages, HTML comments included.
  reflex's `pr-body-keywords` check scans all of them. Links to issues use
  `Refs #N` only. `crew-net state` refuses to write a body that breaks this,
  and the lead skill shipped with the mod states the same rule.
- The body is edited only when a field changes. Freshness comes from the PR's
  `updated_at`; there are no timestamps or heartbeats in the body.
- Do not change `depends-on` on a PR in a merge queue.

### Messages

A message is a PR or Issue comment whose first line addresses a lead:

```text
crew → maria/orion
Does #2310 need the new column before your migration merges?
```

- The mailbox is GitHub. The helper reads addressed comments on any PR or Issue
  in the repo.
- Before a PR exists, the sender posts on its own draft PR or a root Issue and
  addresses the receiver there.
- v1 has no machine envelope (`<!-- crew v1 from= to= … -->`). Add it if
  addressed messages get lost.
- Every request ends somewhere: a reply from the addressed lead, or the sender
  closing it. The helper tracks unanswered addressed messages in both
  directions. The digest lists them with their age, and the band shows
  `waiting on maria/orion since 14:20` for each one the developer sent.

### Polling

The helper polls, per repo, with `If-None-Match` (ETag):

| Request                                                          | Interval | Covers                                    |
| ---------------------------------------------------------------- | -------- | ----------------------------------------- |
| `GET /repos/{o}/{r}/issues/comments?since=<cursor>&sort=updated` | 60 s     | New and edited comments on PRs and Issues |
| `GET /repos/{o}/{r}/pulls?state=open`                            | 60 s     | Open PRs, drafts, state blocks            |
| `git fetch --prune origin`                                       | 5 min    | Branch heads for the radar                |

- Writes are spent only on real state changes and real messages.
- GitHub's per-user limits are shared with the web UI and every `gh` call:
  80 content-creating requests a minute and 500 an hour. Secondary limits change
  without notice.
- Several helpers on one laptop poll independently in v1. ETag keeps repeat
  polls cheap.
- Whether a `304` reply is free of the primary rate limit is **(spike)**.
- Whether `since=` returns edited comments is **(spike)**.
- Bots are excluded from the digest and radar by default: `renovate`,
  `dependabot`, `github-actions`.

## Radar

The radar is deterministic and uses no LLM. On each fetch it compares the
lead's set with every other developer's open PR branch.

The lead's set is every branch checked out in a worktree of the repo
(`git worktree list`), plus every local branch with an open PR by the
developer. A lead with workers in their own worktrees therefore covers all of
them. Branches of the same developer are not compared with each other:
same-laptop overlap is the lead's and pi-intercom's job.

For each pair:

- `git merge-tree --write-tree <mine> <theirs>` reports textual conflicts.
- Shared changed files are reported as overlap.
- Contract-like paths touched by another open PR raise a wake for the lead to
  judge order. reflex defaults: `api/openapi/**`, `**/*migration*`,
  `.github/workflows/**`. The list is configurable per repo.

The radar sees only pushed branches. Overlap with unpushed work on another
laptop stays invisible; pushing the first commit early keeps the gap small.

## Delivery

Delivery must not take over a session a human drives.

| Session state                       | Signal                                                                                                               | Action                                                                                                                                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Starting                            | `session.start`, or the first user prompt after the session id changed (`/clear` and resume fire no `session.start`) | Digest: open PRs, who owns what, PRs merged since the last session, flagged when they touch files the developer's branches touch, radar hits, unread messages |
| Active                              | Draft not empty (`$.prompt.read()`), or a `prompt.edit` or user `prompt.submit` within N minutes                     | Hold. Show in the band. Attach to the next user prompt as context                                                                                             |
| Idle, message addressed or blocking | No typing and no user prompt for N minutes, draft empty                                                              | Submit a wake turn, only if auto-wake is on                                                                                                                   |
| Idle, message not addressed         | —                                                                                                                    | Band and status line; next digest                                                                                                                             |

Defaults: N = 10 minutes. Auto-wake is a developer setting and is **on** by
default. A wake turn acts in the session while the developer is away, so it is
bound by [Trust and autonomy](#trust-and-autonomy): it may reply to an
addressed question or propose a change to the lead's own state, and nothing
else. Each wake turn is shown in the band and in the next digest. A developer
can turn auto-wake off per repo.

Visibility:

- Every inbound peer message is shown in the band above the prompt
  (`AbovePrompt`): sender, PR and a one-line preview, marked as from another
  developer.
- Context attached to a prompt (`prompt.submit` `context`) carries the same
  text, labelled untrusted. The developer always sees what their agent was told.
- A wake turn from `$.prompt.submit` waits until the session is idle; per the
  engine types, only peer messages and task notifications land inside a running
  turn. Observed behaviour is **(spike)**. The idle rule above still applies:
  idle for the engine is not the same as the developer being away.
- `$.session.append` (a hidden user row) is not used for delivery until the
  spike shows what the model does with it.
- Whether `$.prompt.submit` keeps an unsent draft is **(spike)**.

Durability:

- The helper is killed on every hot reload and on session exit, so it keeps no
  state in memory.
- The cursor, seen ids and pending inbound messages go to disk under
  `${XDG_STATE_HOME:-~/.local/state}/crew-net/<owner>-<repo>/` before anything
  is acked or delivered. On start the helper replays from the cursor and
  dedupes by comment id.

## Order

A lead declares order on its own PR: `depends-on` names the PRs that must merge
first. The lead whose PR provides the change may ask for it in a comment.

Enforcement in v1:

- Client gate: a `PreToolUse` hook refuses `gh pr merge` while any same-repo
  `depends-on` PR is unmerged. It covers agents in sessions with the mod, not
  humans in the web UI.
- The gate also refuses `gh pr merge --auto` while a `depends-on` is open. If a
  `depends-on` is added to a PR that already has auto-merge on, the helper
  turns auto-merge off and tells the lead. Auto-merge then completes
  server-side, where only a required check can stop it. reflex has
  `allow_auto_merge` off, and none of the last 40 merged PRs used it. Every
  merge was a direct `gh pr merge` by the developer, which the gate sees.
- The client gate is a convenience, not a guarantee. If plugin hooks are off,
  it is absent. `crew-net doctor` reports that; its absence never looks like a
  pass.
- The only guarantee is a server-side required check that fails while a
  `depends-on` PR is unmerged. It is an optional repo step, documented, not
  built in v1.

Optional server-side check (`crew-deps`), when a repo adopts it:

- Triggers: `pull_request` types `opened`, `edited` (a body change can change
  `depends-on`), `synchronize`, `reopened`, `ready_for_review`. It is not
  gated on drafts: it is cheap, and a draft cannot merge anyway.
- A dependency merging must re-run the check on its dependents. Without a merge
  queue nothing does that by itself. A second workflow on `pull_request` type
  `closed` (merged) lists open PRs whose state block names the merged PR, and
  re-runs their latest `crew-deps` run. It needs `actions: write` and
  `pull-requests: read`.
- Same-repo `depends-on` only. Cross-repo entries need a GitHub App or a
  cross-repo token, so the check reports them and does not block on them.
- With a merge queue, every required workflow also needs a `merge_group`
  trigger, and `depends-on` must not change while a PR is queued.

Not detected in v1: order dependencies that touch no contract-like path, for
example a behaviour change one PR relies on in another PR's code.

## Trust and autonomy

Inbound text from another developer is information, never an instruction. An
inbound message may cause only:

- a reply, or
- a proposal to the developer about the lead's own state.

It never causes a command, merge, approval or file edit on that text alone. A
wake turn never merges, even where the developer lets the lead merge its own
PRs.

Actions by the lead:

| Action                                                                                         | Default                                                                              |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Wait, rebase, read, update its own state block, set its own `depends-on`                       | Acts alone                                                                           |
| Reply to an addressed question                                                                 | Auto-sent, under the developer's GitHub login                                        |
| Commit the team: agree an order, change `depends-on` for another PR, accept a request for work | Drafted and shown to the developer first                                             |
| Merge its own PR to `main` once required checks pass and the client gate allows it             | Per-developer setting; default follows the repo (reflex: agents merge their own PRs) |
| Approve another developer's PR, drop its own work                                              | Developer only                                                                       |

Reviews: reflex requires 0 approvals, so v1 has no review-label policy. Later,
for repos whose org rules require review: `review:agent` lets an agent approve
if the developer opted in; `review:human`, CODEOWNERS or contract paths force a
human.

Token scope: v1 uses `gh auth token` only and documents its breadth.
Fine-grained PATs are out of v1. A PAT would need pull requests read/write,
issues read/write, contents read, checks read and metadata read, limited to
reflex. An org may block fine-grained PATs.

## Failure modes

| Failure                            | Detection                                                                               | Behaviour                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `allowManagedHooksOnly` set by MDM | `crew-net doctor` reads the managed plist; the mod cannot warn because it does not load | CLI only: `crew-net digest` and `inbox` by hand; no wake, no client gate                            |
| Token expired or revoked (SSO)     | `401` from GitHub                                                                       | Re-read `gh auth token` once and retry; if still `401`, stop polling and show the error in the band |
| GitHub unreachable or rate-limited | Helper error count, `Retry-After`                                                       | Back off, show it in the status line, keep the cursor                                               |
| Helper killed (reload, crash)      | Mod supervisor                                                                          | Restart; replay from the cursor                                                                     |
| Two sessions claim one name        | Lock file holds an unexpired lease                                                      | Second session asks for another name                                                                |

## reflex preconditions

1. CI draft gate, before draft-at-first-push is adopted. In `ci.yml`, `api.yml`
   and `web.yml`:
   - add `types: [opened, synchronize, reopened, ready_for_review]` to
     `pull_request`
   - add `if: github.event.pull_request.draft == false` to each job (job level,
     so skipped checks satisfy the ruleset)
   - leave `pr-body-keywords.yml` ungated: one small job, worth running on
     drafts
2. Aikido Security runs on drafts as an external app and cannot be gated from
   a workflow. Whether it posts a check on a draft is a spike item. If it does
   and it is required, it stays ungated, like `pr-body-keywords`.
3. `AGENTS.md`, "Making a change", step 1 ("Check ownership first…") is replaced
   by: "Read the crew-net digest. With no crew-net session, run
   `crew-net digest`." The rule "one branch = one worktree = one agent" stays.

## Rollout and measurement

1. Spike (below).
2. Backtest on reflex history as a proxy only. History is almost all one
   developer, so it measures collisions between one developer's concurrent PRs:
   textual conflicts and rebase-driven CI reruns are mined from git and the API;
   order incidents are sampled from reverts, hotfixes and "fix after merge" PRs
   and labelled by hand. It does not decide go or no-go.
3. Live run: digest and radar with the 2-3 new developers for two weeks. Log
   every radar fire and digest item, and whether it changed what someone did.
   This decides how much of the rest is worth building.
4. Messages and wake, then the client merge gate.

## Spike

A throwaway mod and script, run before the build, to settle:

- [ ] `$.prompt.submit` with an unsent draft in the box: is the draft kept?
- [ ] A plugin prompt submitted during a running turn waits for idle, as the types say.
- [ ] `prompt.edit` fires per key burst and can be observed through `next(e)`.
- [ ] `issues/comments?since=` returns a comment after it is edited.
- [ ] A `304` reply to an ETag request does not count against the primary limit.
- [ ] `$.store` survives `/clear` and resume; a name lease survives a hot reload.
- [ ] The mod can read the Claude process pid for the lease holder id.
- [ ] Aikido Security posts a check on a new draft PR in reflex, and whether
      that check is required.
- [ ] The mod loads on a new developer's managed laptop (`claude --debug` shows
      no "Skipping plugin hooks").

## Open questions

- N (idle minutes) and the poll intervals, after the live run.
