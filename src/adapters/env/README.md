# Environment adapter

`new EnvAdapter({ repoDir, runner?, policySources?, platform?, env?, home? })`
implements [EnvPort](../../ports/index.ts). The default runner uses `execFile`
with argv, no shell, a 30 s timeout and a 1 MiB output limit.

- `repoIdentity()` runs `git remote get-url origin` and returns
  `{ host, repo }`. HTTPS, `ssh://` and SCP-style remotes are supported; the
  host is lowercased and the port dropped. Local paths and remotes without
  exactly `owner/repo` are rejected. An SSH config alias as host
  (`git@work:org/repo`) is returned as is.
- `githubToken(host)` runs `gh auth token --hostname <host>`. Empty output or
  failure throws `EnvCommandError`. Tokens, stderr and causes never appear in
  errors.
- `stateDir()` is `${XDG_STATE_HOME:-~/.local/state}/crew-net`, `configDir()`
  `${XDG_CONFIG_HOME:-~/.config}/crew-net`. A relative XDG value is ignored, as
  the XDG spec says.
- `managedHooksOnly()` reads Claude Code managed settings for
  `allowManagedHooksOnly`. Sources, first that sets the key wins:

  | Platform | Sources                                                                                                                                                                                                                                                          |
  | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | macOS    | `/Library/Managed Preferences/<user>/com.anthropic.claudecode.plist`, `/Library/Managed Preferences/com.anthropic.claudecode.plist` (via `plutil -convert json`), `/Library/Application Support/ClaudeCode/managed-settings.d/*.json`, `…/managed-settings.json` |
  | Linux    | `/etc/claude-code/managed-settings.d/*.json`, `/etc/claude-code/managed-settings.json`                                                                                                                                                                           |
  | other    | none: `unknown`                                                                                                                                                                                                                                                  |

  Drop-ins are read in name order and the last one that sets the key wins;
  dotfiles and non-`.json` files are skipped. Missing files fall through; no
  setting anywhere is `{ status: "known", enabled: false }`. An unreadable
  file, malformed JSON or a non-boolean value is
  `{ status: "unknown", reason }`, never "off".
  Limit: server-managed settings are not on disk and are not checked.

Inject the runner, policy sources, env and home for tests. The adapter only
reads machine state.

```sh
bun test src/adapters/env
```
