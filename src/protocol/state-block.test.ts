import { describe, expect, test } from "bun:test";
import {
  type ParseStateBlockResult,
  type PrState,
  parseStateBlock,
  renderStateBlock,
  replaceStateBlock,
  type StateBlock,
  type StateBlockWarning,
} from "./index";

const full: StateBlock = {
  state: "building",
  scope: ["api/openapi/", "tools/core/"],
  dependsOn: ["#2301", "doiteng/other#7"],
  extra: [],
};

const render = (state: StateBlock): string => {
  const result = renderStateBlock(state);
  if (!result.ok)
    throw new Error(`render failed: ${JSON.stringify(result.error)}`);
  return result.block;
};

const ok = (
  state: StateBlock,
  warnings: StateBlockWarning[] = [],
): ParseStateBlockResult => ({
  ok: true,
  state,
  warnings,
});

describe("round trip", () => {
  test.each<[string, StateBlock]>([
    ["every field", full],
    [
      "no scope, no depends-on",
      { state: "planning", scope: [], dependsOn: [], extra: [] },
    ],
    [
      "single path",
      { state: "review", scope: ["src/"], dependsOn: [], extra: [] },
    ],
    [
      "blocked with a dependency",
      { state: "blocked", scope: [], dependsOn: ["#1"], extra: [] },
    ],
    ["no state yet", { scope: ["a/"], dependsOn: [], extra: [] }],
    [
      "unknown fields",
      {
        ...full,
        extra: [
          { key: "flavour", value: "mint" },
          { key: "owner-note", value: "see: thread" },
        ],
      },
    ],
  ])("%s", (_name, state) => {
    expect(parseStateBlock(render(state))).toEqual(ok(state));
  });

  test("renders the documented layout, without a version", () => {
    expect(render(full)).toBe(
      [
        "<!-- crew-net",
        "state: building",
        "scope: api/openapi/, tools/core/",
        "depends-on: #2301, doiteng/other#7",
        "-->",
      ].join("\n"),
    );
  });
});

