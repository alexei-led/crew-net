import { describe, expect, test } from "bun:test";
import {
  BRANCH,
  FakeGit,
  FakeGitHub,
  harness,
  pull,
  REPO,
  ROOT,
} from "./fixtures/fakes";
import {
  type GateResult,
  gate,
  gateExitCode,
  mayMerge,
  renderGate,
} from "./index";

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

describe("gate decisions (design: Order)", () => {
  test.each([
    ["git merge gh-pages", "allow", []],
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
    expect((await run(world(deps("#1")), "gh deploy")).decision).toBe("deny");
  });

  test("a known alias map lets an unrelated alias through", async () => {
    const h = world(deps("#1"));
    const result = await gate(h.ctx, {
      argv: ["gh deploy 5"],
      aliases: new Map([["shipit", "pr merge"]]),
    });
    expect(result.decision).toBe("allow");
  });

  test("a split line with a shell operator is denied, not read as its first command", async () => {
    const h = world("");
    const result = await run(h, [
      "gh",
      "pr",
      "view",
      "10",
      "&&",
      "gh",
      "pr",
      "merge",
      "10",
    ]);
    expect(result).toMatchObject({ decision: "deny", failed: false });
    expect(result.reasons[0]).toMatch(/split into words/);
  });

  test("a deny reason with peer text is one short line", async () => {
    const h = world("");
    h.github.add(
      REPO,
      pull(12, {
        body: `<!-- crew-net\ndepends-on: #1, bad\u0007\u001b[2J${"z".repeat(300)}\n-->`,
      }),
    );
    const result = await run(h, "gh pr merge 12");
    expect(result.decision).toBe("deny");
    for (const r of result.reasons) {
      expect([...r].some((c) => c.charCodeAt(0) < 32)).toBe(false);
      expect(r.length).toBeLessThanOrEqual(160);
    }
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
        repo: "acme/app",
        reasons: 1,
        atMs: 1_000_000,
      },
    ]);
  });

  test("a command that merges nothing is not logged", async () => {
    const h = world("");
    await run(h, "gh pr view 10");
    expect(h.store.eventLog).toEqual([]);
  });

  test.each([
    ["gh pr view 10", false],
    ["git merge main", false],
    ["gh pr merge 10", true],
    ['eval "$X"', true],
  ])("mayMerge(%p) is %p", (line, expected) => {
    expect(mayMerge([line])).toBe(expected);
  });

  test("a failing event log does not change the decision", async () => {
    const h = world(deps("#2"));
    h.store.events.append = async () => {
      throw new Error("disk full");
    };
    expect((await run(h, "gh pr merge 10")).decision).toBe("allow");
  });
});

