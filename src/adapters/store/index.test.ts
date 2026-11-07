import { afterEach, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import type { ItemEvent } from "../../protocol/index";
import { FileStoreAdapter, LEASE_TTL_MS, StoreFormatError } from "./index";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crew-net-store-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});
const item = (id = "comment:42", text = "hello"): ItemEvent => ({
  v: 1,
  type: "item",
  id,
  kind: "message",
  text,
  addressed: true,
});

function child(code: string) {
  const script = `import { FileStoreAdapter } from ${JSON.stringify(new URL("./index.ts", import.meta.url).href)};
    const store = new FileStoreAdapter(${JSON.stringify(dir)});
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

test("versioned cursor, inbox and seen survive a restart and replay until ack", async () => {
  const store = new FileStoreAdapter(dir);
  expect(await store.cursor.get()).toBeUndefined();
  await store.cursor.set("2026-11-07T12:00:00Z");
  await store.inbox.put("comment:42", item());
  await store.seen.add("comment:42");
  await store.seen.add("comment:42");
  const replay = new FileStoreAdapter(dir);
  expect(await replay.cursor.get()).toBe("2026-11-07T12:00:00Z");
  expect(await replay.inbox.list()).toEqual([item()]);
  expect(await replay.seen.has("comment:42")).toBe(true);
  expect(await replay.seen.has("other")).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, "seen"), "utf8"))).toEqual({
    v: 1,
    value: ["comment:42"],
  });
  await replay.inbox.ack("comment:42");
  await replay.inbox.ack("comment:42");
  expect(await store.inbox.list()).toEqual([]);
});

test("outbox stays open until explicitly acknowledged", async () => {
  const store = new FileStoreAdapter(dir);
  const request = {
    id: "send:1",
    issueNumber: 7,
    to: "maria/orion",
    body: "question",
    createdAt: "2026-11-07T12:00:00Z",
  };
  await store.outbox.put(request.id, request);
  expect(await new FileStoreAdapter(dir).outbox.open()).toEqual([request]);
  await store.outbox.ack(request.id);
  expect(await store.outbox.open()).toEqual([]);
});

test("interrupted temp writes are invisible and replay the last committed state", async () => {
  const store = new FileStoreAdapter(dir);
  await store.cursor.set("before");
  await store.inbox.put("comment:42", item());
  writeFileSync(join(dir, "cursor.crashed.tmp"), '{"v":1,');
  writeFileSync(join(dir, "inbox", "item.crashed.tmp"), '{"v":1,');
  const replay = new FileStoreAdapter(dir);
  expect(await replay.cursor.get()).toBe("before");
  expect(await replay.inbox.list()).toEqual([item()]);
});

test("ids cannot escape the state directory and must match stored items", async () => {
  const store = new FileStoreAdapter(dir);
  const id = `../../escape${"x".repeat(500)}`;
  await store.inbox.put(id, item(id));
  expect(await store.inbox.list()).toEqual([item(id)]);
  await expect(store.inbox.put("different", item())).rejects.toThrow("match");
  await expect(store.inbox.put("", item(""))).rejects.toThrow("empty");
});

test.each([
  '{"v":2,"value":"cursor"}',
  '{"v":1,"value":42}',
  '{"v":1}',
  '{"v":',
])("malformed or future-version cursor fails closed: %s", async (text) => {
  const store = new FileStoreAdapter(dir);
  writeFileSync(join(dir, "cursor"), text);
  await expect(store.cursor.get()).rejects.toBeInstanceOf(StoreFormatError);
});

test("lease expiry, own renewal, takeover, and owner-only release", async () => {
  const store = new FileStoreAdapter(dir);
  expect(await store.leases.claim("atlas", "one", 0)).toBe(true);
  expect(await store.leases.claim("atlas", "two", 1)).toBe(false);
  expect(await store.leases.renew("atlas", "two", 1)).toBe(false);
  expect(await store.leases.holder("atlas", LEASE_TTL_MS - 1)).toBe("one");
  expect(await store.leases.renew("atlas", "one", 60_000)).toBe(true);
  expect(await store.leases.holder("atlas", LEASE_TTL_MS)).toBe("one");
  await store.leases.release("atlas", "two");
  expect(await store.leases.holder("atlas", 60_000)).toBe("one");
  expect(
    await store.leases.holder("atlas", 60_000 + LEASE_TTL_MS),
  ).toBeUndefined();
  expect(await store.leases.renew("atlas", "one", 60_000 + LEASE_TTL_MS)).toBe(
    false,
  );
  expect(await store.leases.claim("atlas", "two", 60_000 + LEASE_TTL_MS)).toBe(
    true,
  );
  await store.leases.release("atlas", "one");
  expect(await store.leases.holder("atlas", 240_000)).toBe("two");
  await store.leases.release("atlas", "two");
  expect(await store.leases.holder("atlas", 240_000)).toBeUndefined();
  expect(await store.leases.claim("__proto__", "safe", 0)).toBe(true);
  expect(await store.leases.holder("__proto__", 0)).toBe("safe");
});

test("two child processes claiming simultaneously have exactly one winner", async () => {
  const first = child(
    'console.log(await store.leases.claim("atlas", "one", 0));',
  );
  const second = child(
    'console.log(await store.leases.claim("atlas", "two", 0));',
  );
  await Promise.all([first.ready, second.ready]);
  first.start();
  second.start();
  expect((await Promise.all([first.done, second.done])).sort()).toEqual([
    "false",
    "true",
  ]);
  expect(await new FileStoreAdapter(dir).leases.holder("atlas", 0)).toMatch(
    /^(one|two)$/,
  );
}, 10_000);

test("a lock left by a dead process is recovered without consulting a clock", async () => {
  const crashed = child(`const { writeFileSync } = await import("node:fs");
    writeFileSync(${JSON.stringify(join(dir, "leases.lock"))}, JSON.stringify({v: 1, value: {pid: process.pid, token: crypto.randomUUID()}}));`);
  await crashed.ready;
  crashed.start();
  await crashed.done;
  const store = new FileStoreAdapter(dir);
  expect(await store.leases.claim("atlas", "live", 0)).toBe(true);
  expect(readdirSync(dir)).not.toContain("leases.lock");
}, 10_000);

test("two reapers recover a crash during recovery without both winning the lease", async () => {
  const crashed = child(`const {writeFileSync} = await import("node:fs");
    const token = crypto.randomUUID();
    const dead = {pid: process.pid, token};
    writeFileSync(${JSON.stringify(join(dir, "leases.lock"))}, JSON.stringify({v: 1, value: dead}));
    writeFileSync(${JSON.stringify(join(dir, "locks"))} + "/recovery-" + token,
      JSON.stringify({v: 1, value: {pid: process.pid, token: crypto.randomUUID()}}));`);
  await crashed.ready;
  crashed.start();
  await crashed.done;
  const first = child(
    'console.log(await store.leases.claim("atlas", "one", 0));',
  );
  const second = child(
    'console.log(await store.leases.claim("atlas", "two", 0));',
  );
  await Promise.all([first.ready, second.ready]);
  first.start();
  second.start();
  expect((await Promise.all([first.done, second.done])).sort()).toEqual([
    "false",
    "true",
  ]);
}, 10_000);

test("invalid seen, lease and inbox files fail closed", async () => {
  const store = new FileStoreAdapter(dir);
  writeFileSync(join(dir, "seen"), '{"v":1,"value":[42]}');
  await expect(store.seen.has("42")).rejects.toBeInstanceOf(StoreFormatError);
  writeFileSync(join(dir, "leases.json"), '{"v":1,"value":null}');
  await expect(store.leases.claim("atlas", "one", 0)).rejects.toBeInstanceOf(
    StoreFormatError,
  );
  writeFileSync(
    join(dir, "inbox", "corrupt.json"),
    '{"v":1,"value":{"type":"item"}}',
  );
  await expect(store.inbox.list()).rejects.toBeInstanceOf(StoreFormatError);
});

test("atomic replacements under two writers never expose partial JSON or lose seen ids", async () => {
  const run = (prefix: string) =>
    child(`for (let i = 0; i < 30; i++) {
    await store.cursor.set(${JSON.stringify(prefix)} + i + "x".repeat(10_000));
    await store.seen.add(${JSON.stringify(prefix)} + i);
  }`);
  const first = run("a");
  const second = run("b");
  await Promise.all([first.ready, second.ready]);
  first.start();
  second.start();
  let done = false;
  const completed = Promise.all([first.done, second.done]).finally(() => {
    done = true;
  });
  const store = new FileStoreAdapter(dir);
  let reads = 0;
  while (!done) {
    const value = await store.cursor.get();
    if (value !== undefined) {
      expect(value).toMatch(/^[ab]\d+x{10000}$/);
      reads++;
    }
    await setImmediate();
  }
  await completed;
  expect(reads).toBeGreaterThan(0);
  for (const prefix of ["a", "b"]) {
    for (let i = 0; i < 30; i++)
      expect(await store.seen.has(prefix + i)).toBe(true);
  }
  expect(
    readdirSync(dir).some(
      (file) => file.endsWith(".tmp") || file.endsWith(".lock"),
    ),
  ).toBe(false);
}, 15_000);
