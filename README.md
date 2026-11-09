# crew-net

Coding-agent sessions on different laptops see each other's work on shared
GitHub repos, catch collisions early, ask each other for things, and merge in
the right order. GitHub is the only transport: PRs, comments, notifications
and `git fetch`. No server, no daemon, no repo changes needed.

## Why

On one laptop, agents can talk before they push. Across laptops they first
meet as a merge conflict, a red CI run after a rebase, or a consumer that
deploys before its producer, because merge to `main` is the deploy. crew-net
moves that meeting to the first push:

- **Awareness.** At session start your agent sees who works on what in this
  repo, what touches your files, and what merged since you branched.
- **Early collision warning.** Conflicts and overlaps with pushed branches
  show up within minutes, not at merge time.
- **Requests.** One agent asks another a question or for a review, fix or bug
  fix; the answer comes back into the asking session. Each message is a normal
  PR comment, so colleagues without crew-net can answer by hand.
- **Merge order.** A PR declares `depends-on`; agents cannot merge it early,
  the author learns the moment it is unblocked, and the producer sees who
  waits on them.

## Install

Needs Node 22+, `git`, and `gh` signed in (`gh auth login`). In Claude Code:

```text
claude plugin marketplace add alexei-led/crew-net
claude plugin install crew-net@crew-net
```

Then run `crew-net doctor` in a repo. It names the next step if anything is
missing. Pi and Codex: CLI plus an `AGENTS.md` snippet, see
[docs/harnesses.md](docs/harnesses.md).

## 60-second tour

Start a Claude Code session in a working copy. The digest is in the model's
context and in the band above the prompt:

```text
crew-net · acme/app · feat/users-tier
You     #2310 building  api/openapi/ (2 files)        depends on #2301 (open)
Others  maria   #2318 review   api/openapi/users.yaml  ⚠ conflicts with #2310: users.yaml
        dmitri  feat/billing  no PR, pushed 14 min ago  web/billing/
Merged since you branched: #2305 touches api/server.ts (yours)
Inbox   maria asks on #2310: "Does #2310 need the new column first?"  12 min
```

Your agent uses the CLI through Bash, and so can you:

```sh
crew-net who api/openapi/                    # who else touches these paths
crew-net ask #2318 "is users.tier nullable?" # a comment on maria's PR, @mentioning her
crew-net inbox                               # unread items, open requests both ways
crew-net reply <item> --done "fixed in #2320"
crew-net dep add #2301                       # this PR merges after #2301
gh pr merge --auto                           # run by the agent: denied while #2301 is open
```

When #2301 merges, an `unblocked` item arrives and the merge goes through. If
your session sits idle and maria asks it something, it wakes, reads, and
replies, and may do nothing else.

## Docs

- [User guide](docs/user-guide.md): setup, daily use, commands, settings,
  adoption levels, failure modes, token and security.
- [Other harnesses](docs/harnesses.md): Pi, Codex, the `AGENTS.md` snippet.
- [Design](docs/design.md) and [plan](docs/plan.md).
- [Releasing](docs/releasing.md): version bump, tag, what the workflow checks.
- [Claude Code plugin](plugin/README.md), [repo kit](repo-kit/README.md)
  (the optional `crew-deps` required check), [end-to-end results](e2e/README.md).
- [Changelog](CHANGELOG.md).

## Development

```sh
bun install --frozen-lockfile
make check   # types, lint, tests, dependency rules, claude plugin test
make build   # dist/crew-net.js and the bundled plugin files
```

MIT licensed.
