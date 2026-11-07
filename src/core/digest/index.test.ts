import { describe, expect, test } from "bun:test";
import {
  compose,
  type Digest,
  formatAge,
  type Me,
  renderText,
  type Snapshot,
} from "./index";

const NOW = 100 * 3_600_000;
const MIN = 60_000;
const me: Me = { developer: "alexei", lead: "atlas" };

const empty: Snapshot = {
  openPrs: [],
  mergedPrs: [],
  sinceMs: null,
  myPaths: [],
  findings: [],
  unread: [],
  requests: [],
  mentions: [],
};
const snap = (over: Partial<Snapshot>): Snapshot => ({ ...empty, ...over });

const pr = (number: number, author: string, extra = {}) => ({
  number,
  title: `t${number}`,
  author,
  draft: false,
  ...extra,
});

describe("compose: open PRs", () => {
  test("lists owners, flags mine and puts mine first, then by number", () => {
    const d = compose(
      snap({
        openPrs: [pr(9, "maria"), pr(3, "alexei"), pr(5, "maria")],
      }),
      me,
      NOW,
    );
    expect(d.openPrs.map((p) => [p.number, p.mine])).toEqual([
      [3, true],
      [5, false],
      [9, false],
    ]);
  });

  test("drops bot PRs", () => {
    const d = compose(
      snap({
        openPrs: [pr(1, "dependabot[bot]"), pr(2, "renovate"), pr(3, "maria")],
      }),
      me,
      NOW,
    );
    expect(d.openPrs.map((p) => p.number)).toEqual([3]);
  });
});

describe("compose: merged since last session", () => {
  const merged = (
    number: number,
    mergedAtMs: number,
    changedPaths: string[],
  ) => ({
    number,
    title: `m${number}`,
    author: "maria",
    mergedAtMs,
    changedPaths,
  });

  test("only PRs merged after the last session, boundary excluded", () => {
    const d = compose(
      snap({
        sinceMs: 1000,
        mergedPrs: [merged(1, 1000, []), merged(2, 1001, []), merged(3, 5, [])],
      }),
      me,
      NOW,
    );
    expect(d.merged.map((m) => m.number)).toEqual([2]);
  });

  test("null sinceMs keeps all given", () => {
    const d = compose(snap({ mergedPrs: [merged(1, 5, [])] }), me, NOW);
    expect(d.merged).toHaveLength(1);
  });

  test("flags PRs touching my files and lists them first", () => {
    const d = compose(
      snap({
        sinceMs: 0,
        myPaths: ["a.ts", "b.ts"],
        mergedPrs: [
          merged(1, 300, ["z.ts"]),
          merged(2, 100, ["b.ts", "q.ts"]),
          merged(3, 200, ["a.ts"]),
        ],
      }),
      me,
      NOW,
    );
    expect(d.merged.map((m) => [m.number, m.touchesMine])).toEqual([
      [3, ["a.ts"]],
      [2, ["b.ts"]],
      [1, []],
    ]);
  });

  test("drops merged bot PRs", () => {
    const d = compose(
      snap({
        mergedPrs: [{ ...merged(1, 5, []), author: "github-actions[bot]" }],
      }),
      me,
      NOW,
    );
    expect(d.merged).toEqual([]);
  });
});

describe("compose: requests", () => {
  test("unanswered only, both directions, with age, oldest first", () => {
    const d = compose(
      snap({
        requests: [
          {
            id: "1",
            from: "maria",
            to: "alexei",
            pr: 7,
            atMs: NOW - 5 * MIN,
            answered: false,
          },
          {
            id: "2",
            from: "alexei",
            to: "maria",
            atMs: NOW - 90 * MIN,
            answered: false,
          },
          {
            id: "3",
            from: "maria",
            to: "alexei",
            atMs: NOW - 10 * MIN,
            answered: true,
          },
        ],
      }),
      me,
      NOW,
    );
    expect(d.requests).toEqual([
      { direction: "outgoing", with: "maria", ageMs: 90 * MIN },
      { direction: "incoming", with: "maria", pr: 7, ageMs: 5 * MIN },
    ]);
  });

  test("a message from the future has age zero", () => {
    const d = compose(
      snap({
        requests: [
          {
            id: "1",
            from: "maria",
            to: "alexei",
            atMs: NOW + 5,
            answered: false,
          },
        ],
      }),
      me,
      NOW,
    );
    expect(d.requests[0]?.ageMs).toBe(0);
  });
});

describe("compose: passthrough", () => {
  test("mentions stay apart from unread messages", () => {
    const d = compose(
      snap({
        unread: [{ id: "u", from: "maria", preview: "hi", atMs: 1 }],
        mentions: [{ from: "bob", preview: "cc @alexei", atMs: 2 }],
      }),
      me,
      NOW,
    );
    expect(d.unread).toHaveLength(1);
    expect(d.mentions).toHaveLength(1);
  });
});

describe("formatAge", () => {
  test.each([
    [0, "<1m"],
    [59_999, "<1m"],
    [MIN, "1m"],
    [59 * MIN, "59m"],
    [60 * MIN, "1h"],
    [23 * 60 * MIN, "23h"],
    [24 * 60 * MIN, "1d"],
    [50 * 60 * MIN, "2d"],
  ])("%d ms", (ms, text) => {
    expect(formatAge(ms)).toBe(text);
  });
});

describe("renderText", () => {
  test("empty digest", () => {
    expect(renderText(compose(empty, me, NOW))).toBe("Nothing to report.");
  });

  test("full digest shows every section, flag, age and keeps mentions apart", () => {
    const digest: Digest = compose(
      snap({
        sinceMs: 0,
        myPaths: ["a.ts"],
        openPrs: [
          pr(3, "alexei", {
            lead: "alexei/atlas",
            state: "building",
            draft: true,
          }),
        ],
        mergedPrs: [
          {
            number: 8,
            title: "m8",
            author: "maria",
            mergedAtMs: 5,
            changedPaths: ["a.ts"],
          },
        ],
        findings: [
          {
            kind: "conflict",
            other: { developer: "maria", branch: "mf", pr: 4 },
            paths: ["a.ts"],
            blocking: true,
          },
        ],
        unread: [{ id: "u", from: "maria", pr: 4, preview: "ready?", atMs: 1 }],
        requests: [
          {
            id: "r",
            from: "alexei",
            to: "maria/orion",
            atMs: NOW - 90 * MIN,
            answered: false,
          },
        ],
        mentions: [{ from: "bob", pr: 4, preview: "cc @alexei", atMs: 2 }],
      }),
      me,
      NOW,
    );
    const text = renderText(digest);
    expect(text).toContain("#3 t3 (alexei/atlas, mine, draft, building)");
    expect(text).toContain("#8 m8 (maria) TOUCHES YOUR FILES: a.ts");
    expect(text).toContain("conflict with maria #4 (mf): a.ts");
    expect(text).toContain("maria on #4: ready?");
    expect(text).toContain("waiting on maria/orion, 1h");
    const mentions = text.slice(text.indexOf("Mentions"));
    expect(mentions).toContain("bob on #4: cc @alexei");
    expect(text.slice(0, text.indexOf("Mentions"))).not.toContain("cc @alexei");
  });

  test("empty sections are omitted", () => {
    const text = renderText(
      compose(snap({ openPrs: [pr(1, "maria")] }), me, NOW),
    );
    expect(text).toContain("Open PRs");
    expect(text).not.toContain("Radar");
    expect(text).not.toContain("Mentions");
  });
});
