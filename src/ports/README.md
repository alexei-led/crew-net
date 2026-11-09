# Ports

[Interfaces](index.ts) for effects the app needs: GitHub, git, store, clock and
environment. They depend only on the published protocol, never on core or adapters.
The app maps adapter facts into core input types.

## GitHub

`GitHubPort` is one adapter per host; every repo argument is `owner/repo`
(design §12). It returns plain facts: `PullRequest`, `IssueComment`,
`PullReview`, `NotificationThread`, `MergedPull`, `RequestStats`. Author fields
are GitHub logins from the API, never comment text.

PullRequest has number, nodeId, title, author, headRef, headSha, baseRef,
state (`open`/`closed`), draft, body, updatedAt, autoMerge, merged. Null bodies
become empty strings; merged is definitive on getPull and false in lists.

`notifications(since)` returns threads with a crew-net reason, `modified` and
`pollIntervalMs`. `listThreadComments(repo, n, after)` returns comments strictly
after a `CommentCursor` `(updatedAt, id)`.

`notifications` also returns `ssoPartialOrgs`: orgs GitHub left out because
the token lacks SSO authorization. The adapter keeps HTTP validators, the write
log and rate-limit backoff in `StorePort.kv`, so they survive across processes.

## Store

`StorePort` is the local store of design §8.3, shared by sync and every
session on the laptop: inbox items with delivery claims, the outbox of my open
requests, session heartbeats, per-repo snapshot and radar JSON, named cursors,
`jobs.run` (lock plus freshness check), a small KV for the HTTP cache and write
budget, the `events.ndjson` log and `prune`. Times are epoch milliseconds from
the `ClockPort` the adapter is given. Snapshot and radar are `JsonValue`; their
schema belongs to the app. See [store semantics](../adapters/store/README.md).

## Git

`worktreeBranches` returns `{ path, branch }`. `remoteBranches` returns
`{ name, lastCommitAt, authorEmail, loginHint }` for bare-branch owners.
`mergeBase` is `undefined` without shared history. `changedFiles(base, head)`
diffs from the merge base.

## Environment

`repoIdentity()` returns `{ host, repo }`; `githubToken(host)` reads the token
for that host. `stateDir()` and `configDir()` follow XDG. managedHooksOnly
returns `{status:"known",enabled:boolean}` or `{status:"unknown",reason:string}`.
Callers must not treat unknown as false.

ClockPort is unchanged; the store adapter takes a ClockPort.
