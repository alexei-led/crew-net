import { describe, expect, test } from "bun:test";
import {
  type MessageMarker,
  mentionLine,
  parseMessageMarker,
  renderMessageMarker,
} from "./index";

const marker = (m: MessageMarker): string => {
  const result = renderMessageMarker(m);
  if (!result.ok) throw new Error(`render failed: ${JSON.stringify(result)}`);
  return result.marker;
};

describe("marker round trip", () => {
  test.each<[string, MessageMarker, string]>([
    [
      "ask",
      { kind: "ask", id: "k3f9" },
      "<!-- crew-net:msg kind=ask id=k3f9 -->",
    ],
    [
      "reply",
      { kind: "reply", re: "k3f9", status: "answered" },
      "<!-- crew-net:msg kind=reply re=k3f9 status=answered -->",
    ],
    [
      "reply without a status",
      { kind: "reply", re: "k3f9" },
      "<!-- crew-net:msg kind=reply re=k3f9 -->",
    ],
    [
      "reply that is also a new request",
      { kind: "reply", id: "zz99", re: "k3f9", status: "accepted" },
      "<!-- crew-net:msg kind=reply id=zz99 re=k3f9 status=accepted -->",
    ],
    [
      "review",
      { kind: "review", id: "abcd" },
      "<!-- crew-net:msg kind=review id=abcd -->",
    ],
    [
      "fix",
      { kind: "fix", id: "abcd" },
      "<!-- crew-net:msg kind=fix id=abcd -->",
    ],
    ...(["declined", "done"] as const).map(
      (status): [string, MessageMarker, string] => [
        `reply ${status}`,
        { kind: "reply", re: "k3f9", status },
        `<!-- crew-net:msg kind=reply re=k3f9 status=${status} -->`,
      ],
    ),
    ["info without an id", { kind: "info" }, "<!-- crew-net:msg kind=info -->"],
    [
      "longest id",
      { kind: "bug", id: "abcdefgh1234" },
      "<!-- crew-net:msg kind=bug id=abcdefgh1234 -->",
    ],
  ])("%s", (_name, value, text) => {
    expect(marker(value)).toBe(text);
    expect(parseMessageMarker(text)).toEqual({ ok: true, marker: value });
  });
});

describe("parseMessageMarker", () => {
  test("reads the marker from the front of a full comment", () => {
    const body =
      "<!-- crew-net:msg kind=ask id=k3f9 -->\n\n@maria does #2310 need the column?";
    expect(parseMessageMarker(body)).toEqual({
      ok: true,
      marker: { kind: "ask", id: "k3f9" },
    });
  });

  test("tolerates unknown keys, extra spaces, any key order and newlines", () => {
    expect(
      parseMessageMarker(
        "<!--  crew-net:msg   future=1  id=k3f9\n  kind=ask   other=x -->",
      ),
    ).toEqual({ ok: true, marker: { kind: "ask", id: "k3f9" } });
  });

  test("first occurrence of a key wins", () => {
    expect(
      parseMessageMarker("<!-- crew-net:msg kind=ask kind=fix id=k3f9 -->"),
    ).toEqual({ ok: true, marker: { kind: "ask", id: "k3f9" } });
  });

  test("a status on a request is dropped", () => {
    expect(
      parseMessageMarker("<!-- crew-net:msg kind=ask id=k3f9 status=done -->"),
    ).toEqual({ ok: true, marker: { kind: "ask", id: "k3f9" } });
  });

  test.each([
    "",
    "@maria plain comment",
    "<!-- some other comment -->",
    "<!-- crew-net\nstate: review\n-->",
    "<!-- crew-net:msgs kind=ask id=k3f9 -->",
    "<!-- crew-net:message kind=ask id=k3f9 -->",
    "> <!-- crew-net:msg kind=ask id=k3f9 -->",
    "<!-- crew-net:msg kind=ask id=k3f9",
    "@maria quoting:\n<!-- crew-net:msg kind=ask id=k3f9 -->",
  ])("returns null for a comment without a marker: %j", (body) => {
    expect(parseMessageMarker(body)).toBeNull();
  });

  test.each([
    ["unknown kind", "<!-- crew-net:msg kind=shout id=k3f9 -->"],
    ["kind with other case", "<!-- crew-net:msg kind=Ask id=k3f9 -->"],
    ["missing kind", "<!-- crew-net:msg id=k3f9 -->"],
    ["empty marker", "<!-- crew-net:msg -->"],
    ["id too short", "<!-- crew-net:msg kind=ask id=abc -->"],
    ["id too long", "<!-- crew-net:msg kind=ask id=abcdefgh12345 -->"],
    ["id with upper case", "<!-- crew-net:msg kind=ask id=K3F9 -->"],
    ["id with a dash", "<!-- crew-net:msg kind=ask id=k3-f9 -->"],
    ["bad re", "<!-- crew-net:msg kind=reply re=!! status=done -->"],
    ["unknown status", "<!-- crew-net:msg kind=reply re=k3f9 status=maybe -->"],
    ["request without an id", "<!-- crew-net:msg kind=review -->"],
    ["reply without re", "<!-- crew-net:msg kind=reply status=done -->"],
  ])("a marker with %s is malformed", (_name, body) => {
    expect(parseMessageMarker(body)).toMatchObject({
      ok: false,
      reason: "malformed",
    });
  });
});

describe("renderMessageMarker", () => {
  test.each<[string, string, MessageMarker]>([
    ["unknown kind", "kind", { kind: "shout" as MessageMarker["kind"] }],
    ["bad id", "id", { kind: "ask", id: "AB" }],
    ["bad re", "re", { kind: "reply", re: "no way" }],
    [
      "unknown status",
      "status",
      { kind: "reply", re: "abcd", status: "later" as "done" },
    ],
    [
      "status on a request",
      "status",
      { kind: "ask", id: "abcd", status: "done" },
    ],
    ["request without id", "id", { kind: "fix" }],
    ["reply without re", "re", { kind: "reply" }],
    ["id that would end the comment", "id", { kind: "ask", id: "a-->b" }],
  ])("refuses %s", (_name, field, value) => {
    expect(renderMessageMarker(value)).toMatchObject({ ok: false, field });
  });
});

describe("mentionLine", () => {
  test.each([
    [
      "maria",
      "does #2310 need the column?",
      "@maria does #2310 need the column?",
    ],
    ["Maria-Dev", "  trimmed  ", "@Maria-Dev trimmed"],
    ["a", "x", "@a x"],
    ["a".repeat(39), "ok", `@${"a".repeat(39)} ok`],
  ])("@%s", (login, text, expected) => {
    expect(mentionLine(login, text)).toBe(expected);
  });

  test.each([
    ["", "text"],
    ["-maria", "text"],
    ["ma ria", "text"],
    ["maria/orion", "text"],
    ["@maria", "text"],
    ["a".repeat(40), "text"],
    ["maria", ""],
    ["maria", "   "],
  ])("refuses login %j with text %j", (login, text) => {
    expect(mentionLine(login, text)).toBeNull();
  });
});
