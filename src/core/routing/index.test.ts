import { describe, expect, test } from "bun:test";
import { type LiveSession, type Route, type RouteItem, route } from "./index";

const REPO = "doiteng/reflex";
const OTHER = "doiteng/omni";

const session = (id: string, over: Partial<LiveSession> = {}): LiveSession => ({
  id,
  role: "lead",
  repo: REPO,
  worktree: `/w/${id}`,
  branch: "main",
  cloneRoot: "/w/reflex",
  lastActiveMs: 100,
  ...over,
});

const onPr: RouteItem = { repo: REPO, thread: 2310, branch: "feat/users" };
const onIssue: RouteItem = { repo: REPO, thread: 42 };

const to = (id: string, step: string, wakeable = true): Route =>
  ({ session: id, step, wakeable }) as Route;
const none: Route = { session: null, step: "none", wakeable: false };

describe("route", () => {
  const cases: [string, RouteItem, LiveSession[], Route][] = [
    // 1. checkout
    [
      "lead with the PR branch checked out",
      onPr,
      [
        session("a", { branch: "feat/users", lastActiveMs: 1 }),
        session("b", { lastActiveMs: 999 }),
      ],
      to("a", "checkout"),
    ],
    [
      "two leads on the branch: most recent",
      onPr,
      [
        session("a", { branch: "feat/users", lastActiveMs: 1 }),
        session("b", { branch: "feat/users", lastActiveMs: 2 }),
      ],
      to("b", "checkout"),
    ],
    [
      "checkout tie breaks on id",
      onPr,
      [
        session("z", { branch: "feat/users" }),
        session("m", { branch: "feat/users" }),
      ],
      to("m", "checkout"),
    ],
    [
      "same branch name in another repo is not a checkout match",
      onPr,
      [
        session("a", { repo: OTHER, branch: "feat/users", lastActiveMs: 9 }),
        session("b", { lastActiveMs: 1 }),
      ],
      to("b", "repo"),
    ],
    [
      "repo match is case-insensitive",
      { ...onPr, repo: "DoitEng/Reflex" },
      [session("a", { branch: "feat/users" })],
      to("a", "checkout"),
    ],
    // 2. clone
    [
      "branch in a worker's worktree goes to the lead of that clone",
      onPr,
      [
        session("w", {
          role: "worker",
          branch: "feat/users",
          worktree: "/w/reflex.worktrees/users",
          lastActiveMs: 999,
        }),
        session("lead1", { cloneRoot: "/w/reflex", lastActiveMs: 1 }),
        session("lead2", { cloneRoot: "/w/reflex-2", lastActiveMs: 50 }),
      ],
      to("lead1", "clone"),
    ],
    [
      "two leads in that clone: most recent",
      onPr,
      [
        session("w", { role: "worker", branch: "feat/users" }),
        session("a", { lastActiveMs: 1 }),
        session("b", { lastActiveMs: 2 }),
      ],
      to("b", "clone"),
    ],
    [
      "checkout beats clone",
      onPr,
      [
        session("w", { role: "worker", branch: "feat/users" }),
        session("a", { lastActiveMs: 50 }),
        session("b", {
          branch: "feat/users",
          cloneRoot: "/w/other-clone",
          lastActiveMs: 1,
        }),
      ],
      to("b", "checkout"),
    ],
    // 3. repo
    [
      "no branch match: most recent lead in the repo",
      onPr,
      [
        session("a", { lastActiveMs: 1 }),
        session("b", { lastActiveMs: 5 }),
        session("c", { repo: OTHER, lastActiveMs: 99 }),
      ],
      to("b", "repo"),
    ],
    [
      "Issue (no branch): most recent lead in the repo",
      onIssue,
      [
        session("a", { branch: "feat/users", lastActiveMs: 1 }),
        session("b", { lastActiveMs: 5 }),
      ],
      to("b", "repo"),
    ],
    // 4. any
    [
      "no lead in the repo: most recent lead anywhere, not wakeable",
      onPr,
      [
        session("a", { repo: OTHER, lastActiveMs: 1 }),
        session("b", { repo: "x/y", lastActiveMs: 7 }),
      ],
      to("b", "any", false),
    ],
    // 5. none
    ["no sessions", onPr, [], none],
    [
      "only workers, even with the branch checked out",
      onPr,
      [session("w", { role: "worker", branch: "feat/users" })],
      none,
    ],
  ];

  test.each(cases)("%s", (_name, item, sessions, expected) => {
    expect(route(item, sessions)).toEqual(expected);
  });

  test("a worker is never the target at any step", () => {
    const worker = session("w", {
      role: "worker",
      branch: "feat/users",
      lastActiveMs: 1_000,
    });
    for (const item of [onPr, onIssue, { repo: OTHER }]) {
      expect(route(item, [worker, session("a")]).session).toBe("a");
    }
  });
});
