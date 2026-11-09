# Write commands

The commands that write to GitHub or to the working tree: `ask`, `request`,
`reply`, `state`, `dep`, `gate` and `init` (design §5.3, §7, §9.1, §11, §15).
Each handler is `(ctx: WriteContext, args) → Promise<result>`; the CLI
(`src/cli/commands/<name>.ts`) parses argv, builds the context and prints the
result (`render*`, or JSON with `--json`). Handlers use ports only.

Expected failures are a `CommandError` with a `code`: `usage` (exit 2),
`not-found`, `refused`, `closing-keyword` (exit 1). Messages name logins, refs,
ids and paths, never peer text, so the output is safe to hand to a model.
Other errors (`BudgetError`, `AuthError`, `RateLimitError`, `SsoError` from the
GitHub adapter) propagate with their own messages.

## ask and request

`crew-net ask <@login|PR> [--on #N] "<text>"`,
`crew-net request <@login|PR> review|fix|bug [--on #N] "<text>"`.

The thread (design §7.2), first match:

| Target                    | Thread                                                                                                     |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `#N`, `owner/repo#N`, URL | That PR; the recipient is its author. My own PR is refused                                                 |
| `@login --on #N`          | That PR or Issue                                                                                           |
| `@login`, kind `bug`      | A new Issue: title from the first line; the report is its first comment, so only the comment mentions them |
| `@login`                  | My open PR for the current branch ("about my work")                                                        |
| `@login`                  | Their PR, when they have exactly one open in the repo                                                      |

Anything else is a usage error that lists the choices. A closed or merged PR
is refused. The comment is:

```markdown
<!-- crew-net:msg kind=ask id=k3f9w2ab -->

@maria does #2310 need the new column first?
```

- `id` is 8 random `[a-z0-9]` characters, never derived from the text, and not
  one already in the outbox.
- The whole body (and an Issue title) goes through the closing-keyword guard
  before any write; a match is refused with the line and keyword.
- After the post the request goes to `outbox.json` (`status: open`, the first
  line of the text as summary) and `request.sent` to `events.ndjson`. If the
  outbox write fails, the error says the message was posted.
- If an Issue was opened but its report could not be posted, the error names
  the Issue so a retry uses `--on #N`.
- The write budget (20 a minute, 200 an hour, design §9.1) is the GitHub
  adapter's persisted counter in the store's KV. When it is spent the post
  fails with `BudgetError` and nothing is tracked.

## reply

`crew-net reply <item> [--done|--decline|--accept] "<text>"`. Default status
`answered`. `<item>` is an inbox item id. The item must be a crew request:
`from`, `repo`, `thread`, `event` (`ask`, `review`, `fix`, `bug`) and `msgId`.
The comment goes on the item's thread:

```markdown
<!-- crew-net:msg kind=reply re=k3f9w2ab status=done -->

@maria merged in #2318.
```

Afterwards the store KV holds `replied:<item>` = `{ status, re, atMs }`, so
`inbox` can show the request as answered, and `request.replied` is logged.

## Hosts

A PR URL on another host is a usage error. Numbers are per repo and
host, so a `ghe.corp` URL must never resolve to a `github.com` PR.

## state and dep

`crew-net state <planning|building|review|blocked> [--scope p…] [--pr #N]`,
`crew-net dep add|rm <#N|owner/repo#N|URL> [--pr #N]`.

- The PR is my open PR for the current branch, or `--pr`. Another author's PR
  and a closed PR are refused (design §13).
- The block is rewritten with `replaceStateBlock`: unknown fields are kept,
  `lead` is dropped. An unreadable block, or a `depends-on` entry the parser
  skipped, is refused: rewriting it would drop a dependency the author meant.
- Nothing is written unless `state`, `scope` or `depends-on` changes (design
  §7.1: no heartbeats). A format-only difference, such as the old `v1` tag,
  is not a change.
