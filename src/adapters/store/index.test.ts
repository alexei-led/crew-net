import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type {
  JobOutcome,
  OutboundRequest,
  SessionHeartbeat,
} from "../../ports/index";
import type { ItemEvent } from "../../protocol/index";
import {
  defaultStateDir,
  EVENTS_ROTATE_BYTES,
  FileStoreAdapter,
  JOB_LOCK_TTL_MS,
  RETENTION_MS,
  SESSION_LIVE_MS,
  StoreFormatError,
  StoreLockError,
} from "./index";

const T0 = Date.UTC(2026, 10, 9);
let dir: string;
let now: number;
const clock = { now: () => now };
const open = () => new FileStoreAdapter(dir, clock);

beforeEach(() => {
  dir = join(mkdtempSync(join(tmpdir(), "crew-net-store-")), "crew-net");
  now = T0;
});
afterEach(() => {
  rmSync(join(dir, ".."), { recursive: true, force: true });
});

const item = (id = "comment:42", text = "hello"): ItemEvent => ({
  type: "item",
  id,
  kind: "message",
  text,
  addressed: true,
});

const request = (id: string, status: "open" | "in-progress" = "open") =>
  ({
    id,
    repo: "github.com/doiteng/reflex",
    number: 2318,
    to: "maria",
    kind: "ask",
    text: "needs users.tier?",
    createdAtMs: T0,
    status,
  }) satisfies OutboundRequest;

