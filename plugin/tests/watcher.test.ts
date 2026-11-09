import { expect, mock, test } from "claude-code/testing";
import {
  acks,
  ask,
  line,
  MINUTE,
  mountBand,
  PID,
  ROOT,
  SURFACES,
  start,
  userPrompt,
  world,
} from "./world";

test("the watcher starts with hello for this session and stays without stdin", async ($, on) => {
  const w = world(on, mock);
  await start($, w);
  expect(w.spawns).toHaveLength(1);
  const spawn = w.spawns[0];
  expect(spawn?.argv[0]).toBe("node");
  expect(spawn?.argv.slice(2)).toEqual(["watch", "--session", "session-1"]);
  expect(spawn?.argv[1]).toEndWith("/bin/crew-net");
  expect(spawn?.cwd).toBe(ROOT);
  expect(JSON.parse(spawn?.input ?? "")).toEqual({
    type: "hello",
    session: "session-1",
    role: "lead",
    harness: "claude-code",
    worktree: ROOT,
    pid: PID,
    settings: { autoWake: true },
    repo: "doiteng/reflex",
  });
});

test("ready connects; a restart waits with backoff and ready does not reset it", async ($, on) => {
  const w = world(on, mock);
  await start($, w);
  await w.emit(line({ type: "ready" }));
  expect(w.statuses.at(-1)).toBe("crew-net: connected");
  // Crash right after ready: 1 s, then 2 s, then 4 s.
  for (const [n, waitMs] of [
    [2, 1_000],
    [3, 2_000],
    [4, 4_000],
  ] as const) {
    await w.exit();
    expect(w.statuses.at(-1)).toBe(
      `crew-net: watcher stopped; restarting in ${waitMs / 1000}s`,
    );
    await w.clock.advance(waitMs - 1);
    expect(w.spawns).toHaveLength(n - 1);
    await w.clock.advance(1);
    await w.idle(n);
    expect(w.spawns).toHaveLength(n);
    await w.emit(line({ type: "ready" }));
  }
});

test("a watcher that ran a while restarts after the base backoff", async ($, on) => {
  const w = world(on, mock);
  await start($, w);
  await w.exit();
  await w.clock.advance(1_000);
  await w.idle(2);
  await w.exit();
  await w.clock.advance(2_000);
  await w.idle(3);
  // Up for two minutes, then it dies: the count starts over at 1 s.
  await w.clock.advance(2 * MINUTE);
  await w.exit();
  expect(w.statuses.at(-1)).toBe("crew-net: watcher stopped; restarting in 1s");
  await w.clock.advance(1_000);
  await w.idle(4);
  expect(w.spawns).toHaveLength(4);
});

test("items are acked through watch send, and a replay is acked again without a second delivery", async ($, on) => {
  const w = world(on, mock);
  await start($, w);
  await w.emit(ask("c-1"));
  expect(acks(w)).toEqual({ "c-1": "context" });
  expect(w.sendArgv[0]?.slice(2)).toEqual([
    "watch",
    "send",
    "--session",
    "session-1",
  ]);
  // The watcher restarted before the ack landed and replays the item.
  await w.emit(ask("c-1"));
  expect(w.sent.filter((e) => e.id === "c-1")).toHaveLength(2);
  const prompt = await userPrompt($, "go on");
  expect(prompt.context?.filter((c) => c.includes("users.tier"))).toHaveLength(
    1,
  );
});

test("events are read version-agnostic: a v field and unknown fields are ignored", async ($, on) => {
  const w = world(on, mock);
  await start($, w);
  await w.emit(
    ask("c-2", { v: 7, shiny: { new: true } }),
    line({ type: "status", text: "3 open PRs", v: 2 }),
    line({ type: "telemetry", data: 1 }),
    "not json",
  );
  expect(acks(w)).toEqual({ "c-2": "context" });
  expect(w.statuses.at(-1)).toBe("crew-net: 3 open PRs");
});

test("an error event shows in the band and the status", async ($, on) => {
  const w = world(on, mock);
  await start($, w);
  await w.emit(line({ type: "error", message: "rate-limited until 14:32" }));
  expect(w.statuses.at(-1)).toBe("crew-net: rate-limited until 14:32");
  for (const surface of SURFACES) {
    const ui = await mountBand($, w, surface);
    expect((await ui.find({ type: "Text", text: /rate-limited/ }))?.text).toBe(
      "crew-net · rate-limited until 14:32",
    );
    await ui.unmount();
  }
});

test("/clear: the next tick restarts the watcher for the new session id", async ($, on) => {
  const w = world(on, mock);
  await start($, w);
  await $.session.end({
    reason: "clear",
    sessionId: "session-1",
    resume: { id: "session-1" },
  });
  w.sessionId = "session-2";
  await w.exit();
  await w.clock.advance(MINUTE);
  await w.idle(w.spawns.length);
  const last = w.spawns.at(-1);
  expect(last?.argv.at(-1)).toBe("session-2");
  expect(JSON.parse(last?.input ?? "{}").session).toBe("session-2");
});

test("a moved session root restarts the watcher in the new worktree", async ($, on) => {
  const w = world(on, mock);
  await start($, w);
  w.root = "/w/omni";
  w.remote = "git@github.com:doiteng/omni.git";
  await w.exit();
  await w.clock.advance(MINUTE);
  await w.idle(w.spawns.length);
  const last = w.spawns.at(-1);
  expect(last?.cwd).toBe("/w/omni");
  expect(JSON.parse(last?.input ?? "{}")).toMatchObject({
    session: "session-1",
    worktree: "/w/omni",
    repo: "doiteng/omni",
  });
});

test("a non-interactive session starts no watcher", async ($, on) => {
  const w = world(on, mock);
  await $.session.start({
    cwd: ROOT,
    surface: "terminal",
    isInteractive: false,
  });
  expect(w.spawns).toHaveLength(0);
});
