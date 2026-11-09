import { describe, expect, test } from "bun:test";
import { BRANCH, FakeGit, harness, pull, REPO } from "./fixtures/fakes";
import { type GateResult, gate, gateExitCode, renderGate } from "./index";

const deps = (...refs: string[]) =>
  `Body.\n\n<!-- crew-net\nstate: review\ndepends-on: ${refs.join(", ")}\n-->`;

/**
 * #10 mine on the current branch, depending on `body`'s refs.
 * #1 open, #2 merged, #3 closed unmerged, acme/omni#88 open, acme/omni#89 merged.
 */
function world(body: string) {
  const h = harness();
  h.github
    .add(REPO, pull(10, { headRef: BRANCH, body }))
    .add(REPO, pull(11, { headRef: "other", body: deps("#2") }))
    .add(REPO, pull(1))
    .add(REPO, pull(2, { state: "closed", merged: true }))
    .add(REPO, pull(3, { state: "closed", merged: false }))
    .add("acme/omni", pull(88))
    .add("acme/omni", pull(89, { state: "closed", merged: true }));
  return h;
}

const run = (h: ReturnType<typeof harness>, line: string | string[]) =>
  gate(h.ctx, { argv: Array.isArray(line) ? line : [line] });

describe("gate decisions (design §11)", () => {
  test.each([
    ["git merge gh-pages", "allow", []],
    ["gh pr view 10", "allow", []],
    ["gh pr merge --disable-auto 10", "allow", []],
  ])("%s needs no GitHub read", async (line, decision, reasons) => {
    const h = world(deps("#1"));
    expect(await run(h, line)).toEqual({
      decision,
      reasons,
      checked: [],
      failed: false,
    } as GateResult);
    expect(h.github.reads).toEqual([]);
  });

  test.each([
    ["no state block", "Body.", "allow", []],
    ["a merged dependency", deps("#2"), "allow", []],
    ["a merged cross-repo dependency", deps("acme/omni#89"), "allow", []],
    [
      "an open dependency",
      deps("#1"),
      "deny",
      ["acme/app#10: depends-on #1 is not merged"],
    ],
    [
      "an open cross-repo dependency",
      deps("#2", "acme/omni#88"),
      "deny",
      ["acme/app#10: depends-on acme/omni#88 is not merged"],
    ],
    [
      "a dependency closed without merge",
      deps("#3"),
      "deny",
      ["acme/app#10: depends-on #3: dependency closed without merge"],
    ],
    [
      "a dependency that does not exist",
      deps("#404"),
      "deny",
      ["acme/app#10: depends-on #404: state unknown"],
    ],
    [
      "an unreadable block",
      "<!-- crew-net\ndepends-on: #1\n",
      "deny",
      [expect.stringMatching(/^acme\/app#10: PR #10: malformed state block/)],
    ],
  ])("gh pr merge 10 with %s: %s", async (_n, body, decision, reasons) => {
    const result = await run(world(body), "gh pr merge 10 --squash");
    expect(result).toEqual({
      decision,
      reasons,
      checked: ["acme/app#10"],
      failed: false,
    } as GateResult);
  });

  test.each([
    ["the current branch", "gh pr merge --auto --squash"],
    ["the branch name", `gh pr merge ${BRANCH}`],
    ["a URL", "gh pr merge https://github.com/acme/app/pull/10"],
    ["gh api", "gh api -X PUT repos/acme/app/pulls/10/merge"],
    ["the words of the command", ["gh", "pr", "merge", "10", "--auto"]],
  ])("finds the PR from %s", async (_n, line) => {
    const result = await run(world(deps("#1")), line);
    expect(result).toMatchObject({
      decision: "deny",
      checked: ["acme/app#10"],
    });
  });

  test("-R reads the PR in that repo", async () => {
    const h = world("");
    h.github.add("acme/omni", pull(90, { body: deps("#88") }));
    expect(await run(h, "gh pr merge -R acme/omni 90")).toMatchObject({
      decision: "deny",
      reasons: ["acme/omni#90: depends-on #88 is not merged"],
    });
  });

  test("every merge on the line is gated", async () => {
    const result = await run(
      world(deps("#1")),
      "gh pr merge 11 && gh pr merge 10",
    );
    expect(result).toMatchObject({
      decision: "deny",
      checked: ["acme/app#11", "acme/app#10"],
      reasons: ["acme/app#10: depends-on #1 is not merged"],
    });
  });

  test("a merge detection cannot pin is denied without reading GitHub", async () => {
    const h = world("");
    const result = await run(h, 'eval "$CMD"');
    expect(result.decision).toBe("deny");
    expect(result.failed).toBe(false);
    expect(h.github.reads).toEqual([]);
  });

  test("an unknown gh command gates the current PR when aliases are unknown", async () => {
    expect((await run(world(deps("#1")), "gh shipit")).decision).toBe("deny");
  });

  test("a known alias map lets an unrelated alias through", async () => {
    const h = world(deps("#1"));
    const result = await gate(h.ctx, {
      argv: ["gh co 5"],
      aliases: new Map([["shipit", "pr merge"]]),
    });
    expect(result.decision).toBe("allow");
  });
});

describe("gate fails closed", () => {
  test("a network error reading the PR denies and marks the gate failed", async () => {
    const h = world("");
    h.github.failures.set("getPull", new Error("fetch failed"));
    const result = await run(h, "gh pr merge 10");
    expect(result).toEqual({
      decision: "deny",
      reasons: [
        "crew-net gate: cannot read GitHub (fetch failed); denied (fail closed)",
      ],
      checked: [],
      failed: true,
    });
    expect(gateExitCode(result)).toBe(1);
  });

  test("a network error reading one dependency denies on that dependency", async () => {
    const h = world(deps("#2", "acme/omni#89"));
    h.github.failures.set("getPull acme/omni#89", new Error("fetch failed"));
    const result = await run(h, "gh pr merge 10");
    expect(result).toMatchObject({
      decision: "deny",
      reasons: ["acme/app#10: depends-on acme/omni#89: state unknown"],
    });
  });

  test("no answer within the deadline denies", async () => {
    const h = world("");
    h.github.hangs.add("getPull");
    const result = await gate(h.ctx, {
      argv: ["gh pr merge 10"],
      deadlineMs: 20,
    });
    expect(result).toMatchObject({ decision: "deny", failed: true });
    expect(result.reasons[0]).toMatch(/no answer within 20 ms/);
  });

  test("no branch at the cwd denies a merge of the current PR", async () => {
    const h = harness({ git: new FakeGit([]) });
    const result = await gate(h.ctx, { argv: ["gh pr merge --auto"] });
    expect(result).toMatchObject({ decision: "deny", failed: true });
  });

  test.each([
    ["no open PR", [], /no open PR for branch feat-users/],
    [
      "two open PRs",
      [
        pull(40, { headRef: BRANCH }),
        pull(41, { headRef: BRANCH, author: "fork" }),
      ],
      /several open PRs/,
    ],
  ])("a branch with %s denies", async (_n, pulls, msg) => {
    const h = harness();
    for (const p of pulls) h.github.add(REPO, p);
    const result = await gate(h.ctx, { argv: [`gh pr merge ${BRANCH}`] });
    expect(result.decision).toBe("deny");
    expect(result.reasons[0]).toMatch(msg);
  });

  test("every decision is logged for stats", async () => {
    const h = world(deps("#1"));
    await run(h, "gh pr merge 10");
    expect(h.store.eventLog).toEqual([
      {
        type: "gate",
        decision: "deny",
        failed: false,
        checked: ["acme/app#10"],
        reasons: 1,
        atMs: 1_000_000,
      },
    ]);
  });

  test("a failing event log does not change the decision", async () => {
    const h = world(deps("#2"));
    h.store.events.append = async () => {
      throw new Error("disk full");
    };
    expect((await run(h, "gh pr merge 10")).decision).toBe("allow");
  });
});

test("renderGate lists the reasons", () => {
  expect(
    renderGate({
      decision: "deny",
      reasons: ["acme/app#10: depends-on #1 is not merged"],
      checked: ["acme/app#10"],
      failed: false,
    }),
  ).toBe("deny:\n  acme/app#10: depends-on #1 is not merged");
  expect(
    renderGate({ decision: "allow", reasons: [], checked: [], failed: false }),
  ).toBe("allow: no merge");
});
