import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStoreAdapter } from "../adapters/store/index";
import { pull } from "../app/fixtures/fakes";
import { world as makeWorld } from "../app/fixtures/world";
import type { HelloEvent, ItemEvent } from "../protocol/index";
import { runWatch } from "./index";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function world() {
  return makeWorld((clock) => {
    const dir = mkdtempSync(join(tmpdir(), "crew-net-watch-"));
    dirs.push(dir);
    return new FileStoreAdapter(dir, clock);
  });
}

/** stdin of the watcher, fed by the test as the mod would. */
class Stdin implements AsyncIterable<string> {
  private readonly queue: string[] = [];
  private wake: (() => void) | undefined;
  private closed = false;
  push(value: unknown): void {
    this.queue.push(typeof value === "string" ? value : JSON.stringify(value));
    this.wake?.();
  }
  close(): void {
    this.closed = true;
    this.wake?.();
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

async function until(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not reached");
}

const hello = (session: string, worktree: string): HelloEvent => ({
  type: "hello",
  session,
  role: "lead",
  harness: "claude-code",
  worktree,
  pid: process.pid,
  settings: { autoWake: true },
});

const ask: ItemEvent = {
  type: "item",
  id: "comment:github.com/o/r#7:1",
  kind: "message",
  text: "@me does it need the column?",
  addressed: true,
  from: "maria",
  repo: "o/r",
  thread: 7,
  event: "ask",
};

function start(
  w: ReturnType<typeof world>,
  session: string,
  alive = () => true,
) {
  const stdin = new Stdin();
  const out: Record<string, unknown>[] = [];
  const done = runWatch(
    w.ports,
    session,
    {
      lines: stdin,
      write: (line) => out.push(JSON.parse(line)),
      parentAlive: alive,
    },
    20,
  );
  let finished = false;
  void done.then(() => {
    finished = true;
  });
  return { stdin, out, done, finished: () => finished };
}

async function twoSessions() {
  const w = world();
  w.git.worktrees = [
    { path: "/work/a", branch: "feat/a" },
    { path: "/work/b", branch: "feat/b" },
  ];
  w.github.open.set("o/r", [pull(7, "me", "feat/b")]);
  return w;
}

describe("watch", () => {
  test("ready, then hello starts ticks; it keeps running until stdin closes", async () => {
    const w = world();
    const watch = start(w, "s1");
    await until(() => watch.out.length > 0);
    expect(watch.out[0]).toEqual({ type: "ready" });
    watch.stdin.push(hello("s1", "/work/a"));
    await until(() => watch.out.some((e) => e.type === "status"));
    await new Promise((r) => setTimeout(r, 80));
    expect(watch.finished()).toBe(false);
    expect((await w.store.sessions.live()).map((s) => s.sessionId)).toEqual([
      "s1",
    ]);
    watch.stdin.close();
    expect(await watch.done).toBe(0);
  });

  test("an item goes to the session with its PR branch checked out, exactly once", async () => {
    const w = await twoSessions();
    const a = start(w, "sa");
    const b = start(w, "sb");
    a.stdin.push(hello("sa", "/work/a"));
    b.stdin.push(hello("sb", "/work/b"));
    await until(async () => (await w.store.sessions.live()).length === 2);
    await w.store.inbox.put(ask);
    await until(() => b.out.some((e) => e.type === "item"));
    await new Promise((r) => setTimeout(r, 80));
    expect(a.out.filter((e) => e.type === "item")).toEqual([]);
    expect(b.out.filter((e) => e.type === "item") as unknown[]).toEqual([ask]);
    expect((await w.store.delivered.get(ask.id))?.sessionId).toBe("sb");
    a.stdin.close();
    b.stdin.close();
    await Promise.all([a.done, b.done]);
  });

  test("a restarted watcher replays its recent claims without a second delivery", async () => {
    const w = await twoSessions();
    await w.store.inbox.put(ask);
    const first = start(w, "sb");
    first.stdin.push(hello("sb", "/work/b"));
    await until(() => first.out.some((e) => e.type === "item"));
    first.stdin.close();
    await first.done;
    const second = start(w, "sb");
    second.stdin.push(hello("sb", "/work/b"));
    await until(() => second.out.some((e) => e.type === "item"));
    second.stdin.close();
    await second.done;
    const deliveries = (await w.store.events.read()).filter(
      (e) => e.type === "delivery",
    );
    expect(deliveries).toHaveLength(1);
  });

  test("ack is logged; a bad line is an error and the watcher goes on", async () => {
    const w = world();
    const watch = start(w, "s1");
    watch.stdin.push("not json");
    watch.stdin.push({ type: "ack", id: "x", outcome: "wake" });
    watch.stdin.push({ type: "status", text: "from the mod?" });
    await until(async () =>
      (await w.store.events.read()).some((e) => e.type === "ack"),
    );
    expect(watch.out.filter((e) => e.type === "error")).toEqual([
      { type: "error", message: "bad event: not JSON" },
      { type: "error", message: "unexpected event status" },
    ]);
    expect(watch.finished()).toBe(false);
    watch.stdin.close();
    await watch.done;
  });

  test("hello for another session is refused", async () => {
    const w = world();
    const watch = start(w, "s1");
    watch.stdin.push(hello("other", "/work/a"));
    await until(() => watch.out.some((e) => e.type === "error"));
    expect(await w.store.sessions.live()).toEqual([]);
    watch.stdin.close();
    await watch.done;
  });

  test("bye ends the session and the watcher", async () => {
    const w = world();
    const watch = start(w, "s1");
    watch.stdin.push(hello("s1", "/work/a"));
    await until(async () => (await w.store.sessions.live()).length === 1);
    watch.stdin.push({ type: "bye" });
    expect(await watch.done).toBe(0);
    expect(await w.store.sessions.live()).toEqual([]);
  });

  test("the watcher exits when its parent is gone", async () => {
    const w = world();
    let alive = true;
    const watch = start(w, "s1", () => alive);
    watch.stdin.push(hello("s1", "/work/a"));
    await until(() => watch.out.some((e) => e.type === "status"));
    alive = false;
    expect(await watch.done).toBe(0);
  });
});
