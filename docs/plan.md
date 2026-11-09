# Plan: crew-net

One release with everything in the design. Steps are build order, not
releases. [design.md](design.md) wins over this plan. Inside a module the implementer picks the details; a change to the
GitHub protocol (§7) or to a dependency rule (§19) needs a design update first.

## Ground rules

- One task = one branch = one worktree = one PR.
- TypeScript strict, Node 22, no runtime dependencies. Dev tooling as on `main`.
- Done = `make check` passes (types, lint, tests, dependency-cruiser), the PR
  says what changed and how it was checked, and docs match behaviour.
- Live writes only to `alexei-led/crew-net-sandbox`. Never to work repos.

## Step 0 — Align the code with the design

Existing code on `main` follows the earlier design. Bring it in line before
building on it.

| Task | Change                                                                                                      | Acceptance                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 0.1  | `protocol`: `lead` optional and ignored; message marker codec replaces `address`; repo config subset parser | Round-trip and tolerant-reader tests; old blocks with `lead` still parse |
| 0.2  | `adapters/store`: layout of design §8.3; session heartbeats replace leases; `delivered/` claims             | Atomic-write and concurrent-claim tests                                  |
| 0.3  | `core/routing`: rewrite to design §9.3                                                                      | Table tests for each step and for `none`                                 |
| 0.4  | Mine branch `w5-finish` for `app` and `cli`; rename `helper` to `watch`; delete the rest                    | Old branches and worktrees removed after merge                           |

## Step 1 — Awareness and radar (useful alone)

| Task | Change                                                                                              | Acceptance                                                                      |
| ---- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 1.1  | `app` sync jobs: repo state, fetch and radar, watched repos; locks and freshness                    | In-memory tests: second trigger is a no-op; cursor moves only after store write |
| 1.2  | `core/radar`: `conflict`, `overlap`, `stale`; bare branches; same-base pairs; dedupe by file set    | Real-git tests for each finding                                                 |
| 1.3  | `core/digest` and `crew-net`, `who`, `doctor`                                                       | Digest golden tests; `doctor` names each missing piece                          |
| 1.4  | Plugin hooks: `SessionStart` digest, `UserPromptSubmit` new findings, detached stale sync           | `claude plugin test`; hooks never block on the network                          |
| 1.5  | Skill: read the digest, run `who` before starting, push the first commit early, no closing keywords | Reviewed against design §13                                                     |
| 1.6  | Marketplace, README, user guide                                                                     | Install on a clean `CLAUDE_CONFIG_DIR` works                                    |

## Step 2 — Requests and delivery

Starts with a spike using two GitHub accounts: notification latency, filtering
by reason, behaviour with web notifications off (design §23).

| Task | Change                                                                                  | Acceptance                                                                 |
| ---- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 2.1  | `adapters/github`: notifications, thread comments since, reviews                        | Recorded fixtures incl. `304`, reason filtering                            |
| 2.2  | Inbox job, `outbox.json`, request lifecycle                                             | Replay after kill delivers once                                            |
| 2.3  | `ask`, `request`, `reply`, `inbox`; write budget                                        | Sandbox round trip; budget stops at the limit                              |
| 2.4  | Mod: watcher child, band, status, routing claims, delivery policy (copied from pi-crew) | `claude plugin test` for each spike behaviour and for no wake with a draft |
| 2.5  | Wake turns and the wake tool gate                                                       | Injection scenario: a peer asks to merge or edit; only a reply comes out   |

## Step 3 — Order

| Task | Change                                                                               | Acceptance                                                                    |
| ---- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 3.1  | `state`, `dep add/rm`; closing-keyword guard on every write                          | Sandbox: block written, keyword refused                                       |
| 3.2  | Dependency job: `unblocked`, `dependency closed`, "waits on you", auto-merge off     | Sandbox scenarios for each event                                              |
| 3.3  | `crew-net gate` and the `PreToolUse` merge hook, fail closed                         | Blocks `gh pr merge` and `--auto` with an open dependency; allows after merge |
| 3.4  | Contracts: config, `order` findings, cross-repo consumers                            | Two sandbox repos: cross-repo `order` finding appears                         |
| 3.5  | `crew-net init`; repo kit gets the `crew-net.yml` template and `merge_group` support | Generated files pass `actionlint`; `doctor` reports levels 2 and 3            |

## Step 4 — Other harnesses

| Task | Change                                                 | Acceptance                                         |
| ---- | ------------------------------------------------------ | -------------------------------------------------- |
| 4.1  | Pi extension: start digest, inject, timer, wake, gates | The step 2 and 3 scenarios pass with a Pi lead     |
| 4.2  | Codex: verify hooks, then hooks + `AGENTS.md` snippet  | Digest and merge gate work in Codex CLI            |
| 4.3  | Worker role for pi-crew teams (`CREW_NET_ROLE=worker`) | Worker sessions are never routed to and never post |

## End-to-end scenarios

Two simulated laptops on one Mac, sandbox repos. `[2]` needs a second account.

1. Digest at start and after `/clear` shows the other side's PR and bare branch.
2. Both sides change one file and push; a conflict finding appears within one
   fetch cycle on each side.
3. `[2]` Ask and reply: held in the band while typing, injected with the next
   prompt; with the receiver idle, one wake turn replies.
4. `[2]` A developer with two sessions: an item reaches exactly one.
5. `depends-on` blocks `gh pr merge` and `--auto`; `unblocked` arrives after the
   dependency merges.
6. `[2]` A peer comment that asks to merge or edit files causes only a reply.
7. Hot reload and a killed sync cause no duplicate delivery.
8. Token swap: one re-read, then a clear error; `doctor` flags a planted
   `allowManagedHooksOnly`.
9. One hour of two sessions in two repos stays under 400 primary requests.

## Release

All steps and scenarios done: tag the release, install it on the first 2-3
developers' laptops, and run it for two weeks with `crew-net stats` to tune
intervals, idle time and radar noise.
