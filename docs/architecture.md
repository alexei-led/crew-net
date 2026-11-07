# crew-net architecture

Target architecture for crew-net v0.1.0. Greenfield: there is no code yet. The
behaviour this architecture implements is specified in [design.md](design.md).
This document says how the code is split, what each part owns, and how the
parts may depend on each other.

## Drivers

These facts shape the module boundaries more than anything else:

1. **Three runtimes.** The Claude Code mod runs inside the engine with no Node
   APIs; it reaches the outside only through `$` (process, store, state, UI).
   The helper and the CLI are Node processes. Logic both sides need must be
   pure TypeScript with no I/O, so the mod can bundle it.
2. **Policy will change; plumbing will not.** Delivery, routing, trust, radar
   rules and the digest are what the live run will tune. GitHub, git and file
   storage are solved problems. Keep the volatile rules in one place, away from
   I/O.
3. **The cross-machine contract outlives any one version.** Two developers may
   run different crew-net versions. The state block and the message address
   in GitHub are the only shared language, so they are versioned and read
   tolerantly.
4. **The engine API is young.** Mod behaviour was verified by a spike
   ([design.md, Spike](design.md#spike)), not by a stable contract. Isolate the
   engine behind a thin adapter so a change there touches one module.
5. **Trust is enforced, not requested.** Peer text reaches a model that has
   write tools. The limits on what a wake turn may do are enforced by the mod's
   tool gate, not only by the lead skill's wording.

## Domain and volatility map

Core means the part that makes crew-net worth having and that changes most.
Supporting means needed but not distinctive. Generic means a solved problem.

| Area                                                     | Class      | Volatility              | Rationale                                                          |
| -------------------------------------------------------- | ---------- | ----------------------- | ------------------------------------------------------------------ |
| Delivery policy (hold, inject, wake, band)               | core       | high                    | Tuned in the live run: idle threshold, what counts as blocking     |
| Routing of messages to one lead                          | core       | medium                  | Rules fixed in the design; inputs may grow                         |
| Trust and autonomy rules                                 | core       | medium                  | Effects allowed per source; will tighten or loosen with experience |
| Radar classification                                     | core       | high                    | Contract-path lists, overlap thresholds, what wakes                |
| Order rules (`depends-on`, merge gate decision)          | core       | medium                  | Same-repo now, cross-repo later                                    |
| Digest composition                                       | core       | high                    | What a developer sees first is the main lever of value             |
| Published language (state block, address, helper events) | supporting | low, versioned          | Changes need a version bump and a tolerant reader                  |
| GitHub access (REST, ETag, budget, token)                | generic    | medium (implementation) | GitHub limits change without notice                                |
| Git access (fetch, worktrees, merge-tree)                | generic    | low                     | Stable plumbing commands                                           |
| Local storage (cursor, inbox, leases)                    | generic    | low                     | Files with atomic writes                                           |
| Claude Code engine binding                               | generic    | high (implementation)   | New API; spike-verified behaviour                                  |

## Module map

Source layout: one TypeScript repo, one npm package, one plugin.

```text
src/
  protocol/      published language, pure
  core/          coordination rules, pure
    delivery/  routing/  trust/  radar/  order/  digest/
  app/           use cases: sync loop, commands; depends on ports
  ports/         interfaces the app needs from the outside
  adapters/      github/  git/  store/  env/
  cli/           crew-net command surface; composition root
  helper/        crew-net helper entry; composition root
plugin/
  .claude-plugin/  plugin.json, marketplace.json
  hooks/           register.ts: the mod, the engine adapter
  skills/crew-net-lead/SKILL.md
repo-kit/        optional per-repo workflows and snippets
```

| Module                   | Responsibility                                              | Owned knowledge                                                                                                      | Public interface                                                                                     | Private                              | Runs in                          | Change vectors                                          |
| ------------------------ | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------ | -------------------------------- | ------------------------------------------------------- |
| `protocol`               | The language shared across machines and processes           | State block grammar, closing-keyword guard, `crew → dev/name` address grammar, helper↔mod event schema, version tags | `parseStateBlock`, `renderStateBlock`, `findClosingKeywords`, `parseAddress`, event types and codecs | Regexes, tolerant-reader details     | mod, helper, CLI                 | New field or event kind (minor), grammar change (major) |
| `core/delivery`          | Decide what to do with one inbound item now                 | Hold, inject, wake, band rules; idle threshold; auto-wake setting                                                    | `decide(item, sessionSignals, settings) → Action`                                                    | Scoring of blocking vs informational | mod (bundled)                    | Live-run tuning                                         |
| `core/routing`           | Pick exactly one recipient lead                             | The four-step routing order                                                                                          | `route(message, facts) → LeadRef or "wait"`                                                          | Tie-breaks                           | helper                           | New routing facts                                       |
| `core/trust`             | What an inbound item may cause, and how peer text is framed | Allowed effects per source, untrusted labelling, wake-turn tool allowlist                                            | `allowedEffects(source)`, `frameUntrusted(text)`, `wakeToolPolicy(call) → allow/deny`                | Wording of frames                    | mod (bundled), helper            | Policy changes                                          |
| `core/radar`             | Turn git facts into findings                                | Conflict, overlap, contract-path rules, bot exclusion                                                                | `classify(pairFacts, config) → Finding[]`                                                            | Path matching                        | helper, CLI                      | New rules, per-repo config                              |
| `core/order`             | Decide whether a merge may happen                           | `depends-on` semantics, auto-merge rule                                                                              | `gateDecision(pr, deps) → allow / deny(reasons)`                                                     | —                                    | CLI                              | Cross-repo later                                        |
| `core/digest`            | Compose the digest model                                    | Sections, ordering, ages, "touches your files" flag                                                                  | `compose(snapshot, me) → Digest`, `renderText(Digest)`                                               | Formatting                           | helper, CLI                      | Live-run tuning                                         |
| `ports`                  | What the app needs from outside                             | Interface shapes only                                                                                                | `GitHubPort`, `GitPort`, `StorePort`, `ClockPort`, `EnvPort`                                         | —                                    | helper, CLI                      | Grows with use cases                                    |
| `app`                    | Use cases                                                   | Sync loop (poll → snapshot → findings → inbox), durable-before-ack, write budget, command handlers                   | `runSync(ports, opts)`, `commands.*(ports, args)`                                                    | Scheduling, dedupe                   | helper, CLI                      | New commands                                            |
| `adapters/github`        | GitHub over `fetch`                                         | REST/GraphQL calls, ETag cache, `Retry-After` backoff, 401 token re-read, request counting                           | implements `GitHubPort`                                                                              | HTTP details                         | helper, CLI                      | GitHub API and limits                                   |
| `adapters/git`           | git over the binary                                         | `fetch`, `worktree list`, `merge-tree --write-tree`, changed paths                                                   | implements `GitPort`                                                                                 | Output parsing                       | helper, CLI                      | git versions                                            |
| `adapters/store`         | Local durable state                                         | State-dir layout, atomic writes, lease file, inbox and outbox                                                        | implements `StorePort`                                                                               | File formats                         | helper, CLI                      | Layout version                                          |
| `adapters/env`           | Machine facts                                               | `gh auth token`, managed-policy plist, repo identity                                                                 | implements `EnvPort`                                                                                 | macOS specifics                      | CLI (doctor), helper             | OS changes                                              |
| `cli`                    | `crew-net` commands                                         | Argument parsing, `--json` output                                                                                    | `digest`, `inbox`, `post`, `state`, `radar`, `gate`, `doctor`, `helper`                              | Wiring                               | Node                             | New commands                                            |
| `helper`                 | Long-running sync for one session                           | Supervision contract with the mod, lease renewal                                                                     | stdin/stdout event stream (protocol)                                                                 | Wiring                               | Node, child of the mod           | Rare                                                    |
| `plugin/hooks` (the mod) | Bind crew-net to a Claude Code session                      | Engine events → session signals, band, context, wake submit, tool gate, helper supervision                           | Claude Code hooks                                                                                    | Engine API usage                     | Claude Code engine               | Engine API changes                                      |
| `plugin/skills`          | Tell the model how to be a lead                             | Reading the digest, addressing, `depends-on`, the keyword rule                                                       | `SKILL.md`                                                                                           | —                                    | model context                    | Wording                                                 |
| `repo-kit`               | Optional server-side enforcement                            | `crew-deps` check workflow, draft-gate snippet                                                                       | YAML files and docs                                                                                  | —                                    | GitHub Actions in adopting repos | GitHub Actions changes                                  |

## Dependency rules

Allowed direction, left depends on right:

```text
plugin/hooks ──► core/{delivery,trust} ──► protocol
     │
     └──(process: helper events, `crew-net gate --json`)──► cli / helper

cli, helper ──► app ──► core/* ──► protocol
                 │
                 └──► ports ◄── adapters/*   (adapters implement ports)
```

Rules:

1. `protocol` imports nothing from the repo.
2. `core/*` imports only `protocol` and its own submodules. No I/O, no `node:`
   modules, no `fetch`, no clock: time is a parameter.
3. `app` imports `core`, `protocol` and `ports`. Never an adapter.
4. Each adapter imports `ports` and `protocol` only. Adapters do not import
   each other.
5. `cli` and `helper` are the only composition roots: they build adapters and
   pass them to `app`.
6. The mod imports only `protocol`, `core/delivery` and `core/trust`. It
   reaches GitHub, git and the store only through the helper and the CLI.
7. Runtime dependencies: none beyond Node 22 and the `git` and `gh` binaries.

## Integration contracts

Strength uses the Balanced Coupling scale: contract (only a published
interface is shared) < model (a domain model is shared) < functional (shared
behaviour assumptions) < intrusive (internals). Distance grows from the same
module, to another module, to another process, to another machine or vendor.

### Mod → helper (process)

- Strength: contract. Distance: high (engine runtime to Node process).
  Volatility: medium.
- Balanced: yes, with a versioned schema and contract tests on both sides.
- Contract: NDJSON over the helper's stdin and stdout, every line
  `{"v":1,"type":...}`.
  - helper → mod: `ready`, `item` (an inbound message, finding or digest entry,
    with a stable `id`), `status`, `error`.
  - mod → helper: `hello` (lead name, Claude pid, cwd, settings),
    `ack {id, outcome}`, `post` (a reply to send), `bye`.
- Durability: the helper writes an item to its inbox before emitting it, and
  removes it only on `ack`. A restart replays unacked items; the mod dedupes by
  `id`.
- Failure modes: helper killed on every hot reload (expected), helper crash
  (mod restarts it with backoff), unknown `v` (the mod shows a version-mismatch
  status and stops, never guesses).

### Mod → CLI gate (process, per tool call)

- Strength: contract. Distance: high. Volatility: low.
- Contract: `crew-net gate --json -- <argv>` → `{"decision":"allow"}` or
  `{"decision":"deny","reasons":[...]}`. Exit 0 either way; any other exit is a
  gate failure, and the gate denies merges when it fails (fail closed).
- Why a fresh process: the merge decision needs current GitHub state, not the
  helper's last poll.

### Mod → Claude Code engine

- Strength: model (the mod uses the engine's event and `$` model). Distance:
  high (vendor). Volatility: high.
- Balanced: only if the mod stays thin. All decisions are in `core`, so an
  engine change touches `plugin/hooks` alone.
- Relied-on behaviour, from the spike: `prompt.submit` with `context`;
  `prompt.edit` per keystroke; `$.prompt.read`; a plugin submit queued until
  idle and keeping the draft; `$.store` across sessions; `$.state` across hot
  reloads only; the Claude pid as the parent pid of `$.process.run`.
- Each relied-on behaviour has a test in the mod's `claude plugin test` suite,
  so an engine upgrade that breaks it fails a test.

### app → GitHub, git, store (ports)

- Strength: contract (port interfaces). Distance: low (same process).
  Volatility: medium for GitHub, low for git and store.
- Balanced: yes. The ports keep GitHub's limits and quirks inside
  `adapters/github`.
- `GitHubPort` (shape, not final): `listOpenPulls`, `listCommentsSince`,
  `getPull`, `postComment`, `updatePullBody`, `disableAutoMerge`,
  `requestStats`.
- `GitPort`: `fetch`, `worktreeBranches`, `mergeTree(a, b)`,
  `changedPaths(a, base)`.
- `StorePort`: `cursor`, `inbox` (put, list, ack), `outbox` (open requests),
  `leases` (claim, renew, release, holder), `seen`.

### crew-net ↔ crew-net on another machine (GitHub)

- Strength: contract (published language). Distance: highest (another
  machine, another person, maybe another version). Volatility: low by rule.
- Contract: the state block (`<!-- crew-net v1 ... -->`) and the message
  address line (`crew → dev/name`), defined in `protocol` and in design.md.
- Compatibility rules: readers ignore unknown fields; a new required field
  needs `v2`; writers never emit a version they cannot read; a reader that
  sees a higher major version shows it and does not write that PR's block.

### crew-net → adopting repo rules

- Contract: no closing keyword anywhere in title, body or commits;
  `findClosingKeywords` mirrors reflex's `check-pr-body.py` cases.
- `repo-kit` workflows are opt-in files; nothing in the client requires them.

## Key flows

1. **Inbound message.** helper polls `listCommentsSince` → `protocol.parseAddress`
   → `core/routing.route` → if this lead: store `inbox.put` → emit `item` →
   mod `core/delivery.decide(item, signals)` → band, context or wake → mod
   `ack`. Change locality: a new routing rule touches `core/routing` only.
2. **Wake turn.** mod `decide` returns wake → `$.prompt.submit` without
   awaiting it → during that turn every tool call goes through
   `core/trust.wakeToolPolicy`; merges, file edits and arbitrary shell commands
   are denied, `crew-net post` and read-only `gh`/`git` are allowed.
3. **Radar.** helper `GitPort.fetch` → `worktreeBranches` and open PRs →
   `mergeTree` per pair → `core/radar.classify` → findings as items.
4. **Merge gate.** mod `tool.call` on `gh pr merge` → `crew-net gate` →
   `GitHubPort.getPull` for the PR and each dependency → `core/order.gateDecision`.
5. **Digest.** helper on `hello` and on a changed session id →
   `core/digest.compose` → one `item` of kind `digest`.

## Test specifications

### protocol

- Round-trip: render then parse equals the input, for every field.
- Tolerant reader: unknown fields kept out of the model, no error.
- Keyword guard: every case from reflex's `check-pr-body.py` self-test
  (`closes #945`, `Closes: #945`, `fixes owner/repo#945`, `**closes** #945`,
  URL form) is found; `Refs #945` is not; HTML comments are scanned.
- Address: `crew → maria/orion`, `crew → maria`, malformed lines rejected.

### core

- Table-driven tests per rule, input data to decision, no mocks.
- delivery: active (draft, recent edit, recent prompt) holds; idle and
  addressed wakes only when auto-wake is on; never wake with a draft present.
- routing: each of the four steps, and that exactly one recipient or `wait`
  comes out.
- trust: a wake turn denies `gh pr merge`, `Edit`, `Write` and non-allowlisted
  `Bash`; allows `crew-net post`.
- radar: conflict, overlap, contract path, own-branch pairs skipped, bots
  skipped.
- order: unmerged dependency denies, merged allows, `--auto` with an open
  dependency denies, cross-repo reported but not blocking.

### app

- Against in-memory port fakes: durable-before-ack (crash after `inbox.put`
  replays), dedupe by id, cursor advance only after store write, write budget
  stops posting at the limit.

### adapters

- github: recorded HTTP fixtures; ETag reuse; `304` path; 401 triggers one
  token re-read; `Retry-After` honoured. One opt-in live test against the
  sandbox repo.
- git: temporary repos with real `git`; `merge-tree` conflict and clean cases.
- store: atomic write under concurrent writers; lease expiry and takeover.

### mod

- `claude plugin test` with seeded `$.store`: helper events become band
  entries; context is attached and labelled; wake skipped with a draft; tool
  gate denies merge during a wake turn; version mismatch stops delivery.

### End to end

- Two simulated laptops on one Mac (separate clone, `XDG_STATE_HOME`,
  `CLAUDE_CONFIG_DIR`, `GH_CONFIG_DIR`, `PI_CODING_AGENT_DIR`), agterm
  sessions, the private sandbox repo. Scenarios in the v0.1.0 plan.

## Architecture fitness checks

Run in CI on every PR:

- dependency-cruiser rules for the dependency rules above (protocol imports
  nothing; core has no adapter, `node:` or `fetch` imports; app imports no
  adapter; adapters do not import each other; the mod imports only
  `protocol`, `core/delivery`, `core/trust`).
- The mod bundle build fails on any `node:` import.
- `package.json` has no runtime dependencies.
- Protocol fixtures are shared by the helper and mod contract tests, so a
  schema change breaks both or neither.

## Decisions and trade-offs

- **Pure core, bundled into the mod.** Chosen because delivery needs session
  signals that exist only in the mod, and trust must be enforced there. The
  alternative was asking the helper for every decision over the pipe, which
  adds latency and a failure mode to every keystroke-driven decision.
  Revisit if the core grows past what is comfortable to bundle.
- **Gate through a fresh CLI process.** Chosen for current GitHub state at
  merge time. Costs about one second per merge command. Revisit if merges
  become frequent enough to matter.
- **One package, folders as modules.** Chosen for one release unit and one
  version. Boundaries are held by the fitness checks, not by package splits.
  Revisit when a second harness adapter (Pi, Codex) needs `core` alone.
- **No envelope in comments.** Chosen to start with plain addressing. The
  protocol has a slot for a `crew v1` envelope if messages get lost.

## Self-review

| Issue                                         | Severity | Resolution                                                             |
| --------------------------------------------- | -------- | ---------------------------------------------------------------------- |
| Mod could grow logic and couple to the engine | high     | Rule 6 and the fitness check keep decisions in `core`                  |
| Version skew across machines                  | high     | Versioned published language with tolerant-reader rules                |
| Trust enforced only by prompt                 | high     | Wake-turn tool policy in `core/trust`, enforced by the mod's tool gate |
| Two helpers on one laptop double-post         | medium   | Single recipient by routing plus leases; posting is per lead           |
| Gate unavailable when the CLI fails           | medium   | Fail closed on merges; `doctor` reports it                             |
| One package lets imports drift                | medium   | dependency-cruiser in CI                                               |

## Handoff

- Next step: the v0.1.0 plan in [plans/v0.1.0.md](plans/v0.1.0.md).
- Acceptance signals: the fitness checks pass in CI; the end-to-end scenarios
  pass on the sandbox repo; an architecture review after implementation finds
  no rule violations.
