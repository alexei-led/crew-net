import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type CrewEvent, decodeEvent, encodeEvent } from "./index";

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
      new Set([
        "ready",
        "item",
        "status",
        "error",
        "hello",
        "ack",
        "post",
        "bye",
      ]),
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

describe("decodeEvent", () => {
  test("ignores unknown fields", () => {
    const line =
      '{"v":1,"type":"ack","id":"x","outcome":"wake","future":[1,2]}';
    expect(decodeEvent(line)).toMatchObject({
      ok: true,
      event: { type: "ack", id: "x" },
    });
  });

  test("accepts an item without a sender", () => {
    const line =
      '{"v":1,"type":"item","id":"1","kind":"digest","text":"t","addressed":false}';
    expect(decodeEvent(line)).toMatchObject({ ok: true });
  });

  test.each([2, 7])("reports unknown version %d", (v) => {
    expect(decodeEvent(`{"v":${v},"type":"somethingnew","x":1}`)).toEqual({
      ok: false,
      reason: "unknown-version",
      version: v,
    });
  });

  test.each([
    ["empty line", ""],
    ["not JSON", "ready"],
    ["truncated JSON", '{"v":1,"type":"rea'],
    ["array", "[]"],
    ["null", "null"],
    ["number", "1"],
    ["missing v", '{"type":"ready"}'],
    ["string v", '{"v":"1","type":"ready"}'],
    ["fractional v", '{"v":1.5,"type":"ready"}'],
    ["missing type", '{"v":1}'],
    ["unknown type", '{"v":1,"type":"teleport"}'],
    ["inherited type name", '{"v":1,"type":"constructor"}'],
    [
      "item with unknown kind",
      '{"v":1,"type":"item","id":"1","kind":"rumour","text":"t","addressed":true}',
    ],
    [
      "item without id",
      '{"v":1,"type":"item","kind":"message","text":"t","addressed":true}',
    ],
    [
      "item with non-string sender",
      '{"v":1,"type":"item","id":"1","kind":"message","text":"t","addressed":true,"from":3}',
    ],
    [
      "ack with unknown outcome",
      '{"v":1,"type":"ack","id":"1","outcome":"maybe"}',
    ],
    [
      "hello with string pid",
      '{"v":1,"type":"hello","lead":"a","claudePid":"1","cwd":"/","settings":{"autoWake":true}}',
    ],
    [
      "hello without settings",
      '{"v":1,"type":"hello","lead":"a","claudePid":1,"cwd":"/"}',
    ],
    [
      "hello with bad settings",
      '{"v":1,"type":"hello","lead":"a","claudePid":1,"cwd":"/","settings":{"autoWake":"yes"}}',
    ],
    ["post without body", '{"v":1,"type":"post","id":"1","to":"maria"}'],
  ])("returns malformed for %s", (_name, line) => {
    expect(decodeEvent(line)).toMatchObject({ ok: false, reason: "malformed" });
  });
});

describe("encodeEvent", () => {
  test("starts every line with v and type", () => {
    const event: CrewEvent = { v: 1, type: "bye" };
    expect(encodeEvent(event)).toBe('{"v":1,"type":"bye"}');
  });
});
