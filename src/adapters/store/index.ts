import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import type { OutboundRequest, StorePort } from "../../ports/index";
import { decodeEvent, type ItemEvent } from "../../protocol/index";

export const LEASE_TTL_MS = 180_000;

export class StoreFormatError extends Error {
  constructor() {
    super("Invalid or unsupported crew-net store data");
    this.name = "StoreFormatError";
  }
}

export class StoreLockError extends Error {
  constructor() {
    super("Crew-net store lock is busy or invalid");
    this.name = "StoreLockError";
  }
}

function isCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new StoreFormatError();
  return value as Record<string, unknown>;
}

interface LockOwner {
  pid: number;
  token: string;
}

interface Lease {
  holder: string;
  expiresAt: number;
}

function parseLeases(value: unknown): Record<string, Lease> {
  const entries = record(value);
  const result: Record<string, Lease> = Object.create(null);
  for (const [name, entry] of Object.entries(entries)) {
    const lease = record(entry);
    if (
      typeof lease.holder !== "string" ||
      typeof lease.expiresAt !== "number" ||
      !Number.isFinite(lease.expiresAt)
    )
      throw new StoreFormatError();
    result[name] = { holder: lease.holder, expiresAt: lease.expiresAt };
  }
  return result;
}

function parseItem(value: unknown): ItemEvent {
  const parsed = decodeEvent(JSON.stringify(value));
  if (!parsed.ok || parsed.event.type !== "item") throw new StoreFormatError();
  return parsed.event;
}

function parseOutbound(value: unknown): OutboundRequest {
  const raw = record(value);
  if (
    typeof raw.id !== "string" ||
    typeof raw.issueNumber !== "number" ||
    !Number.isSafeInteger(raw.issueNumber) ||
    raw.issueNumber < 1 ||
    typeof raw.to !== "string" ||
    typeof raw.body !== "string" ||
    typeof raw.createdAt !== "string"
  )
    throw new StoreFormatError();
  return {
    id: raw.id,
    issueNumber: raw.issueNumber,
    to: raw.to,
    body: raw.body,
    createdAt: raw.createdAt,
  };
}

/** Local, single-host store. Every read validates its version and data. */
export class FileStoreAdapter implements StorePort {
  constructor(private readonly stateDir: string) {
    for (const path of [
      stateDir,
      join(stateDir, "inbox"),
      join(stateDir, "outbox"),
      join(stateDir, "locks"),
    ])
      mkdirSync(path, { recursive: true, mode: 0o700 });
  }

  private read(path: string): unknown {
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch (error) {
      if (isCode(error, "ENOENT")) return undefined;
      throw error;
    }
    let raw: Record<string, unknown>;
    try {
      raw = record(JSON.parse(text));
    } catch {
      throw new StoreFormatError();
    }
    if (raw.v !== 1 || !Object.hasOwn(raw, "value"))
      throw new StoreFormatError();
    return raw.value;
  }

