# cli

The `crew-net` binary (`dist/crew-net.js`, `make build`): argument parsing,
`--json`, and the composition root that builds real adapters
([runtime.ts](runtime.ts)).

## Adding a command

Write a `Command` in its own file under [commands/](commands/) and add it to
`COMMANDS` in [commands/index.ts](commands/index.ts):

```ts
export const example: Command = {
  name: "example",
  summary: "One line for crew-net --help",
  usage: "Usage: crew-net example <x> [--flag v] [--json]",
  spec: { values: ["--flag"], switches: ["--dry-run"] },
  async run(ctx) {
    const ports = ctx.runtime.ports(); // AppPorts: store, clock, env, github(host), git(dir), settings
    ctx.io.out(ctx.json ? `${JSON.stringify({})}\n` : "text\n");
    return 0;
  },
};
```

- `main` adds the global `--json`, `--repo owner/repo` and `--help` to every
  command. Unknown or valueless flags are a usage error (exit 2), and so is a
  thrown `UsageError`. Any other error prints `crew-net <cmd>: <message>`
  and exits 1.
- `ctx.args`: `positional`, `values` (flag → every value given) and
  `switches`. `single(args, "--flag")` refuses a repeated flag.
- `crew-net` with no command, or with a flag first, runs `digest`.
- `ports()` is built on first use, so `--help` and `--version` touch no disk.
- `runtime.detach(args)` starts `crew-net <args>` in the background.

## Commands here

| Command                            | Notes                                                                                                                                                                               |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `crew-net [digest]`                | From the store. Stale: starts `sync --once` detached, prints "refreshing". `--refresh` waits for one sync. `--format context` frames it for hooks and prints nothing outside a repo |
| `who [paths…]`                     | Paths relative to the cwd. Current and watched repos                                                                                                                                |
| `inbox`, `stats`                   |                                                                                                                                                                                     |
| `doctor`                           | Exit 1 when a check fails. Plugin from `$CLAUDE_CONFIG_DIR` or `~/.claude` `plugins/installed_plugins.json`                                                                         |
| `sync [--once] [--detach]`         | One pass. Exit 1 when a job failed                                                                                                                                                  |
| `session beat\|end --session <id>` | `--harness`, `--role` (default `CREW_NET_ROLE`, else lead), `--pid` (default parent), `--prompt`                                                                                    |
| `watch --session <id>`             | The mod's child; see [watch](../watch/README.md)                                                                                                                                    |

`ask`, `request` and `reply` refuse to run in a worker session
(`CREW_NET_ROLE=worker`): its lead speaks for it.

Developer settings come from `${XDG_CONFIG_HOME:-~/.config}/crew-net/config.json`
(`autoWake`, `agentsMerge`, `idleMinutes`, `watch`, `mute`); a bad value keeps
its default and shows in `doctor`.

```sh
bun test src/cli
CREW_NET_LIVE=1 bun test src/cli/live.test.ts   # clones alexei-led/crew-net-sandbox
```