const session = (
  sessionId: string,
  extra: Partial<SessionHeartbeat> = {},
): SessionHeartbeat => ({
  sessionId,
  pid: process.pid,
  harness: "claude",
  role: "lead",
  worktree: "/work/reflex",
  repo: "github.com/doiteng/reflex",
  branch: "feat/tier",
  ...extra,
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const jobLock = (name: string) =>
  join(dir, "locks", `${sha(`job:${name}`)}.lock`);
const mode = (path: string) => statSync(path).mode & 0o777;

function deadPid(): number {
  const pid = spawnSync(process.execPath, ["-e", ""]).pid;
  if (!pid) throw new Error("no pid");
  return pid;
}

function plantLock(path: string, pid: number, expiresAtMs: number): string {
  const token = randomUUID();
  writeFileSync(path, JSON.stringify({ pid, token, expiresAtMs }));
  return token;
}

/** A store in a separate process that starts on a signal, so several can race. */
function child(code: string) {
  const script = `import { FileStoreAdapter } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    const store = new FileStoreAdapter(${JSON.stringify(dir)}, { now: () => Date.now() });
    process.stdout.write("ready\\n");
    await new Promise(resolve => process.stdin.once("data", resolve));
    ${code}
    process.stdin.destroy();`;
  const proc = spawn(process.execPath, ["-e", script], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let stderr = "";
  let readyResolve: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  proc.stdout.on("data", (data) => {
    output += String(data);
    if (output.includes("ready\n")) readyResolve();
  });
  proc.stderr.on("data", (data) => {
    stderr += String(data);
  });
  const done = new Promise<string>((resolve, reject) => {
    proc.on("error", reject);
    proc.on("exit", (rc) => {
      readyResolve();
      if (rc !== 0) reject(new Error(`child rc=${rc}: ${stderr}`));
      else resolve(output.replace("ready\n", "").trim());
    });
  });
  return { ready, done, start: () => proc.stdin.end("go\n") };
}

async function race(...codes: string[]): Promise<string[]> {
  const children = codes.map(child);
  await Promise.all(children.map((c) => c.ready));
  for (const c of children) c.start();
  return Promise.all(children.map((c) => c.done));
}

function tempFiles(root: string): string[] {
  return readdirSync(root, { recursive: true, encoding: "utf8" }).filter(
    (name) => name.endsWith(".tmp"),
  );
}

describe("layout", () => {
  test.each([
    [{ XDG_STATE_HOME: "/x/state" }, "/x/state/crew-net"],
    [{}, "/home/me/.local/state/crew-net"],
    [{ XDG_STATE_HOME: "" }, "/home/me/.local/state/crew-net"],
    [{ XDG_STATE_HOME: "relative" }, "/home/me/.local/state/crew-net"],
  ])("defaultStateDir(%j)", (env, expected) => {
    expect(defaultStateDir(env, "/home/me")).toBe(expected);
  });

  test("directories are 0700 even when they already exist", () => {
    mkdirSync(join(dir, "inbox"), { recursive: true, mode: 0o755 });
    open();
    for (const sub of [
      "",
      "inbox",
      "delivered",
      "sessions",
      "repos",
      "locks",
      "kv",
    ])
      expect(mode(join(dir, sub))).toBe(0o700);
  });

  test("ids become fixed hashed filenames inside the store", async () => {
    const store = open();
    const id = `../../escape/${"x".repeat(500)}`;
    await store.inbox.put(item(id));
    await store.delivered.claim(id, "s1");
    await store.sessions.beat(session("../../s"));
    await store.kv.set("../../k", 1);
    for (const sub of ["inbox", "delivered", "sessions", "kv"])
      for (const name of readdirSync(join(dir, sub)))
        expect(name).toMatch(/^[0-9a-f]{64}(\.json)?$/);
    expect((await store.inbox.get(id))?.item).toEqual(item(id));
    expect(mode(join(dir, "inbox", `${sha(id)}.json`))).toBe(0o600);
    await expect(store.inbox.put(item(""))).rejects.toThrow();
  });

  test.each([
    { host: "..", owner: "o", name: "r" },
    { host: "github.com", owner: "a/b", name: "r" },
    { host: "github.com", owner: "o", name: "" },
    { host: "github.com", owner: ".", name: "r" },
  ])("repo path segment is refused: %j", async (repo) => {
    await expect(open().repos.write(repo, "radar", [])).rejects.toThrow(
      "plain names",
    );
  });
});

describe("inbox and delivery", () => {
  test("items survive a restart, keep their first receive time and list oldest first", async () => {
    const store = open();
    await store.inbox.put(item("b"));
    now += 1000;
    await store.inbox.put(item("a"));
    now += 1000;
    await store.inbox.put(item("b", "edited"));
    const replay = open();
    expect(await replay.inbox.list()).toEqual([
      { item: item("b", "edited"), receivedAtMs: T0 },
      { item: item("a"), receivedAtMs: T0 + 1000 },
    ]);
    expect(await replay.inbox.get("missing")).toBeUndefined();
  });

  test("a claim belongs to its first session and shows on the item", async () => {
    const store = open();
    await store.inbox.put(item());
    expect(await store.delivered.claim("comment:42", "s1")).toBe(true);
    now += 5;
    expect(await store.delivered.claim("comment:42", "s2")).toBe(false);
    expect(await store.delivered.claim("comment:42", "s1")).toBe(true);
    expect((await open().inbox.get("comment:42"))?.delivered).toEqual({
      sessionId: "s1",
      atMs: T0,
    });
  });

  test("concurrent claims from four processes have exactly one winner", async () => {
    const results = await race(
      ...["s1", "s2", "s3", "s4"].map(
        (s) =>
          `console.log(await store.delivered.claim("comment:42", "${s}"));`,
      ),
    );
    expect(results.sort()).toEqual(["false", "false", "false", "true"]);
    expect(readdirSync(join(dir, "delivered"))).toHaveLength(1);
  }, 15_000);

  test("prune removes delivered items after 14 days and keeps the rest", async () => {
    const store = open();
    for (const id of ["old", "recent", "pending"])
      await store.inbox.put(item(id));
    await store.delivered.claim("old", "s1");
    await store.delivered.claim("orphan", "s1");
    now += 1000;
    await store.delivered.claim("recent", "s1");
    now = T0 + RETENTION_MS;
    await store.prune();
    expect((await store.inbox.list()).map((e) => e.item.id)).toEqual([
      "pending",
      "recent",
    ]);
    expect(await store.delivered.get("old")).toBeUndefined();
    expect(await store.delivered.get("orphan")).toBeUndefined();
    expect(await store.delivered.get("recent")).toBeDefined();
  });
});

describe("outbox", () => {
  test("upsert, list and remove survive a restart", async () => {
    const store = open();
    await store.outbox.put(request("k1"));
    await store.outbox.put(request("k2"));
    await store.outbox.put(request("k1", "in-progress"));
    expect(await open().outbox.list()).toEqual([
      request("k1", "in-progress"),
      request("k2"),
    ]);
    await store.outbox.remove("k1");
    await store.outbox.remove("k1");
    expect(await store.outbox.list()).toEqual([request("k2")]);
    expect(JSON.parse(readFileSync(join(dir, "outbox.json"), "utf8"))).toEqual([
      request("k2"),
    ]);
  });

  test("two processes adding requests lose none", async () => {
    const put = (prefix: string) =>
      `for (let i = 0; i < 25; i++) await store.outbox.put({id: "${prefix}" + i, repo: "github.com/o/r", number: 1, to: "maria", kind: "ask", text: "q", createdAtMs: 1, status: "open"});`;
    await race(put("a"), put("b"));
    expect((await open().outbox.list()).length).toBe(50);
  }, 15_000);

  test("a mutex left by a dead process is recovered", async () => {
    const store = open();
    plantLock(
      join(dir, "locks", `${sha("mutex:outbox")}.lock`),
      deadPid(),
      T0 + JOB_LOCK_TTL_MS,
    );
    await store.outbox.put(request("k1"));
    expect(await store.outbox.list()).toEqual([request("k1")]);
  });
});

describe("sessions", () => {
  test("live means a heartbeat younger than 3 minutes", async () => {
    const store = open();
    await store.sessions.beat(session("old"));
    now += 1;
    await store.sessions.beat(
      session("new", { role: "worker", lastPromptAtMs: T0 }),
    );
    now = T0 + SESSION_LIVE_MS;
    expect(await open().sessions.live()).toEqual([
      {
        ...session("new", { role: "worker", lastPromptAtMs: T0 }),
        seenAtMs: T0 + 1,
      },
    ]);
    await store.sessions.remove("new");
    expect(await store.sessions.live()).toEqual([]);
  });

  test("optional fields may be absent and bad heartbeats are refused", async () => {
    const store = open();
    await store.sessions.beat({
      sessionId: "s",
      pid: 1,
      harness: "cli",
      role: "lead",
      worktree: "/w",
    });
    expect(await store.sessions.live()).toEqual([
      {
        sessionId: "s",
        pid: 1,
        harness: "cli",
        role: "lead",
        worktree: "/w",
        seenAtMs: T0,
      },
    ]);
    await expect(
      store.sessions.beat({ ...session("s"), role: "boss" as "lead" }),
    ).rejects.toThrow("heartbeat");
  });

  test("prune removes session files older than the retention", async () => {
    const store = open();
    await store.sessions.beat(session("gone"));
    now += RETENTION_MS;
    await store.sessions.beat(session("here"));
    await store.prune();
    expect(readdirSync(join(dir, "sessions"))).toEqual([`${sha("here")}.json`]);
  });
});

describe("repos, cursors, kv", () => {
  test("repo snapshot and radar live under host/owner/repo", async () => {
    const store = open();
    const repo = { host: "github.com", owner: "doiteng", name: "reflex" };
    expect(await store.repos.read(repo, "snapshot")).toBeUndefined();
    await store.repos.write(repo, "snapshot", { pulls: [1], etag: "W/1" });
    await store.repos.write(repo, "radar", []);
    const replay = open();
    expect(await replay.repos.read(repo, "snapshot")).toEqual({
      pulls: [1],
      etag: "W/1",
    });
    expect(await replay.repos.read(repo, "radar")).toEqual([]);
    expect(mode(join(dir, "repos", "github.com", "doiteng"))).toBe(0o700);
    expect(
      existsSync(join(dir, "repos/github.com/doiteng/reflex/snapshot.json")),
    ).toBe(true);
  });

  test("named cursors survive a restart, including odd names", async () => {
    const store = open();
    await store.cursors.set("notifications", "2026-11-09T12:00:00Z");
    await store.cursors.set("__proto__", "safe");
    const replay = open();
    expect(await replay.cursors.get("notifications")).toBe(
      "2026-11-09T12:00:00Z",
    );
    expect(await replay.cursors.get("__proto__")).toBe("safe");
    expect(await replay.cursors.get("other")).toBeUndefined();
  });

  test("kv values survive a new instance", async () => {
    await open().kv.set("etag:/repos/o/r/pulls", { etag: 'W/"1"', body: [] });
    const replay = open();
    expect(await replay.kv.get("etag:/repos/o/r/pulls")).toEqual({
      etag: 'W/"1"',
      body: [],
    });
    expect(await replay.kv.get("missing")).toBeUndefined();
    await replay.kv.set("null", null);
    expect(await replay.kv.get("null")).toBeNull();
  });

  test("kv updates from two processes are serialized", async () => {
    const bump = `for (let i = 0; i < 40; i++) await store.kv.update("budget", (n) => (typeof n === "number" ? n : 0) + 1);`;
    await race(bump, bump);
    expect(await open().kv.get("budget")).toBe(80);
  }, 15_000);

  test("atomic writes under concurrent writers never expose partial JSON", async () => {
    const writer = (prefix: string) =>
      child(
        `for (let i = 0; i < 30; i++) await store.kv.set("big", ${JSON.stringify(prefix)} + i + "x".repeat(20_000));`,
      );
    const writers = [writer("a"), writer("b")];
    await Promise.all(writers.map((w) => w.ready));
    for (const w of writers) w.start();
    let done = false;
    const completed = Promise.all(writers.map((w) => w.done)).finally(() => {
      done = true;
    });
    const store = open();
    let reads = 0;
    while (!done) {
      const value = await store.kv.get("big");
      if (value !== undefined) {
        expect(value).toMatch(/^[ab]\d+x{20000}$/);
        reads++;
      }
      await setImmediate();
    }
    await completed;
    expect(reads).toBeGreaterThan(0);
    expect(tempFiles(dir)).toEqual([]);
  }, 15_000);
});

describe("jobs", () => {
  test("a second trigger within the interval is a no-op", async () => {
    const store = open();
    let runs = 0;
    const job = async () => {
      runs++;
    };
    expect(await store.jobs.run("inbox", 60_000, job)).toBe("ran");
    now += 59_999;
    expect(await open().jobs.run("inbox", 60_000, job)).toBe("fresh");
    now += 1;
    expect(await store.jobs.run("inbox", 60_000, job)).toBe("ran");
    expect(runs).toBe(2);
    expect(await store.jobs.lastRun("inbox")).toBe(T0 + 60_000);
    expect(existsSync(jobLock("inbox"))).toBe(false);
  });

  test("a job running elsewhere makes another trigger busy", async () => {
    const store = open();
    let release: () => void = () => {};
    const running = store.jobs.run(
      "fetch",
      0,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    expect(await open().jobs.run("fetch", 0, async () => {})).toBe("busy");
    release();
    expect(await running).toBe("ran");
  });

  test("a failing job is recorded as run, rethrows and releases its lock", async () => {
    const store = open();
    await expect(
      store.jobs.run("repo", 60_000, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await store.jobs.lastRun("repo")).toBe(T0);
    expect(existsSync(jobLock("repo"))).toBe(false);
    now += 60_000;
    expect(await store.jobs.run("repo", 60_000, async () => {})).toBe("ran");
  });

  test("a job's own error wins over a failure to record the run", async () => {
    const store = open();
    await expect(
      store.jobs.run("repo", 0, async () => {
        writeFileSync(join(dir, "cursors.json"), "{");
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(existsSync(jobLock("repo"))).toBe(false);
  });

  test("a reaper whose stale lock was already replaced leaves the live lock", () => {
    const store = open();
    const path = jobLock("sync");
    const live = plantLock(path, process.pid, now + JOB_LOCK_TTL_MS);
    const stale = { pid: deadPid(), token: randomUUID(), expiresAtMs: now };
    const me = { pid: process.pid, token: randomUUID(), expiresAtMs: now + 1 };
    // biome-ignore lint/complexity/useLiteralKeys: private seam; the race window cannot be hit from outside
    store["recover"](path, stale, me);
    expect(JSON.parse(readFileSync(path, "utf8")).token).toBe(live);
  });

  test("prune keeps a dead reaper's marker while a lock still carries its token", async () => {
    const store = open();
    const dead = deadPid();
    const token = plantLock(jobLock("sync"), dead, now + 1);
    const marker = join(dir, "locks", `recovery-${token}`);
    plantLock(marker, dead, now + 1);
    await store.prune();
    expect(existsSync(marker)).toBe(true);
    rmSync(jobLock("sync"));
    await store.prune();
    expect(existsSync(marker)).toBe(false);
  });

  // pid 1 always exists; kill(1, 0) from a normal user fails with EPERM,
  // which must count as alive (as root it simply succeeds). kill(1, 0) from a normal user fails with EPERM,
  // which must count as alive. It also stands in for a reused pid.
  const myPid = () => process.pid;
  const pidOne = () => 1;
  test.each<[string, () => number, number, JobOutcome]>([
    ["live holder, unexpired", myPid, 1, "busy"],
    ["live holder, expired", myPid, 0, "ran"],
    ["dead holder, unexpired", deadPid, 1, "ran"],
    ["EPERM holder, unexpired", pidOne, 1, "busy"],
    ["reused pid, expired", pidOne, 0, "ran"],
  ])("job lock with %s → %s", async (_, pid, ttl, outcome) => {
    const store = open();
    plantLock(jobLock("sync"), pid(), now + ttl);
    expect(await store.jobs.run("sync", 0, async () => {})).toBe(outcome);
    expect(existsSync(jobLock("sync"))).toBe(outcome === "busy");
  });

  test("an expired holder that finishes late does not remove its replacement", async () => {
    let release: () => void = () => {};
    const slow = open().jobs.run(
      "fetch",
      0,
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    now += JOB_LOCK_TTL_MS;
    const takeover = open().jobs.run("fetch", 0, async () => {
      release();
      expect(await slow).toBe("ran");
      expect(existsSync(jobLock("fetch"))).toBe(true);
    });
    expect(await takeover).toBe("ran");
    expect(existsSync(jobLock("fetch"))).toBe(false);
  });

  test("two reapers of a crash during recovery: exactly one job runs", async () => {
    open();
    const dead = deadPid();
    const token = plantLock(jobLock("sync"), dead, Date.now() + 60_000);
    plantLock(
      join(dir, "locks", `recovery-${token}`),
      dead,
      Date.now() + 60_000,
    );
    const run = `console.log(await store.jobs.run("sync", 60_000, () => new Promise(r => setTimeout(r, 300))));`;
    expect((await race(run, run)).sort()).toEqual(["busy", "ran"]);
  }, 15_000);
});

describe("events", () => {
  test("append writes one JSON line each", async () => {
    const store = open();
    await store.events.append({ type: "sync", ms: 12 });
    await store.events.append({ type: "deliver", id: "c:1" });
    expect(readFileSync(join(dir, "events.ndjson"), "utf8")).toBe(
      '{"type":"sync","ms":12}\n{"type":"deliver","id":"c:1"}\n',
    );
    expect(mode(join(dir, "events.ndjson"))).toBe(0o600);
  });

  test("the log rotates once it reaches 10 MB", async () => {
    const store = open();
    const path = join(dir, "events.ndjson");
    writeFileSync(path, Buffer.alloc(EVENTS_ROTATE_BYTES - 1, "a"));
    await store.events.append({ n: 1 });
    expect(statSync(path).size).toBe(EVENTS_ROTATE_BYTES + 7);
    await store.events.append({ n: 2 });
    expect(statSync(`${path}.1`).size).toBe(EVENTS_ROTATE_BYTES + 7);
    expect(readFileSync(path, "utf8")).toBe('{"n":2}\n');
  });

  test("two processes crossing 10 MB rotate once and lose no line", async () => {
    const path = join(dir, "events.ndjson");
    open();
    writeFileSync(path, `${"a".repeat(EVENTS_ROTATE_BYTES - 1)}\n`);
    const append = (p: string) =>
      `for (let i = 0; i < 20; i++) await store.events.append({p: "${p}", i});`;
    await race(append("a"), append("b"));
    const lines = (f: string) =>
      readFileSync(f, "utf8").split("\n").filter(Boolean);
    const all = [...lines(`${path}.1`), ...lines(path)];
    expect(all.filter((l) => l.startsWith("{"))).toHaveLength(40);
    expect(all.filter((l) => l.startsWith("a"))).toHaveLength(1);
  }, 15_000);
});

describe("maintenance and failure", () => {
  test("prune removes stale recovery markers and dead writers' temp files", async () => {
    const store = open();
    const live = join(dir, "locks", `recovery-${randomUUID()}`);
    const expired = join(dir, "locks", `recovery-${randomUUID()}`);
    const dead = join(dir, "locks", `recovery-${randomUUID()}`);
    plantLock(live, process.pid, now + 1);
    plantLock(expired, process.pid, now);
    plantLock(dead, deadPid(), now + 1);
    const orphan = join(
      dir,
      "inbox",
      `x.json.${deadPid()}.${randomUUID()}.tmp`,
    );
    const mine = join(dir, "kv", `y.json.${process.pid}.${randomUUID()}.tmp`);
    const foreign = join(dir, "notes.tmp");
    for (const path of [orphan, mine, foreign]) writeFileSync(path, "{");
    await store.prune();
    expect(
      [live, expired, dead, orphan, mine, foreign].map(existsSync),
    ).toEqual([true, false, false, false, true, true]);
  });

  test.each([
    [
      "inbox",
      `inbox/${sha("a")}.json`,
      '{"item":{"type":"item"},"receivedAtMs":1}',
      (s: FileStoreAdapter) => s.inbox.list(),
    ],
    [
      "inbox under the wrong name",
      `inbox/${sha("b")}.json`,
      JSON.stringify({ item: item("a"), receivedAtMs: 1 }),
      (s: FileStoreAdapter) => s.inbox.list(),
    ],
    [
      "claim",
      `delivered/${sha("a")}`,
      '{"sessionId":7}',
      (s: FileStoreAdapter) => s.delivered.get("a"),
    ],
    [
      "outbox",
      "outbox.json",
      '[{"id":"k"}]',
      (s: FileStoreAdapter) => s.outbox.list(),
    ],
    [
      "session",
      `sessions/${sha("s")}.json`,
      "{",
      (s: FileStoreAdapter) => s.sessions.live(),
    ],
    [
      "cursors",
      "cursors.json",
      '{"cursors":{"a":1},"lastRun":{}}',
      (s: FileStoreAdapter) => s.cursors.get("a"),
    ],
    [
      "kv under another key",
      `kv/${sha("k")}.json`,
      '{"key":"other","value":1}',
      (s: FileStoreAdapter) => s.kv.get("k"),
    ],
  ])("corrupt %s fails closed", async (_, file, text, call) => {
    const store = open();
    writeFileSync(join(dir, file), text);
    await expect(call(store)).rejects.toBeInstanceOf(StoreFormatError);
  });

  test("a corrupt lock fails closed", async () => {
    const store = open();
    writeFileSync(jobLock("sync"), '{"pid":"x"}');
    await expect(
      store.jobs.run("sync", 0, async () => {}),
    ).rejects.toBeInstanceOf(StoreLockError);
  });

  test("an interrupted temp write is invisible", async () => {
    const store = open();
    await store.inbox.put(item());
    writeFileSync(
      join(dir, "inbox", `z.json.${process.pid}.${randomUUID()}.tmp`),
      "{",
    );
    writeFileSync(
      join(dir, `outbox.json.${process.pid}.${randomUUID()}.tmp`),
      "[",
    );
    expect((await open().inbox.list()).map((e) => e.item.id)).toEqual([
      "comment:42",
    ]);
    expect(await store.outbox.list()).toEqual([]);
  });

  test("stray files in store directories are ignored", async () => {
    const store = open();
    await store.inbox.put(item());
    await store.sessions.beat(session("s"));
    for (const sub of ["inbox", "delivered", "sessions", "locks"])
      writeFileSync(join(dir, sub, ".DS_Store"), "\0binary");
    expect((await store.inbox.list()).map((e) => e.item.id)).toEqual([
      "comment:42",
    ]);
    expect((await store.sessions.live()).map((s) => s.sessionId)).toEqual([
      "s",
    ]);
    await store.prune();
  });

  test("a session file under another session's name fails closed", async () => {
    const store = open();
    await store.sessions.beat(session("a"));
    writeFileSync(
      join(dir, "sessions", `${sha("b")}.json`),
      readFileSync(join(dir, "sessions", `${sha("a")}.json`)),
    );
    await expect(store.prune()).rejects.toBeInstanceOf(StoreFormatError);
  });

  test("a lock pid outside int32 fails closed as a lock error", async () => {
    const store = open();
    plantLock(jobLock("sync"), 99_999_999_999, now + 1);
    await expect(
      store.jobs.run("sync", 0, async () => {}),
    ).rejects.toBeInstanceOf(StoreLockError);
  });
});
