# radar

Turns git facts into findings (design §10). Deterministic, no LLM. Pure.

- `classify(pair, config) → Finding[]`: my work item against someone else's
  (an open PR or a bare pushed branch).
- `stale(mine, landed, config) → Finding[]`: PRs merged to my base after my
  merge base. The caller lists them from `git log <merge-base>..origin/<base>`.

| Finding    | Rule                                                                                    |
| ---------- | --------------------------------------------------------------------------------------- |
| `conflict` | `git merge-tree` reports conflicted files                                               |
| `overlap`  | Both sides change a file that does not conflict                                         |
| `order`    | One side changes a contract's producer paths, the other its consumer paths              |
| `stale`    | A PR merged to my base after my merge base changes files I change (any author but bots) |

- Same repo: compared only when both target the same base. Different repos:
  `order` only, through `owner/repo:glob` consumer patterns.
- Nothing for same-owner pairs or bots (`renovate`, `dependabot`,
  `github-actions`, with or without `[bot]` or `app/`, plus `config.bots`).
- `order` is one finding per contract and direction; `producer` says which side
  produces. Paths are the producer's matched paths plus the consumer's.
- Contracts come from `config.contracts[repo]`, keyed by the declaring repo. A
  repo without an entry uses the defaults: producers `**/migrations/**`,
  `**/*migration*`, `api/openapi/**`, `**/*.proto`; consumers any other path in
  the same repo.
- `key` = kind, contract and direction (`order` only), both work items, and the
  sorted file set. Report a finding again only when its key changes.
- `mayWake` is always `false`: findings go to the band and the next prompt.

`matchGlob` follows `.gitignore` placement: `**` crosses `/`, `*` stays in one
segment; a trailing `/` matches only a directory (everything below it); a
leading or middle `/` anchors at the root, otherwise the glob matches at any
depth; a glob that matches a directory matches everything below it.
