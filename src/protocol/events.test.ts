import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeEvent, encodeEvent } from "./index";

const FIXTURES = join(import.meta.dir, "fixtures", "events");
const fixtures = readdirSync(FIXTURES)
  .filter((file) => file.endsWith(".json"))
  .map(
    (file) =>
      [
        file,
        JSON.stringify(JSON.parse(readFileSync(join(FIXTURES, file), "utf8"))),
      ] as const,
  );

describe("event fixtures", () => {
  test("cover every event type and item kind", () => {
    const events = fixtures.map(([, line]) => JSON.parse(line));
    expect(new Set(events.map((e) => e.type))).toEqual(
      new Set(["ready", "item", "status", "error", "hello", "ack", "bye"]),
    );
    expect(
      new Set(events.filter((e) => e.type === "item").map((e) => e.kind)),
    ).toEqual(new Set(["message", "finding", "digest"]));
  });

  test.each(fixtures)(
    "%s decodes and re-encodes to the same JSON",
    (_file, line) => {
      const result = decodeEvent(line);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(JSON.parse(encodeEvent(result.event))).toEqual(JSON.parse(line));
      expect(encodeEvent(result.event)).not.toContain("\n");
    },
  );
});

const HELLO = (overrides: Record<string, unknown>): string =>
  JSON.stringify({
    type: "hello",
    session: "s1",
    role: "lead",
    harness: "claude-code",
    worktree: "/w",
    pid: 1,
    settings: { autoWake: true },
    ...overrides,
  });

describe("decodeEvent", () => {
  test("ignores unknown fields", () => {
    const line = '{"type":"ack","id":"x","outcome":"wake","future":[1,2]}';
    expect(decodeEvent(line)).toMatchObject({
      ok: true,
      event: { type: "ack", id: "x" },
    });
  });

  test.each([
    [
      "without a sender",
      '{"type":"item","id":"1","kind":"digest","text":"t","addressed":false}',
      {},
    ],
    [
      "with repo, thread and event",
      '{"type":"item","id":"1","kind":"message","text":"t","addressed":true,"repo":"o/r","thread":7,"event":"ask","wakeable":true,"msgId":"k3f9"}',
      {
        repo: "o/r",
        thread: 7,
        event: "ask",
        wakeable: true,
        msgId: "k3f9",
      },
    ],
  ])("accepts an item %s", (_name, line, fields) => {
    expect(decodeEvent(line)).toMatchObject({
      ok: true,
      event: { type: "item", ...fields },
    });
  });

  test("does not reject on a v field", () => {
    for (const v of [1, 2, "7"]) {
      const line = JSON.stringify({ v, type: "ack", id: "x", outcome: "band" });
      expect(decodeEvent(line)).toMatchObject({ ok: true });
    }
  });

  test("a hello accepts extra fields", () => {
    expect(
      decodeEvent(
        HELLO({ role: "worker", harness: "pi", repo: "o/r", branch: "b" }),
      ),
    ).toMatchObject({
      ok: true,
      event: { type: "hello", role: "worker", harness: "pi" },
    });
  });

  test.each([
    ["empty line", ""],
    ["not JSON", "ready"],
    ["truncated JSON", '{"type":"rea'],
    ["array", "[]"],
    ["null", "null"],
    ["number", "1"],
    ["missing type", "{}"],
    ["unknown type", '{"type":"teleport"}'],
    ["inherited type name", '{"type":"constructor"}'],
    ["post (removed type)", '{"type":"post","id":"1","to":"maria","body":"x"}'],
    [
      "item with unknown kind",
      '{"type":"item","id":"1","kind":"rumour","text":"t","addressed":true}',
    ],
    [
      "item without id",
      '{"type":"item","kind":"message","text":"t","addressed":true}',
    ],
    [
      "item with non-string sender",
      '{"type":"item","id":"1","kind":"message","text":"t","addressed":true,"from":3}',
    ],
    [
      "item with non-string repo",
      '{"type":"item","id":"1","kind":"message","text":"t","addressed":true,"repo":3}',
    ],
    [
      "item with non-string event",
      '{"type":"item","id":"1","kind":"message","text":"t","addressed":true,"event":3}',
    ],
    [
      "item with string ownPr",
      '{"type":"item","id":"1","kind":"message","text":"t","addressed":true,"ownPr":1}',
    ],
    [
      "item with string wakeable",
      '{"type":"item","id":"1","kind":"message","text":"t","addressed":true,"wakeable":"yes"}',
    ],
    [
      "item with fractional thread",
      '{"type":"item","id":"1","kind":"message","text":"t","addressed":true,"thread":1.5}',
    ],
    [
      "item with non-string msgId",
      '{"type":"item","id":"1","kind":"message","text":"t","addressed":true,"msgId":7}',
    ],
    ["ack with unknown outcome", '{"type":"ack","id":"1","outcome":"maybe"}'],
    ["hello with string pid", HELLO({ pid: "1" })],
    ["hello without a session", HELLO({ session: undefined })],
    ["hello with unknown role", HELLO({ role: "boss" })],
    ["hello without harness", HELLO({ harness: undefined })],
    ["hello without worktree", HELLO({ worktree: undefined })],
    ["hello with non-string repo", HELLO({ repo: 3 })],
    ["hello with non-string branch", HELLO({ branch: false })],
    ["hello without settings", HELLO({ settings: undefined })],
    ["hello with bad settings", HELLO({ settings: { autoWake: "yes" } })],
  ])("returns malformed for %s", (_name, line) => {
    expect(decodeEvent(line)).toMatchObject({ ok: false, reason: "malformed" });
  });
});
