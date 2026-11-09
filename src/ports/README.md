# Ports

[Interfaces](index.ts) for effects the app needs: GitHub, git, store, clock and
environment. They depend only on the published protocol, never on core or adapters.
The app maps adapter facts into core input types.

## GitHub

`GitHubPort` returns `PullRequest`, `IssueComment`, and `RequestStats` instead of
unknown values. Author fields are GitHub logins from the API, not comment text.

PullRequest includes number, nodeId, title, author, headRef, headSha, baseRef,
draft, body, updatedAt, autoMerge, merged. Null bodies become empty strings;
merged is definitive on getPull and false for open-list results.

IssueComment includes id, issueNumber, author, body, createdAt, updatedAt, url.
All timestamps remain GitHub ISO strings; comments include Issues as well as PRs.
Stats fields are requests, notModified, writes and rateLimitRemaining.

## Store

`StorePort` is the local store of design §8.3, shared by sync and every
session on the laptop: inbox items with delivery claims, the outbox of my open
requests, session heartbeats, per-repo snapshot and radar JSON, named cursors,
`jobs.run` (lock plus freshness check), a small KV for the HTTP cache and write
budget, the `events.ndjson` log and `prune`. Times are epoch milliseconds from
the `ClockPort` the adapter is given. Snapshot and radar are `JsonValue`; their
schema belongs to the app. See [store semantics](../adapters/store/README.md).

## Environment

repoIdentity remains an owner/repo string. managedHooksOnly returns the
`ManagedHooksPolicy` union: `{status:"known",enabled:boolean}` or
`{status:"unknown",reason:string}`. Callers must not treat unknown as false.

GitPort and ClockPort are unchanged; the store adapter takes a ClockPort.
