import { describe, expect, test } from "bun:test";
import {
  parseStateBlock,
  renderStateBlock,
  replaceStateBlock,
  type StateBlock,
} from "./index";

const full: StateBlock = {
  lead: "alexei/atlas",
  state: "building",
  scope: ["api/openapi/", "tools/core/"],
  dependsOn: ["#2301", "doiteng/other#7"],
};

const render = (state: StateBlock): string => {
  const result = renderStateBlock(state);
  if (!result.ok)
    throw new Error(`render failed: ${JSON.stringify(result.error)}`);
  return result.block;
};

describe("round trip", () => {
  test.each<[string, StateBlock]>([
    ["every field", full],
    [
      "no scope, no depends-on",
      { lead: "maria/orion", state: "planning", scope: [], dependsOn: [] },
    ],
    [
      "single path",
      { lead: "maria/orion", state: "review", scope: ["src/"], dependsOn: [] },
    ],
    [
      "blocked with a dependency",
      { lead: "a/b", state: "blocked", scope: [], dependsOn: ["#1"] },
    ],
  ])("%s", (_name, state) => {
    expect(parseStateBlock(render(state))).toEqual({ ok: true, state });
  });

  test("renders the documented layout", () => {
    expect(render(full)).toBe(
      [
        "<!-- crew-net v1",
        "lead: alexei/atlas",
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
    expect(parseStateBlock(body)).toEqual({ ok: true, state: full });
  });

  test("ignores unknown fields and keeps them out of the model", () => {
    const body =
      "<!-- crew-net v1\nlead: a/b\nstate: review\nflavour: mint\nscope: x/\n-->";
    expect(parseStateBlock(body)).toEqual({
      ok: true,
      state: { lead: "a/b", state: "review", scope: ["x/"], dependsOn: [] },
    });
  });

  test("accepts a minor version suffix and mixed-case keys", () => {
    const body = "<!-- crew-net v1.3\nLead: a/b\nSTATE: planning\n-->";
    expect(parseStateBlock(body)).toEqual({
      ok: true,
      state: { lead: "a/b", state: "planning", scope: [], dependsOn: [] },
    });
  });

  test.each([
    "",
    "no block here",
    "<!-- some other comment -->",
    "<!-- crew-net -->",
  ])("returns null without a block: %j", (body) => {
    expect(parseStateBlock(body)).toBeNull();
  });

  test.each([2, 3, 10])(
    "reports unsupported version v%d without reading fields",
    (version) => {
      const body = `<!-- crew-net v${version}\nlead: a/b\nstate: review\nnew-required: yes\n-->`;
      expect(parseStateBlock(body)).toEqual({
        ok: false,
        reason: "unsupported-version",
        version,
      });
    },
  );

  test.each([
    ["missing lead", "<!-- crew-net v1\nstate: review\n-->"],
    ["missing state", "<!-- crew-net v1\nlead: a/b\n-->"],
    ["unknown state", "<!-- crew-net v1\nlead: a/b\nstate: dancing\n-->"],
    [
      "bad depends-on ref",
      "<!-- crew-net v1\nlead: a/b\nstate: review\ndepends-on: soon\n-->",
    ],
    ["version 0", "<!-- crew-net v0\nlead: a/b\nstate: review\n-->"],
  ])("returns malformed for %s", (_name, body) => {
    expect(parseStateBlock(body)).toMatchObject({
      ok: false,
      reason: "malformed",
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
    ["lead without a name", "lead", { ...full, lead: "alexei" }],
    ["lead with uppercase name", "lead", { ...full, lead: "alexei/Atlas" }],
    ["comma inside a path", "scope", { ...full, scope: ["a,b"] }],
    ["comment terminator in a path", "scope", { ...full, scope: ["a-->b"] }],
    ["newline in a path", "scope", { ...full, scope: ["a\nb"] }],
    ["bad ref", "depends-on", { ...full, dependsOn: ["2301"] }],
    [
      "unknown state",
      "state",
      { ...full, state: "done" as StateBlock["state"] },
    ],
  ])("refuses an invalid field: %s", (_name, field, state) => {
    expect(renderStateBlock(state)).toMatchObject({
      ok: false,
      error: { reason: "invalid", field },
    });
  });
});

describe("replaceStateBlock", () => {
  const next: StateBlock = { ...full, state: "review", dependsOn: [] };

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

  test.each([
    ["empty body", "", `${render(next)}\n`],
    ["body without trailing newline", "text", `text\n\n${render(next)}\n`],
    ["body with trailing newline", "text\n", `text\n\n${render(next)}\n`],
  ])("appends a block when there is none: %s", (_name, body, expected) => {
    expect(replaceStateBlock(body, next)).toEqual({ ok: true, body: expected });
  });

  test("overwrites a malformed block", () => {
    const result = replaceStateBlock(
      "a\n<!-- crew-net v1\nlead: ???\n-->\nb",
      next,
    );
    expect(result).toEqual({ ok: true, body: `a\n${render(next)}\nb` });
  });

  test("refuses to write over a higher major version", () => {
    const body = "<!-- crew-net v2\nlead: a/b\n-->";
    expect(replaceStateBlock(body, next)).toEqual({
      ok: false,
      error: { reason: "unsupported-version", version: 2 },
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
