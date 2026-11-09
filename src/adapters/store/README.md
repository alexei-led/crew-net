# Store adapter

`new FileStoreAdapter(root, clock)` implements [StorePort](../../ports/index.ts):
the local store of [design: Local store](../../../docs/design.md#local-store) on one
host's filesystem. The composition root passes
`defaultStateDir(process.env, homedir())`, which is
`${XDG_STATE_HOME:-~/.local/state}/crew-net` (a relative `XDG_STATE_HOME` is
ignored), and a `ClockPort`. Every age, expiry and timestamp uses that clock.

The directory layout is in [design: Local store](../../../docs/design.md#local-store).
This table gives the content of each file.

| File                     | Content                                                     |
| ------------------------ | ----------------------------------------------------------- |
| `inbox/<h>.json`         | `{item, receivedAtMs}`: one protocol `ItemEvent`            |
| `delivered/<h>`          | `{sessionId, atMs}`: delivery claim, first writer wins      |
| `outbox.json`            | `[OutboundRequest]`: my open requests and their status      |
| `sessions/<h>.json`      | `SessionRecord`: heartbeat with `seenAtMs`                  |
| `repos/…/snapshot.json`  | JSON owned by the app                                       |
| `repos/…/radar.json`     | JSON owned by the app                                       |
| `cursors.json`           | `{cursors: {name: string}, lastRun: {job: ms}}`             |
| `kv/<h>.json`            | `{key, value}`: HTTP cache entries, write budget            |
| `locks/<h>.lock`         | `{pid, token, expiresAtMs}`: job locks and mutexes          |
| `locks/recovery-<token>` | Marker of the one process allowed to reap that lock         |
| `events.ndjson`          | Append-only log. `events.ndjson.1` holds the previous 10 MB |

`<h>` is the SHA-256 of the id, key or lock name, so no id reaches a path.
Repo directories use the host, owner and name as given; each must be a plain
name (`[A-Za-z0-9_.-]`, not `.` or `..`). The root, its fixed directories and
each repo directory level are chmod 0700 when opened or written, also when
they already exist; files are 0600. The store
never writes a GitHub token.

## Writes and reads

Each file write is temp file (`<file>.<pid>.<uuid>.tmp`, `O_EXCL`), fsync,
rename, fsync of the directory. Readers see the old or the new value, never a
part. Claims, locks and markers are published by hard-linking a complete,
fsynced temp file, then fsyncing the directory. Reads validate the shape and
throw `StoreFormatError` naming the file; they do not reset state. A hashed
file whose content names another id is corrupt too. Listings read only names
the store writes, so temp files and foreign files (`.DS_Store`) are skipped.

`outbox.json`, `cursors.json` and `kv.update` are read-modify-write under a
mutex (a lock with a 30 s expiry, retried 200 times at 5 ms, then
`StoreLockError`). The change runs synchronously under the lock. `kv.set`,
inbox, session and repo writes replace whole files and take no lock.

## Inbox and delivery

- `inbox.put(item)` writes or refreshes an item and keeps the first
  `receivedAtMs`, so sync can write before it moves a cursor and a replay
  dedupes by id.
- `inbox.list()` returns every item, oldest first, with its claim if any.
- `delivered.claim(id, sessionId)` publishes the claim by hard-linking a
  complete temp file: exactly one session wins, and a crash never leaves an
  empty claim. It returns true for the winner, also on a repeat call.
- `prune()` removes items whose claim is 14 days old, item first, so a crash
  leaves an orphan claim (removed next time), never a redelivery. Undelivered
  items stay.

## Sessions

`sessions.beat(heartbeat)` writes the session's file with `seenAtMs` from the
clock. `sessions.live()` returns heartbeats younger than 3 minutes, by id.
`sessions.remove(id)` is for a clean exit; `prune()` removes files older than
14 days.

## Locks and jobs

`jobs.run(name, intervalMs, fn)`:

1. Take `locks/<h>.lock` without waiting. Held by a live holder: `busy`.
2. If the last run started less than `intervalMs` ago: release, `fresh`.
3. Run `fn`, record its start time as the last run (also when `fn` throws, so a
   failing job keeps its interval), release, `ran` or rethrow. When `fn` throws,
   its error is the one rethrown, even if recording the run fails.

A lock is stale when it has expired (10 min for jobs, 30 s for mutexes) or its
pid is gone. `kill(pid, 0)` failing with `EPERM` means alive (another user's
process); expiry covers a reused pid. Takeover goes through
`locks/recovery-<stale token>`: only the process that creates that marker
(`O_EXCL` via link) may remove the stale lock, and a reaper that died is
followed by a marker keyed by its own token. A holder that outlives its expiry
removes the lock on release only if it still holds its token; the window
between that check and the unlink is not closed, so job expiry must exceed a
job's run time. This is for local filesystems, not NFS.

`prune()` also removes recovery markers whose reaper is stale and whose token
no lock still carries, and temp files whose writer pid is gone. Pids must fit
in int32 (what `kill` accepts); anything else is a corrupt lock.

## Events

`events.append(event)` writes one JSON line with one `O_APPEND` write.
`events.read()` returns `events.ndjson.1` then `events.ndjson`, skipping
lines that are not JSON objects (a torn last line). When the
file has reached 10 MB, the next append renames it to `events.ndjson.1` under
a mutex (replacing the older one) and starts a new file.

```sh
bun test src/adapters/store
```
