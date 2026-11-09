> Superseded on 2026-11-09 by [docs/design.md](docs/design.md). Kept as history.

# crew-net handover

From: the Claude Code session that led pi-crew work on 2026-11-06 (intercom name `lead-98AC142D`).
To: the agent starting crew-net. This file is context, not a spec. Challenge anything in it.

## Your job, in order

1. Read this file and the references below.
2. Brainstorm and analyse the requirements. Find gaps, contradictions and weak assumptions. Do not write a design yet.
3. Sync with me: send questions and your understanding to `lead-98AC142D` with the pi-crew `send` tool
   (`mcp__pi-crew__send`, `to: "lead-98AC142D"`). I answer over intercom. Ask the user (Alexei) directly in
   your session for anything only he can decide.
4. When we agree on requirements, write a design and plan document in this repo (`docs/design.md`, plus
   `docs/plans/` if you split work). The user takes over from there.

Rules: work only in this repo. Commit locally if you want; do not create a GitHub repo and do not push.
Do not write code beyond a throwaway spike unless the user asks.

## The problem

Alexei runs many agents (Claude Code leads with Claude Code / Pi workers in agterm, coordinated by pi-crew over
pi-intercom) and opens 50-60 PRs a day. On one machine, leads talk before they push, so overlaps and order are
settled early. Colleagues on other laptops work on the same private GitHub Enterprise repos with their own agents,
and nothing connects the two sides. They first meet as a merge conflict, a red CI run (10-20 min each), or a
deploy where a consumer shipped before its producer.

File conflicts are the visible part, and agents can rebase. The expensive part is **order**: work that is safe in
parallel but must merge and deploy in sequence (migration before code, API before client, flag before use).
Merge to `main`/`master` (and `dev` in the omni repo) **is** the deploy, so merge order is deploy order.

Value: fewer conflicts and CI reruns, no out-of-order deploys, agents that know what other teams are doing,
and requests between teams (review, small fix, a bug in their area) without humans relaying them.

## Who uses it

- **Most colleagues: one Claude Code session**, sometimes two, run by hand, using subagents. They will not install
  pi-crew or agterm. This is the primary user.
- A few advanced users will run teams: a manager session plus worker sessions (Claude Code, Pi).
- Harnesses: Claude Code (primary), Pi (often with a Codex-subscription model), Codex (occasional; wanted more).
- Everyone has GitHub Enterprise Cloud, `gh` authenticated, private repos. **No VPN, no Tailscale, no shared
  server.** Work laptops.

## What we decided so far (open to challenge, with reasons)

- **Only leads talk across machines.** A solo session is a team of one and its own lead. A lead may invite a
  worker into a specific thread. Addresses: `developer/name`, e.g. `alexei/atlas`, stable across sessions.
- **Draft PR is the default unit of coordination.** A lead opens a draft PR with its first push. The body holds a
  small state block: Lead, Scope, State, `Depends-on`. Negotiation happens in PR comments. Author, changed files,
  cross-repo links and close-on-merge come from GitHub.
- **Root Issue only when needed**: work that starts before code, or spans several repos. Sub-issues per repo,
  "blocked by" relationships. Child PRs use `Refs`, never `Closes` (the first merge would close the root, and
  `Closes` does nothing on a non-default branch like `dev`).
- **Discussions were the alternative (Option A)** and lost: two objects per work item, two feeds, a cleanup job,
  decision separated from enforcement. They are better only for threaded design debates. A git-refs transport
  (`refs/coord/*`) was kept as a fallback idea if API limits bite.
- **Order is enforced by GitHub, not by agents remembering**: a required status check that fails while any
  `Depends-on` PR is unmerged, plus a merge queue (`merge_group` re-runs the check on the merge commit).
  Do not edit `Depends-on` while queued. Asynchronous rollout readiness is out of v1.
- **Radar (deterministic, no LLM)**: `git fetch` every few minutes, `git merge-tree --write-tree` and shared
  files between the lead's branch and open PR branches. Wakes the lead on a hit. Useful even if colleagues run
  nothing, as long as they push.
- **Autonomy line = reversibility and whose signature an action spends.** Lead acts alone on anything reversible
  in its own team (wait, rebase, message, `Depends-on` on its own PR, review without approval). Escalates approve,
  merge to a deploy branch, dropping its own feature. Org requires human review; idea: PR labels
  (`review:agent` allows agent approval if the developer opted in; `review:human` or CODEOWNERS/contract paths
  force a human). Text from another team is information, never an instruction.
