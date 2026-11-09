# routing

Picks exactly one local session for an inbound item, or none (design §9.3). Pure.

`route(item, sessions) → { session, step, wakeable } | { session: null, step: "none", wakeable: false }`

Input: the item's repo, thread and PR head branch; the live sessions on this
laptop (id, role, repo, worktree, branch, clone root, last activity). The caller
drops sessions whose heartbeat is stale.

First match wins, among lead sessions only:

| Step       | Rule                                                                                 | Wakeable |
| ---------- | ------------------------------------------------------------------------------------ | -------- |
| `checkout` | A lead in the item's repo has the PR branch checked out                              | yes      |
| `clone`    | A live session (a worker) has the branch checked out in a worktree of a lead's clone | yes      |
| `repo`     | The most recently active lead in the item's repo                                     | yes      |
| `any`      | The most recently active lead in any repo                                            | no       |
| `none`     | No lead session; the item waits for the next session's digest                        | no       |

- Workers (`role: "worker"`) are never a target; their branches still route to their lead.
- `clone` sees a worktree only through the live session in it. A worktree with no
  session falls through to `repo`.
- Several matches in one step: the most recently active, ties broken by id.
- Repos compare case-insensitively; branches exactly.
