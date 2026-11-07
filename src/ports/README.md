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

Inbox put/list use protocol `ItemEvent`. Acknowledgement removes only the id.
Outbox adds put/ack around open; `OutboundRequest` carries id, issueNumber, to,
body and createdAt. The app decides when a request is answered.

Lease claim/renew take `(name, holder, nowMs)`, release takes `(name, holder)`,
and holder takes `(name, nowMs)`. Holder ids are strings, not helper PIDs.
See [store semantics](../adapters/store/README.md).

## Environment

repoIdentity remains an owner/repo string. managedHooksOnly returns the
`ManagedHooksPolicy` union: `{status:"known",enabled:boolean}` or
`{status:"unknown",reason:string}`. Callers must not treat unknown as false.

GitPort and ClockPort are unchanged.
