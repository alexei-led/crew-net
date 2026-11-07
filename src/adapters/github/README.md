# GitHub adapter

`GitHubAdapter({ owner, repo, tokenProvider, ...options })` implements
[GitHubPort](../../ports/index.ts) using global fetch. No SDK or runtime dependency.

Options: `baseUrl` (default `https://api.github.com`), injected `fetch`,
`now` (default `Date.now`), `writesPerMinute` (20), `writesPerHour` (200).
Requests time out after 30 seconds. Redirects are refused so credentials cannot
follow a redirect to another host.

- REST lists follow every next page, including on cached 304 responses.
  Next links must keep the same origin and endpoint.
- ETags are cached per URL in memory. Writes invalidate cached reads.
- A 401 re-reads the injected token provider once and retries once.
  A second 401 throws `AuthError`.
- Rate-limited 403/429 responses throw `RateLimitError.retryAfterMs`.
  Retry-After accepts seconds or an HTTP date; exhausted primary limits use
  x-ratelimit-reset. Without a usable wait, the fallback is 60 seconds.
  The adapter never sleeps.
- Comment posts and body edits reserve a rolling-minute/hour budget before
  each fetch attempt, including failed requests and auth retries.
  Refusal throws `BudgetError.retryAfterMs`. Budgets are per adapter instance,
  not shared across helpers. Disabling auto-merge is not a content write.
- `requestStats()` returns a copy: `requests` includes all attempts and 304s,
  `notModified` counts 304s, `writes` counts non-GET attempts (including GraphQL),
  and `rateLimitRemaining` is the last reported primary remaining count or null.
  A 304 does not spend GitHub's primary rate limit.

The adapter returns plain facts. The app maps them into core input types.
It does not parse state blocks, advance cursors, or retry network failures.
Error messages omit response bodies and authentication tokens.

## Tests

`bun test src/adapters/github` uses injected fetch and JSON fixtures.
`fixtures/recorded.json` contains reduced read-only sandbox responses; author,
body, title and branch text are redacted. The other fixtures cover populated
pulls and addressed comments deterministically.

Opt-in live test, read-only against `alexei-led/crew-net-sandbox`:

```sh
CREW_NET_LIVE=1 bun test src/adapters/github/index.test.ts --test-name-pattern 'live sandbox reads only'
```

It reads the token through `gh auth token` and lists pulls and comments. No live writes.