describe("hosts and default repos", () => {
  const GHE = "ghe.example.com";
  const blocked = `${GHE}/acme/app#10: depends-on #1 is not merged`;

  /** acme/app#10 may merge on github.com; on GHE it waits on open #1. */
  function twoHosts(over: Parameters<typeof harness>[0] = {}) {
    const h = harness(over);
    h.github.add(REPO, pull(10));
    const ghe = new FakeGitHub();
    ghe.add(REPO, pull(10, { body: deps("#1") })).add(REPO, pull(1));
    h.hosts.set(GHE, ghe);
    return { h, ghe };
  }

  test.each([
    ["-R host/repo", `gh pr merge 10 -R ${GHE}/acme/app`, {}],
    ["a URL", `gh pr merge https://${GHE}/acme/app/pull/10`, {}],
    [
      "gh api --hostname",
      `gh api --hostname ${GHE} -X PUT repos/acme/app/pulls/10/merge`,
      {},
    ],
    ["GH_HOST", "gh pr merge 10 -R acme/app", { ghHost: GHE }],
    ["GH_REPO", "gh pr merge 10", { ghRepo: `${GHE}/acme/app` }],
  ])(
    "a merge named by %s is checked on that host",
    async (_name, line, env) => {
      const { h, ghe } = twoHosts(env);
      expect(await run(h, line)).toMatchObject({
        decision: "deny",
        reasons: [blocked],
      });
      expect(ghe.reads).toContain("get acme/app#10");
      expect(h.github.reads).toEqual([]);
    },
  );

  test("a host without a usable token denies", async () => {
    const h = harness();
    expect(
      await run(h, "gh pr merge https://other.example/acme/app/pull/10"),
    ).toMatchObject({ decision: "deny", failed: true });
  });

  test("in a clone on another host a repo named without a host is denied; the clone's own PRs read from its host", async () => {
    const { h, ghe } = twoHosts();
    h.hosts.set("github.com", h.github);
    const ctx = { ...h.ctx, host: GHE, github: ghe };
    const noHost = await gate(ctx, { argv: ["gh pr merge 10 -R acme/app"] });
    expect(noHost).toMatchObject({ decision: "deny", failed: true });
    expect(noHost.reasons[0]).toContain(`-R ${GHE}/acme/app`);
    expect(
      await gate(ctx, { argv: ["gh pr merge 10 -R github.com/acme/app"] }),
    ).toMatchObject({ decision: "allow" });
    expect(await gate(ctx, { argv: ["gh pr merge 10"] })).toMatchObject({
      decision: "deny",
      reasons: ["acme/app#10: depends-on #1 is not merged"],
    });
  });

  const remote = (name: string, url: string, ghResolved?: string) => ({
    name,
    url,
    ...(ghResolved ? { ghResolved } : {}),
  });
  test.each([
    [
      "only origin",
      [remote("origin", "git@github.com:acme/app.git")],
      "acme/app",
    ],
    [
      "set-default to the parent",
      [
        remote("origin", "git@github.com:me/app.git"),
        remote("parent", "git@github.com:acme/app.git", "base"),
      ],
      "acme/app",
    ],
    [
      "set-default by name",
      [remote("origin", "git@github.com:me/app.git", "acme/app")],
      "acme/app",
    ],
    [
      "no default: upstream before origin",
      [
        remote("origin", "git@github.com:me/app.git"),
        remote("upstream", "https://github.com/acme/app.git"),
      ],
      "acme/app",
    ],
  ])("the default repo with %s is %s", async (_name, remotes, expected) => {
    const h = harness({ git: new FakeGit([], remotes) });
    h.github
      .add(expected, pull(10, { body: deps("#1") }))
      .add(expected, pull(1));
    expect(await run(h, "gh pr merge 10")).toMatchObject({
      decision: "deny",
      checked: [`${expected}#10`],
    });
  });
});

describe("what gh would merge differs from what the gate reads", () => {
  test("a remote crew-net cannot read denies instead of being skipped", async () => {
    const h = harness({
      git: new FakeGit(
        [],
        [
          { name: "origin", url: "git@github.com:me/app.git" },
          { name: "upstream", url: "git://github.com/acme/app.git" },
        ],
      ),
    });
    h.github.add("me/app", pull(10));
    expect(await run(h, "gh pr merge 10")).toMatchObject({
      decision: "deny",
      failed: true,
    });
  });

  test("with GH_HOST in the environment gh keeps only that host's remotes", async () => {
    const GHE = "ghe.example.com";
    const h = harness({
      ghHost: GHE,
      git: new FakeGit(
        [],
        [
          { name: "origin", url: "git@github.com:me/app.git" },
          { name: "ghe", url: `git@${GHE}:acme/app.git` },
        ],
      ),
    });
    h.github.add("me/app", pull(10));
    const ghe = new FakeGitHub();
    ghe.add(REPO, pull(10, { body: deps("#1") })).add(REPO, pull(1));
    h.hosts.set(GHE, ghe);
    expect(await run(h, "gh pr merge 10")).toMatchObject({
      decision: "deny",
      checked: [`${GHE}/acme/app#10`],
    });
  });

  test("a current branch that tracks another PR's head is denied", async () => {
    const git = new FakeGit([{ path: ROOT, branch: BRANCH }]);
    git.config.set(`branch.${BRANCH}.merge`, "refs/pull/123/head");
    const h = harness({ git });
    h.github.add(REPO, pull(40, { headRef: BRANCH }));
    const result = await run(h, "gh pr merge --squash");
    expect(result).toMatchObject({ decision: "deny", failed: true });
    expect(result.reasons[0]).toContain("refs/pull/123/head");
  });

  test("a current branch that tracks its own name is fine", async () => {
    const git = new FakeGit([{ path: ROOT, branch: BRANCH }]);
    git.config.set(`branch.${BRANCH}.merge`, `refs/heads/${BRANCH}`);
    const h = harness({ git });
    h.github.add(REPO, pull(40, { headRef: BRANCH }));
    expect(await run(h, "gh pr merge")).toMatchObject({ decision: "allow" });
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
