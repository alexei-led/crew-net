# Environment adapter

`new EnvAdapter({ repoDir, runner?, policyPaths? })` implements
[EnvPort](../../ports/index.ts). The default runner uses execFile with argv,
no shell, a 30-second timeout and a 1 MiB output limit.

- `githubToken()` runs `gh auth token`. Empty output or command failure throws
  `EnvCommandError`. Tokens, command stderr and underlying error causes are
  never logged or included in errors.
- `repoIdentity()` runs `git remote get-url origin` in repoDir and returns
  `owner/repo`. HTTPS, SCP-style SSH and ssh:// remotes are supported, including
  a .git suffix. Local paths and remotes without exactly owner/repo are rejected.
- `managedHooksOnly()` checks
  `/Library/Managed Preferences/<user>/com.anthropic.claudecode.plist`, then
  `/Library/Managed Preferences/com.anthropic.claudecode.plist`.
  Existing files are converted using `plutil -convert json -o - <path>`.
  The first boolean allowManagedHooksOnly wins. A missing file or absent key
  falls through; no setting means `{status:"known", enabled:false}`.
  Inaccessible files, conversion failures, malformed JSON and non-boolean values
  return `{status:"unknown", reason}`, never a false policy result.

Inject the runner and ordered policy paths for tests. This adapter only reads
machine state; it never changes managed preferences.

```sh
bun test src/adapters/env
```
