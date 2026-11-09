# GitHub adapter

`new GitHubAdapter({ host, tokenProvider, cache, budget, fetch?, now? })`
implements [GitHubPort](../../ports/index.ts) for one GitHub host with built-in
`fetch`. No SDK, no runtime dependency.

## Hosts and repos

One adapter per host. `apiUrls(host)` picks the endpoints:

| Host                                  | REST                     | GraphQL                          |
| ------------------------------------- | ------------------------ | -------------------------------- |
| `github.com`                          | `https://api.github.com` | `https://api.github.com/graphql` |
| `*.ghe.com` (GHE.com, data residency) | `https://api.<host>`     | `https://api.<host>/graphql`     |
| anything else (GHES)                  | `https://<host>/api/v3`  | `https://<host>/api/graphql`     |

Every repo method takes `owner/repo`; anything else is rejected before a request.

## Reads

| Method                               | Request                                                                                                                        |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| `notifications(since)`               | `GET /notifications?all=true&since=…&per_page=50`                                                                              |
| `listOpenPulls(repo)`                | `GET /repos/{repo}/pulls?state=open&per_page=100`                                                                              |
| `listMergedPulls(repo, since)`       | `GET /repos/{repo}/pulls?state=closed&sort=updated&direction=desc`, stops at the first pull updated before `since`, at most 50 |
| `getPull(repo, n)`                   | `GET /repos/{repo}/pulls/{n}`: `state`, `merged`, head and base                                                                |
| `listThreadComments(repo, n, after)` | `GET /repos/{repo}/issues/{n}/comments?since=…&per_page=100`                                                                   |
| `listReviews(repo, n)`               | `GET /repos/{repo}/pulls/{n}/reviews?per_page=100`                                                                             |

- Notifications keep reasons `mention`, `team_mention`, `author`, `comment`,
  `review_requested`, `assign`, and only `PullRequest` and `Issue` subjects.
  The result has `modified` (false when every page was a 304) and
  `pollIntervalMs` from `X-Poll-Interval`. The app owns the interval.
- `listThreadComments` reads every page and returns comments strictly after
  the `(updatedAt, id)` cursor, sorted by it. GitHub's `since` is inclusive and
  second-granular, so more than 100 comments with one `updated_at` are still
  split exactly. Pass `{ updatedAt: cursor, id: 0 }` for "since cursor".
- Lists follow `Link: rel="next"` to any path on the same origin (GitHub may
  switch to `/repositories/{id}/…`), never to another origin, and stop on a cycle.
- Deleted accounts (`user: null`) become `ghost`.

## Conditional requests

`cache` is an injected `HttpCachePort` keyed by request URL, implemented by the
store so validators survive across processes. A GET sends `If-None-Match` and
`If-Modified-Since` from the cached entry; a 304 returns the cached body and
next link. Nothing is invalidated on writes: the server compares validators, so
a changed resource returns 200.

## Writes and budget

`postComment`, `updatePullBody` and `createIssue` are content writes. Each
reserves one slot from the injected `WriteBudgetPort` before the first attempt,
with `WRITE_WINDOWS` (20 a minute, 200 an hour, design §9.1). The store keeps
the count on disk, so every process on the laptop shares it. A refusal throws
`BudgetError.retryAfterMs` without a request. A 401 retry is the same write and
spends no second slot. `disableAutoMerge` (GraphQL) spends no budget.

## Errors

| Response                                          | Result                                                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 401                                               | Re-read the token once per process and retry. Next 401: `AuthError`, latched: no more token reads or requests |
| token provider fails                              | `AuthError`, latched                                                                                          |
| 403 with `x-github-sso: required`                 | `SsoError` with `authorizeUrl` from the header. Not latched: other orgs may work                              |
| 403/429 with `Retry-After`                        | `RateLimitError` (secondary unless remaining is 0)                                                            |
| 403/429 with `x-ratelimit-remaining: 0`           | `RateLimitError` until `x-ratelimit-reset`                                                                    |
| 429, or 403 whose message names a secondary limit | `RateLimitError`, 60 s, secondary                                                                             |
| other non-2xx                                     | `GitHubResponseError(status)`                                                                                 |

After a rate limit the adapter refuses further requests until the wait ends,
without touching the network. It never sleeps. Error messages carry no tokens or
response bodies. Requests time out after 30 s; redirects are refused.

`requestStats()`: `requests` counts every attempt including 304s, `notModified`
the 304s, `writes` non-GET attempts, `rateLimitRemaining` the last primary count.

## Tests

`bun test src/adapters/github` uses an injected fetch, a fake cache and a fake
shared budget. `fixtures/recorded.json` holds read-only responses recorded from
`alexei-led/crew-net-sandbox` on 2026-11-09 (notifications 200 and live 304,
merged and closed pulls, comments, reviews), with text redacted and
notification subjects rewritten to the sandbox.

Opt-in live test, read-only:

```sh
CREW_NET_LIVE=1 bun test src/adapters/github/index.test.ts --test-name-pattern 'live sandbox reads only'
```
