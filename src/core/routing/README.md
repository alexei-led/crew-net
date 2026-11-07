# routing

Picks exactly one recipient lead, or waits. Pure.

`route(message, facts) → { lead, step } | { wait: true }`

`crew → dev/name`: that lead if it holds a live lease, else wait.

`crew → dev`, first match wins:

1. Comment is on one of the developer's PRs: the lead in its state block (no lease needed).
2. The developer's lead whose open PR or worktree branch shares the branch or a changed path with the message's PR. Several: most recently active.
3. The developer's most recently active lead with a live lease.
4. Wait.

Ties break on address, so the result is stable.
