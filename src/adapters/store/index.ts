import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type {
  ClockPort,
  DeliveryClaim,
  InboxEntry,
  JobOutcome,
  JsonObject,
  JsonValue,
  OutboundRequest,
  RepoFile,
  RepoRef,
  SessionHeartbeat,
  SessionRecord,
  StorePort,
} from "../../ports/index";
import { decodeEvent, type ItemEvent } from "../../protocol/index";

/** Delivered items and dead session files are removed after this age. */
export const RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
/** A session whose last heartbeat is older than this is not live. */
export const SESSION_LIVE_MS = 3 * 60 * 1000;
/** A job holding its lock longer than this can be taken over. */
export const JOB_LOCK_TTL_MS = 10 * 60 * 1000;
/** Short locks around read-modify-write of one shared file. */
export const MUTEX_TTL_MS = 30 * 1000;
export const EVENTS_ROTATE_BYTES = 10 * 1024 * 1024;

const DIRS = ["inbox", "delivered", "sessions", "repos", "locks", "kv"];
const TEMP = /\.(\d+)\.[0-9a-f-]{36}\.tmp$/;
const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const HASHED = /^[0-9a-f]{64}$/;
const HASHED_JSON = /^[0-9a-f]{64}\.json$/;
const MARKER = /^recovery-([0-9a-f-]{36})$/;
const LOCK = /^[0-9a-f]{64}\.lock$/;

/** `${XDG_STATE_HOME:-~/.local/state}/crew-net`; a relative XDG_STATE_HOME is ignored, per the XDG spec. */
export function defaultStateDir(
  env: Record<string, string | undefined>,
  home: string,
): string {
  const xdg = env.XDG_STATE_HOME;
  return join(
    xdg && isAbsolute(xdg) ? xdg : join(home, ".local", "state"),
    "crew-net",
  );
}

export class StoreFormatError extends Error {
  constructor(path: string) {
    super(`Invalid crew-net store data: ${path}`);
    this.name = "StoreFormatError";
  }
}

export class StoreLockError extends Error {
  constructor(path: string) {
    super(`Crew-net store lock is busy or invalid: ${path}`);
    this.name = "StoreLockError";
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function hash(id: string): string {
  if (!id) throw new Error("Store ids must not be empty");
  // Fixed-length names avoid traversal, case-folding collisions and filename limits.
  return createHash("sha256").update(id).digest("hex");
}

type Fields = Record<string, unknown>;

function fields(value: unknown): Fields | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Fields)
    : undefined;
}

const isString = (v: unknown): v is string => typeof v === "string";
const isTime = (v: unknown): v is number =>
  typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
// process.kill rejects pids outside int32.
const isPid = (v: unknown): v is number =>
  typeof v === "number" && Number.isInteger(v) && v > 0 && v <= 0x7fffffff;

interface LockOwner {
  pid: number;
  token: string;
  expiresAtMs: number;
}

function parseOwner(value: unknown): LockOwner | undefined {
  const raw = fields(value);
  if (
    !raw ||
    !isPid(raw.pid) ||
    !isString(raw.token) ||
    !/^[0-9a-f-]{36}$/.test(raw.token) ||
    !isTime(raw.expiresAtMs)
  )
    return undefined;
  return { pid: raw.pid, token: raw.token, expiresAtMs: raw.expiresAtMs };
}

function parseClaim(value: unknown): DeliveryClaim | undefined {
  const raw = fields(value);
  if (!raw || !isString(raw.sessionId) || !isTime(raw.atMs)) return undefined;
  return { sessionId: raw.sessionId, atMs: raw.atMs };
}

function parseItem(value: unknown): ItemEvent | undefined {
  const parsed = decodeEvent(JSON.stringify(value));
  return parsed.ok && parsed.event.type === "item" ? parsed.event : undefined;
}

function parseStored(
  value: unknown,
): { item: ItemEvent; receivedAtMs: number } | undefined {
  const raw = fields(value);
  const item = parseItem(raw?.item);
  if (!raw || !item || !isTime(raw.receivedAtMs)) return undefined;
  return { item, receivedAtMs: raw.receivedAtMs };
}

function parseRequest(value: unknown): OutboundRequest | undefined {
  const raw = fields(value);
  if (
    !raw ||
    !isString(raw.id) ||
    !isString(raw.repo) ||
    !isPid(raw.number) ||
    !isString(raw.to) ||
    !isString(raw.kind) ||
    !isString(raw.text) ||
    !isTime(raw.createdAtMs) ||
    (raw.status !== "open" && raw.status !== "in-progress")
  )
    return undefined;
  return {
    id: raw.id,
    repo: raw.repo,
    number: raw.number,
    to: raw.to,
    kind: raw.kind,
    text: raw.text,
    createdAtMs: raw.createdAtMs,
    status: raw.status,
  };
}