- `--scope` replaces the scope; without it the scope is kept.
- `dep add` stores `#N` for the PR's own repo and `owner/repo#N` otherwise,
  reads the dependency first (missing: `not-found`; closed without merge:
  refused) and refuses the PR itself. If the PR has auto-merge on and the
  dependency is not merged, it turns auto-merge off before writing the body
  (design §11), so a failed body write leaves nothing unguarded.
- Limits: the body is read, then written; an edit by someone else in between
  is lost. `depends-on` must not change while the PR is in a merge queue; the
  command cannot see the queue.

## gate

`crew-net gate [--json] -- <command>` (design §11). The command is one
argument with the whole Bash line, or its words.

1. `mayMerge` runs `core/order` `detectMerge`. No merge: `allow`, without
   reading the repo, a token or GitHub. Otherwise the CLI reads `gh alias
   list` and detects again, so an alias is checked as what it runs.
2. `deny` from detection (`eval "$X"`, a merge after `cd`): `deny`.
3. Each target: host and repo as gh picks them. A named host (`-R host/o/r`,
   a PR URL, `gh api --hostname`, an API URL) wins. A repo named without a
   host goes to `GH_HOST`, else github.com; in a clone on another host that is
   ambiguous and denied (name the host). No repo named: `GH_REPO`, else gh's
   default repo of the clone: the remote `gh repo set-default` resolved
   (`remote.<n>.gh-resolved`), else the first of upstream, github, origin, the
   rest, as `git remote -v` lists them (`insteadOf` applied). In a fork clone
   that is the parent, not origin. With `GH_HOST` set only remotes on that
   host count. A remote URL crew-net cannot parse denies. Another host is read
   with that host's token; none, or a failing read, denies. The PR is the
   number, the open PR of the named branch, or the open PR of the cwd's
   branch; a current branch whose `branch.<b>.merge` is not its own name
   (`gh pr checkout` sets `refs/pull/N/head`) denies: name the PR. The PR body is read live, then every `depends-on` on the same
   host, any repo, in parallel. `core/order` `gate` decides: open, closed or
   unreadable dependencies deny.
4. Any failure (PR unreadable, no branch, several PRs for one branch, no answer
   within 10 s) is `deny` with `failed: true` (fail closed).

```json
{
  "decision": "deny",
  "reasons": ["acme/app#10: depends-on #1 is not merged"],
  "checked": ["acme/app#10"],
  "failed": false
}
```

A split command (several words, one holding a shell operator such as `&&`,
`|` or `$`) is denied: the caller split the line, so the gate cannot see what
runs. Reasons are cleaned to one line of at most 160 characters, since they can
carry a teammate's `depends-on` value.

Exit 0 for allow and deny, 1 when the gate failed (and denied). Decisions on
merge commands are logged as `gate` events.

## init

`crew-net init [--deps] [--force]` writes into the working tree of the cwd:

| File                                    | From                              |
| --------------------------------------- | --------------------------------- |
| `.github/crew-net.yml`                  | `repo-kit/templates/crew-net.yml` |
| `.github/workflows/crew-deps.yml`       | `repo-kit/workflows/` (`--deps`)  |
| `.github/workflows/crew-deps-rerun.yml` | `repo-kit/workflows/` (`--deps`)  |
| `.github/scripts/crew-deps.mjs`         | `repo-kit/scripts/` (`--deps`)    |

The template sets every key to its default and carries the draft-gate snippet
as comments next to `early-drafts`, which stays `false` until the CI is gated.
If any target exists, nothing is written unless `--force`. It never commits or
pushes; it prints the next steps. The CLI bundles the kit as text
(`src/cli/commands/kit.ts`), so `dist/crew-net.js` needs no checkout.

## Tests

```sh
bun test src/app/commands/write src/cli/commands
CREW_NET_LIVE=1 bun test src/app/commands/write/live.test.ts
```

The live test writes only to `alexei-led/crew-net-sandbox`: it reuses (or
creates) draft PRs on `crew-net-live-a` and `crew-net-live-b`, runs `state`,
`dep`, `gate`, `ask` and `reply`, mentions only a login that does not exist,
then restores the PR bodies and deletes its comments.
