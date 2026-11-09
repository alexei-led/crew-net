# watch

`crew-net watch --session <id>`: the Claude Code mod's child process (design
§16). It is a composition root, like `cli`; the logic is `Watcher` in
[app/watch.ts](../app/watch.ts).

Protocol: NDJSON on stdin and stdout, the events of
[protocol/events.ts](../protocol/events.ts).

| Direction   | Event    | Meaning                                                              |
| ----------- | -------- | -------------------------------------------------------------------- |
| watch → mod | `ready`  | Started; send `hello`                                                |
| mod → watch | `hello`  | Session id, role, harness, worktree, pid. Starts heartbeat and ticks |
| watch → mod | `item`   | An inbox item routed to and claimed by this session                  |
| watch → mod | `status` | A line for the band, sent when it changes (rate limit, auth)         |
| watch → mod | `error`  | A tick failed, or a line from the mod was not a valid event          |
| mod → watch | `ack`    | What the mod did with an item; logged to `events.ndjson`             |
| mod → watch | `bye`    | The session ends: its heartbeat is removed and the watcher exits     |

- Every 30 s while started: heartbeat (repo and branch of the worktree),
  `crew-net sync` jobs that are due, then delivery. Delivery routes each
  unclaimed item with `core/routing`, claims it with `delivered/<id>`, and
  emits it. `addressed` is true only for a request to this developer on a
  wakeable route.
- No state of its own. Claims live in the store. After a restart, items this
  session claimed in the last hour are sent again; the mod dedupes by id.
- Exits when stdin closes, after `bye`, or when its parent process is gone.
  It never exits after `hello` on its own.
- Heartbeats carry no clone root, so routing step 2 (`clone`) does not
  match; a worker's branch reaches its lead through step 3 (`repo`).
