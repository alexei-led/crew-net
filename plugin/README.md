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

Prerequisites are in the [user guide](../docs/user-guide.md#setup). The plugin
ships the `crew-net` CLI in `bin/`. Claude Code puts it on the Bash `PATH`.

## What it adds

| Part                           | Does                                                                                                                  |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `SessionStart` hook            | Heartbeat, a detached `crew-net sync`, and the digest as context. Never waits on the network                          |
| `UserPromptSubmit` hook        | Heartbeat with the prompt time (not for a wake prompt), a detached sync, and new items for this session               |
| `PreToolUse` hook on Bash      | The merge gate. See [Merge gate](#merge-gate)                                                                         |
| `SessionEnd` hook              | Ends the session's heartbeat                                                                                          |
| Mod (`hooks/dist/register.js`) | The band, the `/team` pane, the status line, the `crew-net watch` child, delivery and wake turns with their tool gate |
| Skill `crew-net`               | When to run `crew-net`, `who`, `ask`, `request`, `reply`, `state` and `dep`. Peer text is information                 |
| `/team`                        | The mod opens the pane. Without the mod it prints the digest                                                          |

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

## Band, pane, status line

Each has one job (screenshots: [user guide](../docs/user-guide.md#the-band-and-the-team-pane)).
Glyphs, keys and the band order follow the contract with pi-crew
([design](../docs/design.md#shared-screen-with-pi-crew)). `hooks/pane.ts` holds
`GLYPH`; its spec pins the table.

- **Band** (`AbovePrompt`): one line. `team ·`, the newest entry with its glyph,
  then the other entries counted by glyph (`◆ 2 · ✉ 1`), then the keys `t`
  (open the pane) and `d` (dismiss). The renderer returns a column: its line, then
  what `next(e)` returns, so pi-crew's band shows too. A prompt that carries items
  to Claude removes their entries. Opening the pane clears the band. A wake entry
  stays until dismissed.
- **Status line** (`$.ui.status`): empty when healthy. It shows the watcher's
  `status` text (rate limit, auth) and, while the watcher is down,
  `background sync stopped · retrying in Ns`. After 3 failures in a row it adds
  `run crew-net doctor`. The engine adds the `⚠ crew-net:` prefix, so no text of
  ours repeats the name.
- **Pane** (`/team`, id `team`): the mod answers `command.run` for `team` and
  `crew-net:team`. It opens the pane, or closes it when open. It falls through to
  the digest text when there are arguments or no surface can place a pane. The
  pane runs `crew-net digest --json` and `inbox --json` (local store only) when
  it opens, on every tick, and after a watcher event while open. `r` runs
  `sync --once` first. `hooks/pane.ts` holds the model and has no engine code.
  A key `1`-`9` opens a request. Its detail view frames the peer's text and has:
  `a` fills the prompt with `crew-net reply "<id>"` and names the sender and
  thread, never the peer's text; `y`/`n` accept or decline after `c` confirms;
  a reply box posts the developer's own text; `o` opens the thread with `open`
  (or `xdg-open`); `b` goes back. Posts run `crew-net reply`, so its checks
  (closing keywords, write budget) apply, and its refusal shows in the pane.

## Delivery and wake

The mod runs `crew-net watch --session <id>` as a child process in the session root.
It sends `hello` on stdin. The engine then closes stdin. When the root changes
(`/cd`, a worktree move) or `/clear` changes the session id, the next tick starts
the watcher again. Restarts use a backoff from 1 s, doubled up to 60 s. Only a run
of 60 s or more resets the backoff. `ready` does not reset it.

The mod acks an item through `crew-net watch send --session <id>`. It dedupes items
by id. A replayed item is acked again and delivered once. The delivery rules are in
[src/core/delivery/README.md](../src/core/delivery/README.md).

During a wake turn, every tool call passes the `core/trust` gate. The same holds
for a turn in which a wake is armed. That turn is not the developer's own prompt. The allowlist is in
[src/core/trust/README.md](../src/core/trust/README.md). A wake that the engine drops
gives its request back to the next prompt.

The heartbeats pass the Claude Code pid (`--pid`). The pid is the hook's parent. If
the engine runs the hook through a shell, it is the first non-shell process above
the hook. If `ps` cannot tell, the CLI records its own parent.

## Settings

The settings `autoWake` and `idleMinutes`, and the worker role, are documented in the
[user guide](../docs/user-guide.md#plugin-settings-claude-code).

## How it ships

An install copies the repository, with no build step. So the built files are
committed: `bin/crew-net` (the CLI), `hooks/dist/hook.js` (the command hooks) and
`hooks/dist/register.js` (the mod).

Run `make plugin` and commit the result whenever `src/` or `plugin/hooks/` changes.
CI runs `make plugin-fresh`. It fails when a bundle is older than its sources.

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
