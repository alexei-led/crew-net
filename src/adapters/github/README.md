# GitHub adapter

`new GitHubAdapter({ host, tokenProvider, kv, fetch?, now? })`
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
  switch to `/repositories/{id}/…`), never to another origin, and stop on a
  cycle. Cached next links are checked the same way.
- Deleted accounts (`user: null`) become `ghost`.

## State in the store

`kv` is the store's cross-process `StorePort.kv`. Every sync process on the
laptop shares three kinds of keys:

| Key                     | Holds                                                       |
| ----------------------- | ----------------------------------------------------------- |
| `github:cache:<url>`    | `{ etag?, lastModified?, body, next? }` of the last 200 GET |
| `github:writes:<host>`  | write times inside the last hour                            |
| `github:blocked:<host>` | `{ until, secondary }` after a rate limit                   |

A GET sends `If-None-Match` and `If-Modified-Since` from its cache entry; a 304
returns the cached body and next link. Writes invalidate nothing: the server
compares validators, so a changed resource returns 200. Notification keys
leave out `since`, so a moved cursor still polls conditionally and no entry is
orphaned; a 304 replays the older body and `notifications()` drops threads
updated before `since`. A malformed entry counts as a miss.

## Writes and budget

`postComment`, `updatePullBody` and `createIssue` are content writes. Each one
records itself in `github:writes:<host>` through `kv.update` (atomic under the
store lock) before the first attempt, if `WRITE_WINDOWS` (20 a minute, 200 an
hour, design §9.1) has room. Otherwise it throws `BudgetError.retryAfterMs`
without a request. A 401 retry is the same write and is not counted again.
`disableAutoMerge` (GraphQL) spends no budget and does nothing when auto-merge
is already off.

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

After a rate limit the adapter writes `github:blocked:<host>`, and every
adapter on the laptop refuses requests until the wait ends, without touching
the network. It never sleeps. A 200 with `x-github-sso: partial-results` (some
orgs left out) is reported on `notifications()` as `ssoPartialOrgs`. Error messages carry no tokens or
response bodies. Requests time out after 30 s; redirects are refused.

`requestStats()`: `requests` counts every attempt including 304s, `notModified`
the 304s, `writes` non-GET attempts, `rateLimitRemaining` the last REST primary
count (GraphQL has its own pool).

## Tests

`bun test src/adapters/github` uses an injected fetch and a fake shared KV. `fixtures/recorded.json` holds read-only responses recorded from
`alexei-led/crew-net-sandbox` on 2026-11-09 (notifications 200 and live 304,
merged and closed pulls, comments, reviews), with text redacted and
notification subjects rewritten to the sandbox.

Opt-in live test, read-only:

```sh
CREW_NET_LIVE=1 bun test src/adapters/github/index.test.ts --test-name-pattern 'live sandbox reads only'
```
