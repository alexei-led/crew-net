import { describe, expect, test } from "bun:test";
import { parseStateBlock } from "../../../protocol/index";
import { BRANCH, harness, pull, REPO, refusal } from "./fixtures/fakes";
import {
  type CommandError,
  dep,
  renderState,
  type StateArgs,
  state,
} from "./index";

const BLOCK = `Adds users.tier.

<!-- crew-net
state: building
scope: api/
depends-on: #5
owner-note: keep me
-->
`;

/** My PR #10 on the current branch with `body`, and dependency candidates. */
function mine(body = "", over: Parameters<typeof pull>[1] = {}) {
  const h = harness();
  h.github
    .add(REPO, pull(10, { headRef: BRANCH, body, ...over }))
    .add(REPO, pull(5))
    .add(REPO, pull(6))
    .add(REPO, pull(7, { state: "closed", merged: true }))
    .add(REPO, pull(8, { state: "closed", merged: false }))
    .add("acme/omni", pull(88, { author: "maria" }))
    .add(REPO, pull(20, { author: "maria", headRef: "maria-x" }));
  return h;
}

const block = (h: ReturnType<typeof harness>, n = 10) => {
  const parsed = parseStateBlock(h.github.body(REPO, n));
  if (!parsed?.ok) throw new Error("no readable block");
  return parsed.state;
};