function parseSession(value: unknown): SessionRecord | undefined {
  const raw = fields(value);
  if (
    !raw ||
    !isString(raw.sessionId) ||
    !isPid(raw.pid) ||
    !isString(raw.harness) ||
    (raw.role !== "lead" && raw.role !== "worker") ||
    !isString(raw.worktree) ||
    !isTime(raw.seenAtMs) ||
    (raw.repo !== undefined && !isString(raw.repo)) ||
    (raw.branch !== undefined && !isString(raw.branch)) ||
    (raw.lastPromptAtMs !== undefined && !isTime(raw.lastPromptAtMs))
  )
    return undefined;
  const session: SessionRecord = {
    sessionId: raw.sessionId,
    pid: raw.pid,
    harness: raw.harness,
    role: raw.role,
    worktree: raw.worktree,
    seenAtMs: raw.seenAtMs,
  };
  if (raw.repo !== undefined) session.repo = raw.repo;
  if (raw.branch !== undefined) session.branch = raw.branch;
  if (raw.lastPromptAtMs !== undefined)
    session.lastPromptAtMs = raw.lastPromptAtMs;
  return session;
}

/** Named strings and per-job last runs, kept as Maps so any name is a safe key. */
interface Cursors {
  cursors: Map<string, string>;
  lastRun: Map<string, number>;
}

function parseCursors(value: unknown): Cursors | undefined {
  const raw = fields(value);
  const cursors = fields(raw?.cursors);
  const lastRun = fields(raw?.lastRun);
  if (!cursors || !lastRun) return undefined;
  const c = Object.entries(cursors);
  const l = Object.entries(lastRun);
  if (!c.every(([, v]) => isString(v)) || !l.every(([, v]) => isTime(v)))
    return undefined;
  return {
    cursors: new Map(c as [string, string][]),
    lastRun: new Map(l as [string, number][]),
  };
}

/**
 * The local store of design §8.3 on one host's filesystem. Every file is
 * written atomically (temp, fsync, rename, fsync dir); reads fail closed with
 * StoreFormatError on data they cannot validate.
 */
export class FileStoreAdapter implements StorePort {
  constructor(
    private readonly root: string,
    private readonly clock: ClockPort,
  ) {
    for (const dir of [root, ...DIRS.map((d) => join(root, d))])
      this.ensureDir(dir);
  }

  private ensureDir(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    // mkdir leaves an existing directory's mode alone; the store holds private data.
    chmodSync(dir, 0o700);
  }

  private path(...parts: string[]): string {
    return join(this.root, ...parts);
  }