  private write(path: string, value: unknown): void {
    const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify({ v: 1, value }));
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, path);
      const dir = openSync(dirname(path), "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
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

  private itemPath(folder: string, id: string): string {
    if (!id) throw new Error("Store ids must not be empty");
    // Fixed-length names avoid traversal, case-folding collisions and filename limits.
    return join(
      this.stateDir,
      folder,
      `${createHash("sha256").update(id).digest("hex")}.json`,
    );
  }

  private list<T>(folder: string, parse: (value: unknown) => T): T[] {
    return readdirSync(join(this.stateDir, folder))
      .filter((name) => name.endsWith(".json"))
      .sort()
      .flatMap((name) => {
        const value = this.read(join(this.stateDir, folder, name));
        return value === undefined ? [] : [parse(value)];
      });
  }

  private readOwner(path: string): LockOwner | undefined {
    const value = this.read(path);
    if (value === undefined) return undefined;
    const raw = record(value);
    if (
      typeof raw.pid !== "number" ||
      !Number.isSafeInteger(raw.pid) ||
      raw.pid < 1 ||
      typeof raw.token !== "string" ||
      !/^[0-9a-f-]{36}$/.test(raw.token)
    )
      throw new StoreLockError();
    return { pid: raw.pid, token: raw.token };
  }

  private alive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (isCode(error, "ESRCH")) return false;
      throw error;
    }
  }

  private publishLock(path: string, owner: LockOwner): boolean {
    const temp = `${path}.${owner.token}.tmp`;
    try {
      // O_EXCL creates a private owner record; link publishes it atomically and
      // exclusively, avoiding an empty lock if killed between open and write.
      this.write(temp, owner);
      try {
        linkSync(temp, path);
        return true;
      } catch (error) {
        if (isCode(error, "EEXIST")) return false;
        throw error;
      }
    } finally {
      this.remove(temp);
    }
  }

  private recover(path: string, stale: LockOwner, owner: LockOwner): void {
    let token = stale.token;
    const visited = new Set<string>();
    // Immutable generation markers serialize stale-lock removal. Deleting a
    // marker would let a delayed reaper unlink a replacement live lock.
    for (;;) {
      if (visited.has(token)) throw new StoreLockError();
      visited.add(token);
      const marker = join(this.stateDir, "locks", `recovery-${token}`);
      if (this.publishLock(marker, owner)) {
        if (this.readOwner(path)?.token === stale.token) this.remove(path);
        return;
      }
      const reaper = this.readOwner(marker);
      if (!reaper || this.alive(reaper.pid)) return;
      // A crash during recovery gets its own generation, without removing
      // another process's marker or relying on wall-clock time.
      token = reaper.token;
    }
  }

  private async locked<T>(name: string, change: () => T): Promise<T> {
    const path = join(this.stateDir, `${name}.lock`);
    const owner = { pid: process.pid, token: randomUUID() };
    for (let attempt = 0; attempt < 200; attempt++) {
      if (this.publishLock(path, owner)) {
        try {
          // Deliberately synchronous under the lock: never yield mid-transaction.
          return change();
        } finally {
          this.remove(path);
        }
      }
      const stale = this.readOwner(path);
      if (stale && !this.alive(stale.pid)) this.recover(path, stale, owner);
      await setTimeout(5);
    }
    throw new StoreLockError();
  }

  readonly cursor = {
    get: async (): Promise<string | undefined> => {
      const value = this.read(join(this.stateDir, "cursor"));
      if (value !== undefined && typeof value !== "string")
        throw new StoreFormatError();
      return value;
    },
    set: async (value: string): Promise<void> => {
      this.write(join(this.stateDir, "cursor"), value);
    },
  };

  readonly inbox = {
    put: async (id: string, item: ItemEvent): Promise<void> => {
      if (item.id !== id) throw new Error("Inbox id must match item id");
      this.write(this.itemPath("inbox", id), parseItem(item));
    },
    list: async (): Promise<ItemEvent[]> => this.list("inbox", parseItem),
    ack: async (id: string): Promise<void> => {
      this.remove(this.itemPath("inbox", id));
    },
  };

  readonly outbox = {
    put: async (id: string, request: OutboundRequest): Promise<void> => {
      if (request.id !== id) throw new Error("Outbox id must match request id");
      this.write(this.itemPath("outbox", id), parseOutbound(request));
    },
    open: async (): Promise<OutboundRequest[]> =>
      this.list("outbox", parseOutbound),
    ack: async (id: string): Promise<void> => {
      this.remove(this.itemPath("outbox", id));
    },
  };

  private readSeen(): Set<string> {
    const value = this.read(join(this.stateDir, "seen"));
    if (value === undefined) return new Set();
    if (!Array.isArray(value) || !value.every((id) => typeof id === "string"))
      throw new StoreFormatError();
    return new Set(value);
  }

  readonly seen = {
    has: async (id: string): Promise<boolean> => this.readSeen().has(id),
    add: async (id: string): Promise<void> =>
      this.locked("seen", () => {
        const seen = this.readSeen();
        seen.add(id);
        this.write(join(this.stateDir, "seen"), [...seen]);
      }),
  };

  private readLeases(): Record<string, Lease> {
    const value = this.read(join(this.stateDir, "leases.json"));
    return parseLeases(value === undefined ? {} : value);
  }

  readonly leases = {
    claim: async (
      name: string,
      holder: string,
      nowMs: number,
    ): Promise<boolean> => this.changeLease(name, holder, nowMs, false),
    renew: async (
      name: string,
      holder: string,
      nowMs: number,
    ): Promise<boolean> => this.changeLease(name, holder, nowMs, true),
    release: async (name: string, holder: string): Promise<void> =>
      this.locked("leases", () => {
        const leases = this.readLeases();
        if (leases[name]?.holder !== holder) return;
        delete leases[name];
        this.write(join(this.stateDir, "leases.json"), leases);
      }),
    holder: async (
      name: string,
      nowMs: number,
    ): Promise<string | undefined> => {
      const lease = this.readLeases()[name];
      return lease && lease.expiresAt > nowMs ? lease.holder : undefined;
    },
  };

  private async changeLease(
    name: string,
    holder: string,
    nowMs: number,
    renew: boolean,
  ): Promise<boolean> {
    if (!name || !holder || !Number.isFinite(nowMs))
      throw new Error("Invalid lease arguments");
    return this.locked("leases", () => {
      const leases = this.readLeases();
      const lease = leases[name];
      const live = lease !== undefined && lease.expiresAt > nowMs;
      if (
        renew
          ? !live || lease.holder !== holder
          : live && lease.holder !== holder
      )
        return false;
      leases[name] = { holder, expiresAt: nowMs + LEASE_TTL_MS };
      this.write(join(this.stateDir, "leases.json"), leases);
      return true;
    });
  }
}