describe("parseStateBlock", () => {
  test("reads the block from inside a longer body", () => {
    const body = `## Summary\nText.\n\n${render(full)}\n\nRefs #12\n`;
    expect(parseStateBlock(body)).toEqual(ok(full));
  });

  test("keeps unknown fields in document order", () => {
    const body = "<!-- crew-net\nzeta: 1\nstate: review\nalpha: two words\n-->";
    expect(parseStateBlock(body)).toEqual(
      ok({
        state: "review",
        scope: [],
        dependsOn: [],
        extra: [
          { key: "zeta", value: "1" },
          { key: "alpha", value: "two words" },
        ],
      }),
    );
  });

  test("is tolerant of case, spacing, CRLF and a block on one line", () => {
    const expected = ok({
      state: "planning",
      scope: ["a/"],
      dependsOn: ["#3"],
      extra: [],
    });
    expect(
      parseStateBlock(
        "<!--crew-net\r\nSTATE: planning\r\nScope: a/\r\ndepends-on:#3\r\n-->",
      ),
    ).toEqual(expected);
    expect(parseStateBlock("<!-- crew-net state: planning -->")).toEqual(
      ok({ state: "planning", scope: [], dependsOn: [], extra: [] }),
    );
  });

  describe("old format", () => {
    test("v1 block with lead parses; lead is ignored and not kept", () => {
      const body =
        "<!-- crew-net v1\nlead: alexei/atlas\nstate: building\nscope: api/\ndepends-on: #4\n-->";
      expect(parseStateBlock(body)).toEqual(
        ok({
          state: "building",
          scope: ["api/"],
          dependsOn: ["#4"],
          extra: [],
        }),
      );
    });

    test.each([
      "<!-- crew-net v1.3\nLead: a/b\nSTATE: planning\n-->",
      "<!-- crew-net v2\nlead: a/b\nstate: planning\n-->",
      "<!-- crew-net v0\nstate: planning\n-->",
    ])("any version tag is read, not rejected: %j", (body) => {
      expect(parseStateBlock(body)).toEqual(
        ok({ state: "planning", scope: [], dependsOn: [], extra: [] }),
      );
    });

    test("old and new format give the same model", () => {
      const fields = "state: review\nscope: a/, b/\ndepends-on: #1, o/r#2";
      expect(
        parseStateBlock(`<!-- crew-net v1\nlead: x/y\n${fields}\n-->`),
      ).toEqual(parseStateBlock(`<!-- crew-net\n${fields}\n-->`));
    });
  });

  // The order gate reads null as "no dependencies". A block in either format
  // must never come back as null, or a dependency is silently skipped.
  test.each([
    ["new, full", render(full)],
    ["new, empty", "<!-- crew-net\n-->"],
    ["new, one line", "<!-- crew-net -->"],
    ["new, no space", "<!--crew-net\nstate: review\n-->"],
    [
      "old v1, full",
      "<!-- crew-net v1\nlead: a/b\nstate: review\ndepends-on: #1\n-->",
    ],
    ["old v1, missing lead", "<!-- crew-net v1\nstate: review\n-->"],
    ["old v1, no fields", "<!-- crew-net v1 -->"],
    ["unterminated", "<!-- crew-net\nstate: review\ndepends-on: #1"],
    ["unterminated, old", "<!-- crew-net v1\nlead: a/b\ndepends-on: #1"],
  ])("a block never parses as null: %s", (_name, block) => {
    for (const body of [block, `intro\n\n${block}\n\ntail`])
      expect(parseStateBlock(body)).not.toBeNull();
  });

  test("an unterminated block is malformed, not absent", () => {
    expect(parseStateBlock("<!-- crew-net\nstate: review")).toEqual({
      ok: false,
      reason: "malformed",
      detail: "unterminated block",
    });
  });

  test.each([
    "",
    "no block here",
    "<!-- some other comment -->",
    "<!-- crew-network -->",
    "<!-- crew-netx\nstate: review\n-->",
  ])("returns null without a block: %j", (body) => {
    expect(parseStateBlock(body)).toBeNull();
  });

  test.each([
    "<!-- crew-net:msg kind=ask id=k3f9 -->",
    "<!-- crew-net:msg kind=reply re=k3f9 status=done -->\n\n@a thanks",
  ])("does not mistake a message marker for a state block: %j", (body) => {
    expect(parseStateBlock(body)).toBeNull();
  });

  test("a marker before the block does not hide it", () => {
    const body = `<!-- crew-net:msg kind=info -->\n${render(full)}`;
    expect(parseStateBlock(body)).toEqual(ok(full));
  });

  describe("depends-on that cannot be read as written", () => {
    // Each of these once read as "no dependency", which the gate allows.
    test.each([
      ["same line as state", "<!-- crew-net state: review depends-on: #2 -->"],
      ["same line as scope", "<!-- crew-net scope: a/ depends-on: #2 -->"],
      [
        "old format on one line",
        "<!-- crew-net v1 lead: a/b state: review depends-on: #2 -->",
      ],
      [
        "empty first, real second",
        "<!-- crew-net\ndepends-on:\ndepends-on: #2\n-->",
      ],
      ["markdown bullet", "<!-- crew-net\n- depends-on: #2\n-->"],
      ["underscore spelling", "<!-- crew-net\ndepends_on: #2\n-->"],
      [
        "upper case, repeated",
        "<!-- crew-net\ndepends-on: #1\nDepends-On: #2\n-->",
      ],
    ])("warns: %s", (_name, body) => {
      const result = parseStateBlock(body);
      expect(result).toMatchObject({ ok: true });
      if (!result?.ok) return;
      expect(result.warnings.map((w) => w.field)).toContain("depends-on");
    });

    test("a clean depends-on line gives no such warning", () => {
      const result = parseStateBlock(
        "<!-- crew-net\nstate: review\ndepends-on: #2\n-->",
      );
      expect(result).toMatchObject({ ok: true, warnings: [] });
    });
  });

  describe("block boundaries", () => {
    test.each([
      [
        "prose mention before the real block",
        "Switches to the unversioned `<!-- crew-net -->` block.\n\n<!-- crew-net\ndepends-on: #2\n-->",
        "more than one state block",
      ],
      [
        "prose mention after the real block",
        "<!-- crew-net\ndepends-on: #2\n-->\n\nAbout `<!-- crew-net -->`.",
        "more than one state block",
      ],
      [
        "unclosed prose mention before the real block",
        "Uses <!-- crew-net comments.\n\n<!-- crew-net\nstate: building\n-->",
        "comment inside the block",
      ],
      [
        "two real blocks",
        `${render(full)}\n${render(full)}`,
        "more than one state block",
      ],
    ])("%s is malformed, not absent or partial", (_name, body, detail) => {
      expect(parseStateBlock(body)).toEqual({
        ok: false,
        reason: "malformed",
        detail,
      });
    });

    test("replace refuses to eat text between an unclosed mention and the block", () => {
      const body =
        "Uses <!-- crew-net comments.\n\nDetails here.\n\n<!-- crew-net\nstate: building\n-->";
      expect(replaceStateBlock(body, { ...full, dependsOn: [] })).toMatchObject(
        {
          ok: false,
          error: { reason: "unreadable-block" },
        },
      );
    });

    test.each([
      "<!-- Crew-Net v1\nlead: a/b\nstate: review\ndepends-on: #2\n-->",
      "<!--\ncrew-net\ndepends-on: #2\n-->",
      "<!-- CREW-NET\ndepends-on: #2\n-->",
    ])("other spellings of the opening still read: %j", (body) => {
      expect(parseStateBlock(body)).toMatchObject({
        ok: true,
        state: { dependsOn: ["#2"] },
      });
    });
  });

  describe("per-field tolerance", () => {
    test("unknown state is skipped with a warning; other fields survive", () => {
      const body =
        "<!-- crew-net\nstate: dancing\nscope: a/\ndepends-on: #2\n-->";
      expect(parseStateBlock(body)).toEqual(
        ok({ scope: ["a/"], dependsOn: ["#2"], extra: [] }, [
          { field: "state", value: "dancing", detail: "unknown state" },
        ]),
      );
    });

    test("one bad ref is skipped with a warning; good refs survive", () => {
      const body =
        "<!-- crew-net\nstate: review\ndepends-on: #1, soon, o/r#3\n-->";
      expect(parseStateBlock(body)).toEqual(
        ok(
          { state: "review", scope: [], dependsOn: ["#1", "o/r#3"], extra: [] },
          [{ field: "depends-on", value: "soon", detail: "bad ref" }],
        ),
      );
    });

    test("old block with a bad state still gives its dependencies", () => {
      const body =
        "<!-- crew-net v1\nlead: a/b\nstate: dancing\ndepends-on: #9\n-->";
      const result = parseStateBlock(body);
      expect(result).toMatchObject({ ok: true, state: { dependsOn: ["#9"] } });
    });
  });
});