  private read<T>(path: string, parse: (v: unknown) => T | undefined) {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if (isCode(error, "ENOENT")) return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new StoreFormatError(path);
    }
    const parsed = parse(value);
    if (parsed === undefined) throw new StoreFormatError(path);
    return parsed;
  }

  private write(path: string, value: unknown): void {
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(value));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, path);
      this.syncDir(path);
    } finally {
      this.remove(temp);
    }
  }

  private remove(path: string): void {
    try {
      unlinkSync(path);
    } catch (error) {
      if (!isCode(error, "ENOENT")) throw error;
    }
  }

  /** Our own entries only: temp files and foreign files (.DS_Store, backups) are skipped. */
  private names(dir: string, pattern: RegExp): string[] {
    return readdirSync(dir)
      .filter((name) => pattern.test(name))
      .sort();
  }

  private syncDir(path: string): void {
    const dir = openSync(dirname(path), "r");
    try {
      fsyncSync(dir);
    } finally {
      closeSync(dir);
    }
  }

  /** Write value to a private temp file, then hard-link it to path: exclusive, complete and durable. */
  private publish(path: string, value: unknown, token: string): boolean {
    const temp = `${path}.${process.pid}.${token}.tmp`;
    try {
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(value));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      try {
        linkSync(temp, path);
      } catch (error) {
        if (isCode(error, "EEXIST")) return false;
        throw error;
      }
      this.syncDir(path);
      return true;
    } finally {
      this.remove(temp);
    }
  }

  // ---- locks ----

  private alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (isCode(error, "ESRCH")) return false;
      // EPERM: the process exists but belongs to another user.
      if (isCode(error, "EPERM")) return true;
      throw error;
    }
  }

  /** Expired, or the holder is gone. A reused pid is caught by expiry. */
  private stale(owner: LockOwner): boolean {
    return this.clock.now() >= owner.expiresAtMs || !this.alive(owner.pid);
  }

  private readOwner(path: string): LockOwner | undefined {
    try {
      return this.read(path, parseOwner);
    } catch (error) {
      if (error instanceof StoreFormatError) throw new StoreLockError(path);
      throw error;
    }
  }

  private recover(path: string, stale: LockOwner, owner: LockOwner): void {
    let token = stale.token;
    const visited = new Set<string>();
    // A marker per stale token lets exactly one reaper remove that lock;
    // two reapers unlinking by name could delete a fresh live lock.
    for (;;) {
      if (visited.has(token)) throw new StoreLockError(path);
      visited.add(token);
      const marker = this.path("locks", `recovery-${token}`);
      const reaperRecord = {
        ...owner,
        expiresAtMs: this.clock.now() + MUTEX_TTL_MS,
      };
      if (this.publish(marker, reaperRecord, owner.token)) {
        if (this.readOwner(path)?.token === stale.token) this.remove(path);
        return;
      }
      const reaper = this.readOwner(marker);
      if (!reaper || !this.stale(reaper)) return;
      // The reaper died mid-recovery: the next generation is keyed by its token.
      token = reaper.token;
    }
  }

  /** One non-blocking attempt to take a lock; undefined when a live holder has it. */
  private tryLock(path: string, ttlMs: number): LockOwner | undefined {
    const owner = {
      pid: process.pid,
      token: randomUUID(),
      expiresAtMs: this.clock.now() + ttlMs,
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.publish(path, owner, owner.token)) return owner;
      const held = this.readOwner(path);
      if (held === undefined) continue; // released between our tries
      if (!this.stale(held)) return undefined;
      this.recover(path, held, owner);
    }
    return undefined;
  }

  private unlock(path: string, owner: LockOwner): void {
    // A holder that outlived its expiry may have been replaced; leave the new lock.
    if (this.readOwner(path)?.token === owner.token) this.remove(path);
  }

  private lockPath(name: string): string {
    return this.path("locks", `${hash(name)}.lock`);
  }

  /** Serialize a synchronous read-modify-write of one shared file across processes. */
  private async locked<T>(name: string, change: () => T): Promise<T> {
    const path = this.lockPath(`mutex:${name}`);
    for (let attempt = 0; attempt < 200; attempt++) {
      const owner = this.tryLock(path, MUTEX_TTL_MS);
      if (owner) {
        try {
          // Deliberately synchronous: never yield while holding the lock.
          return change();
        } finally {
          this.unlock(path, owner);
        }
      }
      await setTimeout(5);
    }
    throw new StoreLockError(path);
  }

  // ---- inbox and delivery ----

  private inboxPath(id: string): string {
    return this.path("inbox", `${hash(id)}.json`);
  }

  private claimPath(id: string): string {
    return this.path("delivered", hash(id));
  }

  private entryAt(path: string): InboxEntry | undefined {
    const stored = this.read(path, parseStored);
    if (!stored) return undefined;
    const id = stored.item.id;
    if (path !== this.inboxPath(id)) throw new StoreFormatError(path);
    const delivered = this.read(this.claimPath(id), parseClaim);
    return delivered ? { ...stored, delivered } : stored;
  }

  readonly inbox = {
    put: async (item: ItemEvent): Promise<void> => {
      const valid = parseItem(item);
      if (!valid) throw new Error("Inbox item is not a valid protocol item");
      const path = this.inboxPath(valid.id);
      const receivedAtMs =
        this.read(path, parseStored)?.receivedAtMs ?? this.clock.now();
      this.write(path, { item: valid, receivedAtMs });
    },
    get: async (id: string): Promise<InboxEntry | undefined> =>
      this.entryAt(this.inboxPath(id)),
    list: async (): Promise<InboxEntry[]> =>
      this.names(this.path("inbox"), HASHED_JSON)
        .flatMap((name) => this.entryAt(this.path("inbox", name)) ?? [])
        .sort(
          (a, b) =>
            a.receivedAtMs - b.receivedAtMs ||
            (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0),
        ),
  };

  readonly delivered = {
    claim: async (id: string, sessionId: string): Promise<boolean> => {
      if (!sessionId) throw new Error("Session id must not be empty");
      const path = this.claimPath(id);
      this.publish(path, { sessionId, atMs: this.clock.now() }, randomUUID());
      return this.read(path, parseClaim)?.sessionId === sessionId;
    },
    get: async (id: string): Promise<DeliveryClaim | undefined> =>
      this.read(this.claimPath(id), parseClaim),
  };

  // ---- outbox ----

  private readOutbox(): Map<string, OutboundRequest> {
    const path = this.path("outbox.json");
    const list = this.read(path, (v) => {
      if (!Array.isArray(v)) return undefined;
      const parsed = v.map(parseRequest);
      return parsed.every((r) => r !== undefined)
        ? (parsed as OutboundRequest[])
        : undefined;
    });
    return new Map((list ?? []).map((r) => [r.id, r]));
  }

  readonly outbox = {
    put: async (request: OutboundRequest): Promise<void> => {
      const valid = parseRequest(request);
      if (!valid) throw new Error("Invalid outbound request");
      await this.locked("outbox", () => {
        const all = this.readOutbox();
        all.set(valid.id, valid);
        this.write(this.path("outbox.json"), [...all.values()]);
      });
    },
    list: async (): Promise<OutboundRequest[]> => [
      ...this.readOutbox().values(),
    ],
    remove: async (id: string): Promise<void> =>
      this.locked("outbox", () => {
        const all = this.readOutbox();
        if (!all.delete(id)) return;
        this.write(this.path("outbox.json"), [...all.values()]);
      }),
  };

  // ---- sessions ----

  private sessionPath(id: string): string {
    return this.path("sessions", `${hash(id)}.json`);
  }

  private allSessions(): { path: string; record: SessionRecord }[] {
    return this.names(this.path("sessions"), HASHED_JSON).flatMap((name) => {
      const path = this.path("sessions", name);
      const record = this.read(path, parseSession);
      if (!record) return [];
      if (path !== this.sessionPath(record.sessionId))
        throw new StoreFormatError(path);
      return [{ path, record }];
    });
  }

  readonly sessions = {
    beat: async (session: SessionHeartbeat): Promise<void> => {
      const record = parseSession({ ...session, seenAtMs: this.clock.now() });
      if (!record) throw new Error("Invalid session heartbeat");
      this.write(this.sessionPath(record.sessionId), record);
    },
    live: async (): Promise<SessionRecord[]> => {
      const now = this.clock.now();
      return this.allSessions()
        .map((s) => s.record)
        .filter((s) => now - s.seenAtMs < SESSION_LIVE_MS)
        .sort((a, b) => (a.sessionId < b.sessionId ? -1 : 1));
    },
    remove: async (sessionId: string): Promise<void> => {
      this.remove(this.sessionPath(sessionId));
    },
  };

  // ---- repos ----

  private repoDir(repo: RepoRef): string {
    const parts = [repo.host, repo.owner, repo.name];
    if (!parts.every((p) => SEGMENT.test(p) && p !== "." && p !== ".."))
      throw new Error("Repository host, owner and name must be plain names");
    return this.path("repos", ...parts);
  }

  readonly repos = {
    read: async (
      repo: RepoRef,
      file: RepoFile,
    ): Promise<JsonValue | undefined> =>
      this.read(
        join(this.repoDir(repo), `${file}.json`),
        (v) => v as JsonValue,
      ),
    write: async (
      repo: RepoRef,
      file: RepoFile,
      value: JsonValue,
    ): Promise<void> => {
      const dir = this.repoDir(repo);
      const host = this.path("repos", repo.host);
      for (const d of [host, join(host, repo.owner), dir]) this.ensureDir(d);
      this.write(join(dir, `${file}.json`), value);
    },
  };

  // ---- cursors and jobs ----

  private readCursors(): Cursors {
    const path = this.path("cursors.json");
    const cursors = this.read(path, parseCursors);
    return cursors ?? { cursors: new Map(), lastRun: new Map() };
  }

  private changeCursors(change: (c: Cursors) => void): Promise<void> {
    return this.locked("cursors", () => {
      const c = this.readCursors();
      change(c);
      this.write(this.path("cursors.json"), {
        cursors: Object.fromEntries(c.cursors),
        lastRun: Object.fromEntries(c.lastRun),
      });
    });
  }

  readonly cursors = {
    get: async (name: string): Promise<string | undefined> =>
      this.readCursors().cursors.get(name),
    set: async (name: string, value: string): Promise<void> =>
      this.changeCursors((c) => {
        c.cursors.set(name, value);
      }),
  };

  readonly jobs = {
    run: async (
      name: string,
      intervalMs: number,
      fn: () => Promise<void>,
    ): Promise<JobOutcome> => {
      const path = this.lockPath(`job:${name}`);
      const owner = this.tryLock(path, JOB_LOCK_TTL_MS);
      if (!owner) return "busy";
      try {
        const startedAt = this.clock.now();
        const last = this.readCursors().lastRun.get(name);
        if (last !== undefined && startedAt - last < intervalMs) return "fresh";
        const record = () =>
          this.changeCursors((c) => {
            c.lastRun.set(name, startedAt);
          });
        try {
          await fn();
        } catch (error) {
          // Failures count as a run too, so a broken job does not retry every
          // tick; the job's own error wins over one from recording it.
          await record().catch(() => {});
          throw error;
        }
        await record();
        return "ran";
      } finally {
        this.unlock(path, owner);
      }
    },
    lastRun: async (name: string): Promise<number | undefined> =>
      this.readCursors().lastRun.get(name),
  };

  // ---- kv ----

  private kvPath(key: string): string {
    return this.path("kv", `${hash(key)}.json`);
  }

  private readKv(key: string): JsonValue | undefined {
    const path = this.kvPath(key);
    return this.read(path, (v) => {
      const raw = fields(v);
      return raw && raw.key === key && Object.hasOwn(raw, "value")
        ? { value: raw.value as JsonValue }
        : undefined;
    })?.value;
  }

  readonly kv = {
    get: async (key: string): Promise<JsonValue | undefined> =>
      this.readKv(key),
    set: async (key: string, value: JsonValue): Promise<void> => {
      this.write(this.kvPath(key), { key, value });
    },
    update: async (
      key: string,
      fn: (current: JsonValue | undefined) => JsonValue,
    ): Promise<JsonValue> =>
      this.locked(`kv:${key}`, () => {
        const value = fn(this.readKv(key));
        this.write(this.kvPath(key), { key, value });
        return value;
      }),
  };

  // ---- events ----

  readonly events = {
    append: async (event: JsonObject): Promise<void> => {
      const path = this.path("events.ndjson");
      const size = () => {
        try {
          return statSync(path).size;
        } catch (error) {
          if (isCode(error, "ENOENT")) return 0;
          throw error;
        }
      };
      if (size() >= EVENTS_ROTATE_BYTES)
        await this.locked("events", () => {
          // Re-check under the lock so two writers rotate only once.
          if (size() >= EVENTS_ROTATE_BYTES) renameSync(path, `${path}.1`);
        });
      // One O_APPEND write per line: concurrent appenders do not interleave.
      appendFileSync(path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    },
    read: async (): Promise<JsonObject[]> => {
      const path = this.path("events.ndjson");
      const events: JsonObject[] = [];
      for (const file of [`${path}.1`, path]) {
        let text: string;
        try {
          text = readFileSync(file, "utf8");
        } catch (error) {
          if (isCode(error, "ENOENT")) continue;
          throw error;
        }
        for (const line of text.split("\n")) {
          if (!line) continue;
          try {
            const value: unknown = JSON.parse(line);
            if (
              typeof value === "object" &&
              value !== null &&
              !Array.isArray(value)
            )
              events.push(value as JsonObject);
          } catch {
            // A torn or foreign line must not hide the rest of the log.
          }
        }
      }
      return events;
    },
  };

  // ---- maintenance ----

  private pruneTemps(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) this.pruneTemps(path);
      const pid = Number(TEMP.exec(entry.name)?.[1]);
      if (entry.isFile() && isPid(pid) && !this.alive(pid)) this.remove(path);
    }
  }

  readonly prune = async (): Promise<void> => {
    const now = this.clock.now();
    for (const name of this.names(this.path("delivered"), HASHED)) {
      const claim = this.read(this.path("delivered", name), parseClaim);
      if (!claim || now - claim.atMs < RETENTION_MS) continue;
      // Item first: a crash in between leaves an orphan claim, never a redelivery.
      this.remove(this.path("inbox", `${name}.json`));
      this.remove(this.path("delivered", name));
    }
    for (const { path, record } of this.allSessions())
      if (now - record.seenAtMs >= RETENTION_MS) this.remove(path);
    // A marker for a token some lock still carries keeps fencing reapers of it.
    const held = new Set(
      this.names(this.path("locks"), LOCK).map(
        (name) => this.readOwner(this.path("locks", name))?.token,
      ),
    );
    for (const name of this.names(this.path("locks"), MARKER)) {
      const path = this.path("locks", name);
      const reaper = this.readOwner(path);
      if (reaper && this.stale(reaper) && !held.has(MARKER.exec(name)?.[1]))
        this.remove(path);
    }
    this.pruneTemps(this.root);
  };
}
