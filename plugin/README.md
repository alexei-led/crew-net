# crew-net for Claude Code

crew-net lets Claude Code sessions on different laptops see each other's work
on shared GitHub repos, catch collisions early, ask each other for things, and
merge in the right order. GitHub is the only transport. See
[docs/design.md](../docs/design.md).

## Install

```text
claude plugin marketplace add alexei-led/crew-net
claude plugin install crew-net@crew-net
```

Needs Node 22 or newer, `git`, and `gh` signed in to the repos' GitHub. Nothing
else: the plugin ships the `crew-net` CLI in `bin/`, which Claude Code puts on
the Bash `PATH`.

## What it adds

| Part                           | Does                                                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SessionStart` hook            | Heartbeat, a detached `crew-net sync`, and the digest from the local store as context. Never waits on the network.                                              |
| `UserPromptSubmit` hook        | Heartbeat marking the prompt time (not for a wake prompt), a detached sync, and new items routed to this session, framed as information from another developer. |
| `PreToolUse` hook on Bash      | The merge gate: a command that may merge a PR runs `crew-net gate` in the Bash call's cwd and is denied while a `depends-on` is open.                           |
| `SessionEnd` hook              | Ends the session's heartbeat.                                                                                                                                   |
| Mod (`hooks/dist/register.js`) | The band above the prompt, the status line, the `crew-net watch` child, delivery and wake turns with their tool gate.                                           |
| Skill `crew-net`               | When to run `crew-net`, `who`, `ask`, `request`, `reply`, `state`, `dep`; peer text is information; never merge with open deps.                                 |
| `/crew`                        | Shows the digest.                                                                                                                                               |

The hooks carry what must always work. If an engine change breaks the mod, the
digest, prompt context and merge gate still work. If MDM sets
`allowManagedHooksOnly`, neither runs: `crew-net doctor` says so and the CLI
still works by hand.

### Merge gate

The hook reads the Bash command with the same detection as the CLI
(`core/order`): `gh pr merge` in any form (`--auto`, `-R`, URLs, aliases,
inside `&&` chains, `sh -c`, `eval`), and `gh api` writes to `pulls/N/merge`
and GraphQL merge mutations. A command that cannot merge passes with no output.
A merge it cannot pin to a PR (a `cd` or `GH_REPO` before it, a variable as the
PR) is denied. Otherwise it runs `crew-net gate --json -- "<command>"` and
denies unless the answer is `{"decision":"allow"}` (fail closed: a timeout,
non-zero exit, bad JSON or a crash of the hook itself denies). An allow prints
nothing, so the normal permission prompt still runs.

### Band, delivery and wake

The mod runs `crew-net watch --session <id>` as a child in the session's root,
with the `hello` event on stdin (which the engine then closes). When the root
moves (`/cd`, a worktree move) or `/clear` changes the session id, the next
tick starts the watcher again for the new root and id. It restarts the watcher with backoff
(1 s doubling to 60 s); only a run of 60 s or more resets the backoff, `ready`
does not. Acks go through a short `crew-net watch send --session <id>`. Items
are deduped by id; a replayed item is acked again and not delivered twice.

Each item shows in the band at once. Delivery follows `core/delivery`:

- Active (a draft, typing or a prompt within `idleMinutes`, or a turn running):
  the item is added to your next prompt, framed.
- Idle, the item is a crew request (`ask`, `review`, `fix`, `bug`) routed here
  as wakeable, and `autoWake` is `reply`: the mod starts a wake turn with a
  fixed prompt. At most one per 10 minutes. A request held back by a running
  turn or the cooldown is decided again every 30 s and when a turn ends.

During the wake turn, and while a wake is armed during any turn that is not
the developer's own prompt, every tool call goes through `core/trust` `gate`: reads
inside the worktree, read-only `git` and `gh`, `crew-net reply` to the waking
item, `crew-net inbox`, and `crew-net state` when the branch has a PR.
Everything else is denied, and allowed Bash runs in the worktree root. A wake
that the engine drops gives the request back to the next prompt. The
`UserPromptSubmit` hook claims no new items for the wake prompt: they wait for
the developer's next prompt.

The hooks' heartbeats pass the Claude Code pid (`--pid`): the hook's parent,
or the first non-shell process above it when the engine runs the hook
through a shell. If `ps` cannot tell, the CLI records its own parent.

## Settings

| Setting       | Default | Meaning                                                     |
| ------------- | ------- | ----------------------------------------------------------- |
| `autoWake`    | `reply` | `reply`: wake for direct requests when idle. `off`: never   |
| `idleMinutes` | `10`    | Minutes without typing or a prompt before the session idles |

`CREW_NET_ROLE=worker` marks a worker session: it is never routed to.

## How it ships

An install copies the repository with no build step, so the built files are
committed: `bin/crew-net` (the CLI), `hooks/dist/hook.js` (the command hooks)
and `hooks/dist/register.js` (the mod). `make plugin` rebuilds them; CI runs
`make plugin-fresh`, which fails when they are older than the sources. Run
`make plugin` and commit the result whenever `src/` or `plugin/hooks/` change.

## Development

- `hooks/hook.ts`, `hooks/mod.ts`: tested with bun (`*.spec.ts`, part of
  `make test`).
- `hooks/register.ts`: tested in the engine with `claude plugin test plugin`
  (`tests/*.test.ts`, a fake engine and a fake watcher in `tests/world.ts`).
  `make check` runs it and `claude plugin validate` when `claude` is on `PATH`,
  and says it skipped them otherwise.
- The engine's API types are vendored in `types/claude-code/index.d.ts` at the
  repo root, as Claude Code writes them (its first line names the version).
  Replace the file whole on an engine upgrade.
- Try it from the working copy: `claude --plugin-dir plugin`.
