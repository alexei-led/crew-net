import { describe, expect, test } from "bun:test";
import { type DependencyFacts, gateDecision, isMergeCommand } from "./index";

const REPO = "doiteng/reflex";
const body = (dependsOn: string): string =>
  `text\n<!-- crew-net\nstate: review\n${
    dependsOn ? `depends-on: ${dependsOn}\n` : ""
  }-->`;
const pr = (b: string) => ({ repo: REPO, number: 50, body: b });
const merge = ["gh", "pr", "merge", "50", "--squash"];

describe("gateDecision", () => {
  const cases: [
    string,
    string,
    DependencyFacts[],
    string[],
    "allow" | "deny",
  ][] = [
    ["no dependencies", body(""), [], merge, "allow"],
    [
      "dependency merged",
      body("#2301"),
      [{ number: 2301, merged: true }],
      merge,
      "allow",
    ],
    [
      "dependency open",
      body("#2301"),
      [{ number: 2301, merged: false }],
      merge,
      "deny",
    ],
    [
      "--auto with open dependency",
      body("#2301"),
      [{ number: 2301, merged: false }],
      ["gh", "pr", "merge", "50", "--auto"],
      "deny",
    ],
    [
      "global flag before pr merge",
      body("#2301"),
      [{ number: 2301, merged: false }],
      ["gh", "-R", REPO, "pr", "merge", "50"],
      "deny",
    ],
    [
      "one merged, one open",
      body("#1, #2"),
      [
        { number: 1, merged: true },
        { number: 2, merged: false },
      ],
      merge,
      "deny",
    ],
    [
      "same-repo ref written with owner/repo",
      body(`${REPO}#2301`),
      [{ number: 2301, merged: false }],
      merge,
      "deny",
    ],
    ["dependency state missing: fail closed", body("#2301"), [], merge, "deny"],
    [
      "non-merge command with open dependency",
      body("#2301"),
      [{ number: 2301, merged: false }],
      ["gh", "pr", "view", "50"],
      "allow",
    ],
    ["unrelated command", body("#2301"), [], ["git", "status"], "allow"],
    ["no state block", "plain body", [], merge, "allow"],
    ["unterminated block", "<!-- crew-net\nstate: review", [], merge, "deny"],
    [
      "old v1 block with lead and an open dependency",
      "<!-- crew-net v1\nlead: a/b\nstate: review\ndepends-on: #7\n-->",
      [{ number: 7, merged: false }],
      merge,
      "deny",
    ],
    [
      "block without fields means no dependencies",
      "<!-- crew-net -->",
      [],
      merge,
      "allow",
    ],
    ["bad depends-on ref", body("not-a-ref"), [], merge, "deny"],
    [
      "good ref next to a bad one",
      body("#2301, nonsense"),
      [{ number: 2301, merged: true }],
      merge,
      "deny",
    ],
    [
      "future version tag with an open dependency",
      "<!-- crew-net v9\nstate: review\ndepends-on: #3\n-->",
      [{ number: 3, merged: false }],
      merge,
      "deny",
    ],
  ];
  test.each(cases)("%s", (_name, prBody, deps, argv, expected) => {
    expect(gateDecision(pr(prBody), deps, argv).decision).toBe(expected);
  });

  test("deny lists a reason per unmerged dependency", () => {
    const result = gateDecision(
      pr(body("#1, #2")),
      [
        { number: 1, merged: false },
        { number: 2, merged: false },
      ],
      merge,
    );
    expect(result).toEqual({
      decision: "deny",
      reasons: ["depends-on #1 is not merged", "depends-on #2 is not merged"],
      advisory: [],
    });
  });

  test("cross-repo refs are reported and do not block", () => {
    const result = gateDecision(pr(body("other/repo#9")), [], merge);
    expect(result.decision).toBe("allow");
    expect(result.advisory).toEqual([
      "depends-on other/repo#9 is in another repo; not enforced",
    ]);
  });

  test("cross-repo ref does not mask an open same-repo dependency", () => {
    const result = gateDecision(
      pr(body("other/repo#9, #2301")),
      [{ number: 2301, merged: false }],
      merge,
    );
    expect(result.decision).toBe("deny");
    expect(result.advisory).toHaveLength(1);
  });
});

describe("isMergeCommand", () => {
  test.each([
    [["gh", "pr", "merge", "1"], true],
    [["/opt/homebrew/bin/gh", "pr", "merge", "--auto"], true],
    [["gh", "pr", "view", "1"], false],
    [["git", "merge", "main"], false],
    [["gh", "api", "x"], false],
    [[], false],
  ] as [string[], boolean][])("%j", (argv, expected) => {
    expect(isMergeCommand(argv)).toBe(expected);
  });
});
