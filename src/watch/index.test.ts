import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStoreAdapter } from "../adapters/store/index";
import { pull } from "../app/fixtures/fakes";
import { world as makeWorld } from "../app/fixtures/world";
import { Watcher } from "../app/watch";
import type { HelloEvent, HelperEvent, ItemEvent } from "../protocol/index";
import { runWatch, sendToWatch } from "./index";

const dirs: string[] = [];
/** Stops for every watcher a test started: a failed test must not leave one ticking. */
const running: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const stop of running.splice(0)) await stop();
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
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 1));
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
  let signal: () => void = () => {};
  const stopped = new Promise<void>((resolve) => {
    signal = resolve;
  });
  const done = runWatch(
    w.ports,
    session,
    {
      lines: stdin,
      write: (line) => out.push(JSON.parse(line)),
      parentAlive: alive,
      stopped,
    },
    5,
  );
  let finished = false;
  void done.then(() => {
    finished = true;
  });
  running.push(() => {
    signal();
    stdin.close();
    return done;
  });
  return { stdin, out, done, signal, finished: () => finished };
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
  test("ready, then hello; stdin EOF after hello is normal and it runs until a stop signal", async () => {
    const w = world();
    let parentChecks = 0;
    const watch = start(w, "s1", () => {
      parentChecks++;
      return true;
    });
    await until(() => watch.out.length > 0);
    expect(watch.out[0]).toEqual({ type: "ready" });
    watch.stdin.push(hello("s1", "/work/a"));
    watch.stdin.close();
    await until(() => watch.out.some((e) => e.type === "status"));
    const checksAtEof = parentChecks;
    await until(() => parentChecks >= checksAtEof + 3);
    expect(watch.finished()).toBe(false);
    expect((await w.store.sessions.live()).map((s) => s.sessionId)).toEqual([
      "s1",
    ]);
    watch.signal();
    expect(await watch.done).toBe(0);
  });

  test("stdin closed before any hello exits 1", async () => {
    const watch = start(world(), "s1");
    watch.stdin.close();
    expect(await watch.done).toBe(1);
    expect(watch.out.at(-1)).toEqual({
      type: "error",
      message: "stdin closed before hello",
    });
  });

  test("watch send applies ack and bye after the watcher's stdin closed", async () => {
    const w = world();
    const watch = start(w, "s1");
    watch.stdin.push(hello("s1", "/work/a"));
    watch.stdin.close();
    await until(async () => (await w.store.sessions.live()).length === 1);
    const send = new Stdin();
    send.push({ type: "ack", id: "x", outcome: "context" });
    send.push({ type: "bye" });
    send.push("junk");
    send.close();
    const reported: string[] = [];
    expect(
      await sendToWatch(w.ports, "s1", send, (m) => reported.push(m)),
    ).toBe(1);
    expect(reported).toEqual(["bad event: not JSON"]);
    expect(await w.store.sessions.live()).toEqual([]);
    expect((await w.store.events.read()).some((e) => e.type === "ack")).toBe(
      true,
    );
    watch.signal();
    await watch.done;
  });

  test("an item goes to the session with its PR branch checked out, exactly once", async () => {
    const w = await twoSessions();
    const aOut: HelperEvent[] = [];
    const bOut: HelperEvent[] = [];
    const a = new Watcher(w.ports, "sa", (e) => aOut.push(e));
    const b = new Watcher(w.ports, "sb", (e) => bOut.push(e));
    await a.start(hello("sa", "/work/a"));
    await b.start(hello("sb", "/work/b"));
    await w.store.inbox.put(ask);
    await a.tick();
    await b.tick();
    await a.tick();
    await b.tick();
    expect(aOut.filter((e) => e.type === "item")).toEqual([]);
    expect(bOut.filter((e) => e.type === "item")).toEqual([
      { ...ask, wakeable: true, ownPr: true },
    ]);
    expect((await w.store.delivered.get(ask.id))?.sessionId).toBe("sb");
  });

  test("a restarted watcher replays its recent claims without a second delivery", async () => {
    const w = await twoSessions();
    await w.store.inbox.put(ask);
    const firstOut: HelperEvent[] = [];
    await new Watcher(w.ports, "sb", (e) => firstOut.push(e)).start(
      hello("sb", "/work/b"),
    );
    const secondOut: HelperEvent[] = [];
    await new Watcher(w.ports, "sb", (e) => secondOut.push(e)).start(
      hello("sb", "/work/b"),
    );
    expect(firstOut.filter((e) => e.type === "item")).toHaveLength(1);
    expect(secondOut.filter((e) => e.type === "item")).toHaveLength(1);
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
    watch.signal();
    await watch.done;
  });

  test("hello for another session is refused", async () => {
    const w = world();
    const watch = start(w, "s1");
    watch.stdin.push(hello("other", "/work/a"));
    await until(() => watch.out.some((e) => e.type === "error"));
    expect(await w.store.sessions.live()).toEqual([]);
    watch.signal();
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

  test("no heartbeat or claim after bye, even from a queued tick", async () => {
    const w = world();
    const watcher = new Watcher(w.ports, "s1", () => {});
    await watcher.start(hello("s1", "/work/a"));
    await watcher.bye();
    await watcher.tick();
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
