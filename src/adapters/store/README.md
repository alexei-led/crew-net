# Store adapter

`new FileStoreAdapter(stateDir)` implements
[StorePort](../../ports/index.ts) on a local, single-host filesystem.

The composition root chooses the directory; the adapter does not read XDG
variables. New directories use mode 0700 and files 0600. Existing permissions
are not changed.

| Path                       | Content                               |
| -------------------------- | ------------------------------------- |
| `cursor`                   | Polling cursor string                 |
| `inbox/<sha256(id)>.json`  | Unacknowledged protocol ItemEvent     |
| `outbox/<sha256(id)>.json` | Open OutboundRequest                  |
| `seen`                     | Processed ids                         |
| `leases.json`              | Name to holder and expiry             |
| `leases.lock`, `seen.lock` | Exclusive transaction owner records   |
| `locks/recovery-<token>`   | Immutable stale-lock recovery records |

Files are JSON envelopes: `{"v":1,"value":...}`. Reads reject malformed data and
unsupported versions with `StoreFormatError`; they do not reset state silently.
Inbox/outbox ids must match the payload id. Item filenames are opaque hashes;
enumeration returns validated payloads, ordered by filename, not creation time.

Writes create an O_EXCL temporary file, fsync it, rename it over the destination,
then fsync the directory. A killed writer leaves the previous or new complete
value; leftover temporary files are ignored. A put without ack replays on restart.
Acknowledgements are idempotent removals. The app must persist seen ids and
pending items before advancing the cursor or acknowledging delivery.

## Leases and concurrency

Lease calls take time from the caller, never from an internal clock:

- `claim(name, holder, nowMs)`: create, extend the same holder, or take over an
  expired lease. Refuse another live holder.
- `renew(name, holder, nowMs)`: extend only the same unexpired holder.
- `release(name, holder)`: remove only that holder's lease.
- `holder(name, nowMs)`: return the live holder, otherwise undefined.

Expiry is exactly 180000 ms after claim or renewal; equality means expired.

Seen updates and lease mutations serialize under exclusive filesystem locks.
An owner record is prepared with O_EXCL and atomically hard-linked into the lock
path, so a crash cannot publish an empty lock. Locks from dead PIDs are recovered.
Immutable generation markers serialize competing recovery attempts, including
crashes during recovery. These small markers remain on disk after recovery.
No wall clock is used for lock recovery; PID reuse can delay recovery until the
unrelated process exits. This protocol is for local filesystems, not NFS.

Transactions never yield while holding the lock. Contention retries at most 200
times with a 5 ms delay; failure throws `StoreLockError`. Corrupt lock records
fail closed. Do not remove locks or recovery markers while helpers are running.

Tests use temporary directories and real child processes for simultaneous claims,
stale-lock recovery, atomic replacements, and concurrent seen updates:

```sh
bun test src/adapters/store
```