describe("renderStateBlock", () => {
  test.each<[string, StateBlock]>([
    ["keyword in scope", { ...full, scope: ["closes #5"] }],
    [
      "keyword url in scope",
      { ...full, scope: ["fixes https://github.com/o/r/issues/5"] },
    ],
    [
      "keyword in an unknown field",
      { ...full, extra: [{ key: "note", value: "resolves #8" }] },
    ],
  ])("refuses a closing keyword: %s", (_name, state) => {
    expect(renderStateBlock(state)).toMatchObject({
      ok: false,
      error: {
        reason: "closing-keyword",
        matches: [{ keyword: expect.any(String) }],
      },
    });
  });

  test.each<[string, string, StateBlock]>([
    ["comma inside a path", "scope", { ...full, scope: ["a,b"] }],
    ["comment terminator in a path", "scope", { ...full, scope: ["a-->b"] }],
    ["newline in a path", "scope", { ...full, scope: ["a\nb"] }],
    ["bad ref", "depends-on", { ...full, dependsOn: ["2301"] }],
    ["unknown state", "state", { ...full, state: "done" as PrState }],
    [
      "extra with a known key",
      "extra:state",
      { ...full, extra: [{ key: "state", value: "x" }] },
    ],
    [
      "extra with a bad key",
      "extra:bad key",
      { ...full, extra: [{ key: "bad key", value: "x" }] },
    ],
    [
      "extra that closes the comment",
      "extra:note",
      { ...full, extra: [{ key: "note", value: "a --> b" }] },
    ],
  ])("refuses an invalid field: %s", (_name, field, state) => {
    expect(renderStateBlock(state)).toMatchObject({
      ok: false,
      error: { reason: "invalid", field },
    });
  });
});