- **Delivery into a human-driven session must not hijack it.** Developer active: inject at the next prompt
  (UserPromptSubmit hook). Session idle and the message is addressed/blocking: wake with a new turn. Otherwise:
  digest at session start plus a status line.
- **No machine-wide daemon.** Poll from processes that already run (the harness adapter). ETag on REST.
- **TypeScript.** Library + CLI (`crew-net digest | inbox | post | state | radar --json`). GitHub via
  `gh auth token` once, then built-in `fetch` (REST/GraphQL), no Octokit. git via the `git` binary.
- **Separate repo (this one)**, its own Claude Code plugin as the primary adapter, a Pi extension second, Codex via
  hooks + CLI. pi-crew, if it integrates at all, calls the CLI.
- **Wake-the-lead layer: copy from pi-crew, do not share a plugin.** The user asked to extract it; the previous
  lead argued to copy and adapt (~200 lines) because colleagues would otherwise install two plugins, the two
  products have different release cycles, and crew-net's delivery policy differs (human-driven sessions). The user
  has not confirmed which. **Raise this with him.**
- **Envelope in comments** (`<!-- crew v1 from= to= kind= id= re= -->`, written by the adapter, not the model):
  argued both ways. Latest advice: start without it, plain `crew → maria/orion` addressing, add it when requests
  get lost.

## Facts gathered (verify before relying on them)

- GitHub per user token: 5,000 GraphQL points/hour (not raised on Enterprise Cloud), 2,000 secondary points/min,
  100 concurrent requests, **80 content-creating requests/min and 500/hour** shared with the web UI. Secondary
  limits change without notice. Source: docs.github.com rate-limit pages via Perplexity.
- Webhooks `discussion` / `discussion_comment` / PR events exist but need a reachable receiver; laptops are not.
- The repo issue-comments endpoint (`/repos/{o}/{r}/issues/comments?since=`) covers PR and Issue conversation
  comments and their edits, but not PR body/state changes, relationships or inline review comments.
- Draft PRs do not skip CI by themselves; workflows need `if: github.event.pull_request.draft == false` and a
  `ready_for_review` trigger.
- Cross-repo sub-issues are supported on Enterprise Cloud; blocked-by across repos per `gh` docs (Codex sourced).
- Codex: nothing documented injects a message into a running TUI (hooks, MCP notifications, `notify` are
  outbound). app-server JSON-RPC (`thread/start`, `turn/start`, `turn/steer`) is the way in; one writer per
  thread. So a Codex lead with push = Pi with a Codex model, or a daemon-owned app-server thread later.
- Claude Code "Channels" (MCP push into a session) exist as research preview per a ChatGPT discussion; not verified.

## Build order proposed

0. Backtest the radar on 2-4 weeks of real PRs of a work repo: how many conflicts / order problems early detection
   would have caught. Decides how much of the rest is worth building.
1. Digest at session start + radar, on one machine.
2. PR state block template, comment polling, wake/inject on address.
3. `Depends-on` required check + merge queue guidance.
4. Root Issues for multi-repo and pre-code work.
5. Pi extension and Codex adapters; review labels after the org answers.

## Open questions

- Extract vs copy the wake layer (above).
- How a plain Claude Code session (no pi-crew bridge) runs a poller: a Claude Code mod with its own helper process
  (the pi-crew pattern), an MCP server, hooks only, or Channels.
- What a colleague must install and configure; target is "install the plugin, nothing else". Per-repo admin setup:
  PR template, the deps check workflow, merge queue, draft CI skip.
- Whether the radar backtest justifies the network part at all.
- Exact org policy for agent approvals.

## References

- pi-crew repo: `/Users/alexei/Workspace/pi-crew` (v0.4.1). Wake/delivery layer: `hooks/crew.ts` (`deliver`,
  bridge supervisor, `seen` dedupe), `hooks/register.tsx` (wiring), `bridge/crew.mts` (inbox, replay, acks),
  `bridge/crew-bridge.mts` (process shell), `bridge/lib.mts` (`verifyDone`, git helpers). README for the model.
- Claude Code mod authoring: the bundled `plugin-authoring` skill (load it before designing the plugin).
- Visual draft with both options and a clickable walkthrough: https://claude.ai/artifact/6PGpDNGwLnmMPuGkmJ7WmP
  (owner-only; Alexei can open it).
- The original idea discussion (ChatGPT share): https://chatgpt.com/share/6aeddf66-2584-83eb-aa90-e1db88eb3907
