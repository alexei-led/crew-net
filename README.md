# crew-net

crew-net lets coding-agent sessions on different laptops see each other's work
on shared GitHub repos, catch collisions early, ask each other for things, and
merge in the right order. GitHub is the only transport: PRs, comments,
notifications and `git fetch`.

## Install (Claude Code)

```text
claude plugin marketplace add alexei-led/crew-net
claude plugin install crew-net@crew-net
```

Needs Node 22+, `git` and an authenticated `gh`. The plugin ships the
`crew-net` CLI. See [plugin/README.md](plugin/README.md).

## Docs

- [docs/design.md](docs/design.md): the design.
- [docs/plan.md](docs/plan.md): the build plan.