describe("state (design §7.1)", () => {
  test("appends a block to a PR without one", async () => {
    const h = mine("Adds users.tier.");
    const result = await state(h.ctx, { state: "building", scope: ["api/"] });
    expect(h.github.body(REPO, 10)).toBe(
      "Adds users.tier.\n\n<!-- crew-net\nstate: building\nscope: api/\n-->\n",
    );
    expect(result).toEqual({
      repo: REPO,
      number: 10,
      changed: true,
      state: "building",
      scope: ["api/"],
      dependsOn: [],
      autoMergeDisabled: false,
    });
  });

  test("keeps scope, dependencies and unknown fields; replaces the state", async () => {
    const h = mine(BLOCK);
    await state(h.ctx, { state: "review" });
    expect(block(h)).toEqual({
      state: "review",
      scope: ["api/"],
      dependsOn: ["#5"],
      extra: [{ key: "owner-note", value: "keep me" }],
    });
    expect(h.github.body(REPO, 10)).toStartWith(
      "Adds users.tier.\n\n<!-- crew-net",
    );
  });

  test("--scope replaces the scope", async () => {
    const h = mine(BLOCK);
    await state(h.ctx, { state: "building", scope: ["web/", " tools/ "] });
    expect(block(h).scope).toEqual(["web/", "tools/"]);
  });

  test.each([
    ["the same fields", BLOCK, { state: "building" }],
    [
      "the old v1 form with the same fields",
      "<!-- crew-net v1\nlead: alexei/a\nstate: review\n-->",
      { state: "review" },
    ],
  ])("writes nothing for %s", async (_n, body, args) => {
    const h = mine(body);
    const result = await state(h.ctx, args);
    expect(result.changed).toBe(false);
    expect(h.github.writes).toEqual([]);
  });

  test.each<[string, StateArgs, CommandError["code"]]>([
    ["an unknown state", { state: "done" }, "usage"],
    [
      "a closing keyword in the scope",
      { state: "building", scope: ["fixes #3"] },
      "closing-keyword",
    ],
    ["a comma in a path", { state: "building", scope: ["a,b"] }, "usage"],
    ["someone else's PR", { state: "review", pr: "#20" }, "refused"],
    ["a closed PR of mine", { state: "review", pr: "#7" }, "refused"],
    ["a missing PR", { state: "review", pr: "#404" }, "not-found"],
    [
      "a URL on another host, not read as this host",
      { state: "review", pr: "https://ghe.corp/acme/app/pull/10" },
      "usage",
    ],
  ])("refuses %s", async (_n, args, code) => {
    const h = mine();
    const error = await refusal(state(h.ctx, args));
    expect(error.code).toBe(code);
    expect(h.github.writes).toEqual([]);
  });

  test.each([
    ["unterminated", "<!-- crew-net\nstate: review\n", /unreadable/],
    ["repeated", "<!-- crew-net\n-->\n<!-- crew-net\n-->", /unreadable/],
    [
      "with an unknown state value, rather than dropping it",
      "<!-- crew-net\nstate: done\n-->",
      /state has an unreadable entry "done"/,
    ],
    [
      "with a bad depends-on entry",
      "<!-- crew-net\ndepends-on: #5, nonsense\n-->",
      /depends-on has an unreadable entry "nonsense"/,
    ],
  ])("refuses to rewrite a block %s", async (_n, body, msg) => {
    const h = mine(body);
    const error = await refusal(state(h.ctx, { state: "review" }));
    expect([error.code, error.message]).toEqual([
      "refused",
      expect.stringMatching(msg),
    ]);
    expect(h.github.writes).toEqual([]);
  });

  test("without a PR on the current branch names the fix", async () => {
    const h = harness();
    const error = await refusal(state(h.ctx, { state: "review" }));
    expect([error.code, error.message]).toEqual([
      "not-found",
      expect.stringMatching(/--pr #N/),
    ]);
  });

  test("--pr targets another PR of mine", async () => {
    const h = mine();
    await state(h.ctx, { state: "blocked", pr: "#6" });
    expect(block(h, 6).state).toBe("blocked");
  });
});

describe("dep (design §11)", () => {
  test.each([
    ["#6", "#6"],
    ["acme/app#6", "#6"],
    ["https://github.com/acme/app/pull/6", "#6"],
    ["acme/omni#88", "acme/omni#88"],
    ["#7", "#7"],
  ])("add %s writes depends-on %s", async (ref, written) => {
    const h = mine(BLOCK);
    const result = await dep(h.ctx, { action: "add", ref });
    expect(block(h).dependsOn).toEqual(["#5", written]);
    expect(result.changed).toBe(true);
  });

  test.each([
    ["add #5 when it is already there", "add", "#5"],
    ["add acme/app#5 when #5 is already there", "add", "acme/app#5"],
    ["add ACME/App#5 when #5 is already there", "add", "ACME/App#5"],
    ["rm of an absent dependency", "rm", "#6"],
  ])("%s writes nothing", async (_n, action, ref) => {
    const h = mine(BLOCK);
    expect((await dep(h.ctx, { action, ref })).changed).toBe(false);
    expect(h.github.writes).toEqual([]);
  });

  test.each([["#5"], ["acme/app#5"]])("rm %s drops #5", async (ref) => {
    const h = mine(BLOCK);
    await dep(h.ctx, { action: "rm", ref });
    expect(block(h)).toMatchObject({ state: "building", dependsOn: [] });
  });

  test("add to a PR without a block writes only depends-on", async () => {
    const h = mine("");
    await dep(h.ctx, { action: "add", ref: "#5" });
    expect(h.github.body(REPO, 10)).toBe(
      "<!-- crew-net\ndepends-on: #5\n-->\n",
    );
  });

  test.each([
    ["depend on itself", "add", "#10", "usage"],
    ["depend on a PR closed without merge", "add", "#8", "refused"],
    ["depend on a missing PR", "add", "#404", "not-found"],
    ["depend on garbage", "add", "five", "usage"],
    ["an unknown action", "del", "#5", "usage"],
  ])("refuses to %s", async (_n, action, ref, code) => {
    const h = mine(BLOCK);
    const error = await refusal(dep(h.ctx, { action, ref }));
    expect(error.code).toBe(code as CommandError["code"]);
    expect(h.github.writes).toEqual([]);
  });

  test.each([
    [
      "add of an open dependency turns auto-merge off before writing the body",
      "add",
      "#6",
      [`auto-merge-off ${REPO}#10`, `body ${REPO}#10`],
      { changed: true, autoMergeDisabled: true },
    ],
    [
      "add of an open dependency already listed still turns auto-merge off",
      "add",
      "#5",
      [`auto-merge-off ${REPO}#10`],
      { changed: false, autoMergeDisabled: true },
    ],
    [
      "add of a merged dependency keeps auto-merge",
      "add",
      "#7",
      [`body ${REPO}#10`],
      { changed: true, autoMergeDisabled: false },
    ],
    [
      "rm keeps auto-merge as it is",
      "rm",
      "#5",
      [`body ${REPO}#10`],
      { changed: true, autoMergeDisabled: false },
    ],
  ])("auto-merge: %s", async (_n, action, ref, writes, result) => {
    const h = mine(BLOCK, { autoMerge: true });
    expect(await dep(h.ctx, { action, ref })).toMatchObject(result);
    expect(h.github.writes).toEqual(writes);
  });

  test("a failed auto-merge switch leaves the body alone", async () => {
    const h = mine(BLOCK, { autoMerge: true });
    h.github.failures.set("disableAutoMerge", new Error("HTTP 502"));
    await expect(dep(h.ctx, { action: "add", ref: "#6" })).rejects.toThrow(
      "502",
    );
    expect(h.github.writes).toEqual([]);
  });
});

test("renderState prints refs and fields only", () => {
  expect(
    renderState(
      {
        repo: REPO,
        number: 10,
        changed: true,
        state: "building",
        scope: ["api/"],
        dependsOn: ["#5", "acme/omni#88"],
        autoMergeDisabled: true,
      },
      REPO,
    ),
  ).toBe(
    "updated #10: state: building; scope: api/; depends-on: #5, acme/omni#88; auto-merge turned off until the dependency merges",
  );
});
