# delivery

Decides what to do with one inbound item now (design §9.4). Pure; adapters bundle it.

`decide(item, signals, settings, nowMs) → Action[]`

| Session                               | Item                                                    | Actions                      |
| ------------------------------------- | ------------------------------------------------------- | ---------------------------- |
| Starting (start, `/clear`, resume)    | any                                                     | `digest`                     |
| Idle, no wake turn in the last 10 min | `ask review fix bug`, wakeable route, auto-wake `reply` | `band`, `wake`               |
| Anything else                         | any                                                     | `band`, `inject-next-prompt` |

- Active: a non-empty draft, typing or a user prompt within `idleMinutes`
  (default 10), or a running turn. Idle: none of these.
- Plugin-submitted turns (wake turns) are not user activity, so they do not set
  `lastUserPromptMs`, but they do set `turnRunning`. Items that arrive during a
  wake turn get `band` + `inject-next-prompt` for now.
- A decision holds only for `nowMs`. Callers run `decide` again on each tick
  for every item not yet delivered, so an ask held back by a running turn or the
  wake cooldown starts the next wake turn once those clear.
- `wakeable` comes from routing: false when the session was picked only because
  no session is in the item's repo.
- Findings, replies, people's comments and dependency events never wake.