describe("replaceStateBlock", () => {
  const next = { ...full, state: "review" as const, dependsOn: [] };

  test("replaces the block in place and leaves other text untouched", () => {
    const before = "Intro $& text\n\n";
    const after = "\n\nTail with $1 and <!-- other -->\n";
    const result = replaceStateBlock(`${before}${render(full)}${after}`, next);
    expect(result).toEqual({
      ok: true,
      body: `${before}${render(next)}${after}`,
    });
  });

  test("is idempotent", () => {
    const once = replaceStateBlock(`text\n\n${render(full)}\n`, next);
    if (!once.ok) throw new Error("replace failed");
    expect(replaceStateBlock(once.body, next)).toEqual(once);
  });

  test("writes the unversioned form over an old v1 block and drops lead", () => {
    const old =
      "<!-- crew-net v1\nlead: a/b\nstate: building\ndepends-on: #1\n-->";
    expect(replaceStateBlock(`top\n${old}\nend`, next)).toEqual({
      ok: true,
      body: `top\n${render(next)}\nend`,
    });
  });

  test("keeps unknown fields of the existing block", () => {
    const old =
      "<!-- crew-net v1\nlead: a/b\nstate: building\nflavour: mint\nreviewer: maria\n-->";
    const result = replaceStateBlock(old, { ...next, scope: [] });
    expect(result).toEqual({
      ok: true,
      body: [
        "<!-- crew-net",
        "state: review",
        "flavour: mint",
        "reviewer: maria",
        "-->",
      ].join("\n"),
    });
  });

  test("a block read from a peer is written back without losing fields", () => {
    const peer =
      "x\n<!-- crew-net\nstate: building\nscope: a/\nfuture-field: 42\n-->\ny";
    const read = parseStateBlock(peer);
    if (!read?.ok) throw new Error("parse failed");
    const result = replaceStateBlock(peer, { ...read.state, state: "review" });
    expect(result).toEqual({
      ok: true,
      body: "x\n<!-- crew-net\nstate: review\nscope: a/\nfuture-field: 42\n-->\ny",
    });
  });

  test.each([
    ["empty body", "", `${render(next)}\n`],
    ["body without trailing newline", "text", `text\n\n${render(next)}\n`],
    ["body with trailing newline", "text\n", `text\n\n${render(next)}\n`],
  ])("appends a block when there is none: %s", (_name, body, expected) => {
    expect(replaceStateBlock(body, next)).toEqual({ ok: true, body: expected });
  });

  test("a message marker is not a block to replace", () => {
    const body = "<!-- crew-net:msg kind=info -->";
    expect(replaceStateBlock(body, next)).toEqual({
      ok: true,
      body: `${body}\n\n${render(next)}\n`,
    });
  });

  test("refuses to write over a block that never closes", () => {
    const body =
      "<!-- crew-net\nstate: review\n\nlong text that would be eaten";
    expect(replaceStateBlock(body, next)).toEqual({
      ok: false,
      error: { reason: "unreadable-block", detail: "unterminated block" },
    });
  });

  test("passes through render refusals", () => {
    expect(
      replaceStateBlock("text", { ...next, scope: ["fixes #1"] }),
    ).toMatchObject({
      ok: false,
      error: { reason: "closing-keyword" },
    });
  });
});
