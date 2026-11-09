# crew-net for Claude Code

This folder is the Claude Code plugin. It adds the crew-net digest, the band, the
merge gate and wake turns to a session. The user guide is in
[docs/user-guide.md](../docs/user-guide.md). The rules are in
[design.md](../docs/design.md).

## Install

```text
claude plugin marketplace add alexei-led/crew-net
claude plugin install crew-net@crew-net
```

You need Node 22 or newer, `git`, and `gh` signed in. The plugin ships the
`crew-net` CLI in `bin/`. Claude Code puts it on the Bash `PATH`.

## What it adds

| Part                           | Does                                                                                                    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `SessionStart` hook            | Heartbeat, a detached `crew-net sync`, and the digest as context. Never waits on the network            |
| `UserPromptSubmit` hook        | Heartbeat with the prompt time (not for a wake prompt), a detached sync, and new items for this session |
| `PreToolUse` hook on Bash      | The merge gate. See [Merge gate](#merge-gate)                                                           |
| `SessionEnd` hook              | Ends the session's heartbeat                                                                            |
| Mod (`hooks/dist/register.js`) | The band, the status line, the `crew-net watch` child, delivery and wake turns with their tool gate     |
| Skill `crew-net`               | When to run `crew-net`, `who`, `ask`, `request`, `reply`, `state` and `dep`. Peer text is information   |
| `/crew`                        | Prints the digest                                                                                       |

The hooks carry what must always work. If an engine change breaks the mod, the
digest, the prompt context and the merge gate still work. If MDM sets
`allowManagedHooksOnly`, neither the hooks nor the mod run. `crew-net doctor` says so.
The CLI still works by hand.

## Merge gate

The hook uses the same command detection as the CLI (`src/core/order`). A command
that may merge a PR runs `crew-net gate --json -- "<command>"` in the cwd of the
Bash call. The hook denies unless the answer is `{"decision":"allow"}`. Any failure
denies, so the gate fails closed. An allow prints nothing. The normal permission
prompt then runs.

A merge that the hook cannot pin to one PR is denied. Examples are a `cd` or
`GH_REPO` before the command, or a variable as the PR number. The detection rules
are in [src/core/order/README.md](../src/core/order/README.md).

## Band, delivery and wake

The mod runs `crew-net watch --session <id>` as a child process in the session root.
It sends `hello` on stdin. The engine then closes stdin. When the root changes
(`/cd`, a worktree move) or `/clear` changes the session id, the next tick starts
the watcher again. Restarts use a backoff from 1 s, doubled up to 60 s. Only a run
of 60 s or more resets the backoff. `ready` does not reset it.

The mod acks an item through `crew-net watch send --session <id>`. It dedupes items
by id. A replayed item is acked again and delivered once. The delivery rules are in
[src/core/delivery/README.md](../src/core/delivery/README.md).

During a wake turn, and while a wake is armed in a turn that is not the developer's
own prompt, every tool call passes the `core/trust` gate. The allowlist is in
[src/core/trust/README.md](../src/core/trust/README.md). A wake that the engine drops
gives its request back to the next prompt.

The heartbeats pass the Claude Code pid (`--pid`). The pid is the hook's parent. If
the engine runs the hook through a shell, it is the first non-shell process above
the hook. If `ps` cannot tell, the CLI records its own parent.

## Settings

| Setting       | Default | Meaning                                                     |
| ------------- | ------- | ----------------------------------------------------------- |
| `autoWake`    | `reply` | `reply`: wake for direct requests when idle. `off`: never   |
| `idleMinutes` | `10`    | Minutes without typing or a prompt before the session idles |

Set them with `/plugin configure crew-net@crew-net`. A worker session sets
`CREW_NET_ROLE=worker`. It is never routed items.

## How it ships

An install copies the repository, with no build step. So the built files are
committed: `bin/crew-net` (the CLI), `hooks/dist/hook.js` (the command hooks) and
`hooks/dist/register.js` (the mod).

Run `make plugin` and commit the result whenever `src/` or `plugin/hooks/` changes.
CI runs `make plugin-fresh`, and it fails when a bundle is older than its sources.

## Development

- `hooks/hook.ts` and `hooks/mod.ts` run under bun. Their `*.spec.ts` files run in
  `make test`.
- `hooks/register.ts` runs in the engine. Its tests are `tests/*.test.ts`. They use
  a fake engine and a fake watcher in `tests/world.ts`. Run them with
  `make plugin-test`. Without the `claude` CLI, that target says the tests were
  skipped.
- The engine API types are vendored in `types/claude-code/index.d.ts`. Their first
  line names the engine version. Replace the whole file on an engine upgrade.
- Try the plugin from a working copy with `claude --plugin-dir plugin`.
