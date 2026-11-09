import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseStateBlock } from "../src/protocol/state-block";
import { queuePullNumbers } from "./scripts/crew-deps.mjs";

const script = join(import.meta.dir, "scripts/crew-deps.mjs");

const NEW_BLOCK = (fields: string) => `<!-- crew-net\n${fields}\n-->`;
const OLD_BLOCK = (fields: string) =>
  `<!-- crew-net v1\nlead: a/b\n${fields}\n-->`;

const fixtures = [
  "",
  "no block",
  "<!-- crew-net -->",
  "<!--crew-net\nstate: review\n-->",
  "<!-- crew-net:msg kind=ask id=k3f9 -->",
  "<!-- crew-network -->",
  "<!-- crew-net v1\nlead: a/b",
  "<!-- crew-net\nstate: review",
  "text\n<!-- crew-net\nstate: building\ndepends-on: #12, Owner/Repo#3, other/repo#4\n-->\ntail",
  "text\n<!-- crew-net v1\nlead: a/b\nstate: building\ndepends-on: #12, Owner/Repo#3, other/repo#4\n-->\ntail",
  "<!-- crew-net v1.3\nLead: a/b\nSTATE: planning\nunknown: x\nscope: a, , b\n-->",
  "<!-- crew-net\nSTATE: planning\nzeta: 1\nalpha: two words\nzeta: 2\nscope: a, , b\n-->",
  "<!-- crew-net v1\nlead: first\nlead: second\nstate: review\ndepends-on: ,#01,\n-->",
  "<!-- crew-net v1\nstate: review\n-->",
  "<!-- crew-net\nlead: a/b\n-->",
  "<!-- crew-net\nstate: dancing\ndepends-on: #1\n-->",
  "<!-- crew-net v1\nlead: a/b\nstate: dancing\n-->",
  "<!-- crew-net\nstate: review\ndepends-on: nope\n-->",
  "<!-- crew-net\nstate: review\ndepends-on: #1, nope, o/r#2\n-->",
  "<!-- crew-net v0\n-->",
  "<!-- crew-net v2.1\nstate: review\n-->",
  "<!-- crew-net\r\nstate: blocked\r\n-->",
  "<!-- crew-net state: review -->",
  "<!-- crew-net\nbad key: 1\nnote-1: ok\n-->",
];

const withDir = <T>(fn: (dir: string) => T): T => {
  const dir = mkdtempSync(join(import.meta.dir, ".test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true });
  }
};

describe("standalone reader", () => {
  test.each(fixtures)("agrees with protocol for %j", (body) => {
    withDir((dir) => {
      const file = join(dir, "body");
      writeFileSync(file, body);
      const run = spawnSync("node", [script, "parse", file], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_REPOSITORY: "owner/repo" },
      });
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual(parseStateBlock(body));
    });
  });

  test("a block in either format never reads as absent", () => {
    for (const body of [NEW_BLOCK(""), OLD_BLOCK(""), "<!-- crew-net v1\n"]) {
      expect(parseStateBlock(body)).not.toBeNull();
    }
  });
});

// A stand-in `gh` that answers `gh api <path>` from a table in the environment.
const GH_STUB = `#!/usr/bin/env node
const routes = JSON.parse(process.env.GH_ROUTES);
const path = process.argv[3];
if (process.argv[2] === "api" && process.argv[3] === "--method") {
  console.log("POST " + process.argv[5]);
  process.exit(0);
}
const hit = Object.entries(routes).find(([suffix]) => path.endsWith(suffix));
if (!hit) { console.error("no route for " + path); process.exit(1); }
console.log(JSON.stringify(hit[1]));
`;

interface Run {
  status: number | null;
  output: string;
}

function runScript(
  args: string[],
  routes: Record<string, unknown>,
  env: Record<string, string> = {},
  prepare?: (dir: string) => string[],
): Run {
  return withDir((dir) => {
    writeFileSync(join(dir, "gh"), GH_STUB, { mode: 0o755 });
    const extra = prepare ? prepare(dir) : args;
    const run = spawnSync("node", [script, ...extra], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        GH_ROUTES: JSON.stringify(routes),
        GITHUB_REPOSITORY: "owner/repo",
        ...env,
      },
    });
    return { status: run.status, output: run.stdout + run.stderr };
  });
}

const PULLS = {
  "/pulls/2": { merged_at: null },
  "/pulls/4": { merged_at: "2026-01-01" },
};

describe("check", () => {
  test.each([
    [
      "unterminated block",
      NEW_BLOCK("state: review").slice(0, -4),
      "same",
      1,
      "Invalid crew-net state block",
    ],
    [
      "unterminated old block",
      "<!-- crew-net v1\nlead: a/b",
      "same",
      1,
      "Invalid crew-net state block",
    ],
    [
      "body changed after the event",
      "no block",
      "changed",
      1,
      "PR body changed",
    ],
    ["no block", "no block", "same", 0, "no dependencies"],
    [
      "block without dependencies, new",
      NEW_BLOCK("state: review"),
      "same",
      0,
      "",
    ],
    [
      "open dependency, new format",
      NEW_BLOCK("state: review\ndepends-on: #2, other/repo#3"),
      "same",
      1,
      "not merged",
    ],
    [
      "open dependency, old format",
      OLD_BLOCK("state: review\ndepends-on: #2"),
      "same",
      1,
      "not merged",
    ],
    [
      "merged dependency, new format",
      NEW_BLOCK("state: review\ndepends-on: #4, other/repo#3"),
      "same",
      0,
      "not enforced",
    ],
    [
      "merged dependency, old format",
      OLD_BLOCK("state: review\ndepends-on: #4"),
      "same",
      0,
      "is merged",
    ],
    [
      "block without lead",
      NEW_BLOCK("depends-on: #2"),
      "same",
      1,
      "not merged",
    ],
    [
      "bad ref beside a merged one",
      NEW_BLOCK("state: review\ndepends-on: #4, soon"),
      "same",
      1,
      'Unreadable depends-on value "soon"',
    ],
    [
      "bad state does not block",
      NEW_BLOCK("state: dancing\ndepends-on: #4"),
      "same",
      0,
      "Unreadable state",
    ],
    [
      "bad state does not hide an open dependency",
      NEW_BLOCK("state: dancing\ndepends-on: #2"),
      "same",
      1,
      "not merged",
    ],
  ])("%s", (_name, body, current, status, message) => {
    const result = runScript(
      ["check"],
      { ...PULLS, "/pulls/1": { body: current === "same" ? body : current } },
      { GITHUB_PR_NUMBER: "1" },
      (dir) => {
        const file = join(dir, "body");
        writeFileSync(file, body);
        return ["check", file];
      },
    );
    expect(result.status).toBe(status);
    expect(result.output).toContain(message);
  });
});

describe("check-queue", () => {
  const ref = (n: number) =>
    `refs/heads/gh-readonly-queue/main/pr-${n}-0123456789abcdef0123456789abcdef01234567`;

  test.each([
    ["no block", "plain", 0, "no dependencies"],
    ["open dependency", NEW_BLOCK("depends-on: #2"), 1, "not merged"],
    [
      "old format, open dependency",
      OLD_BLOCK("depends-on: #2"),
      1,
      "not merged",
    ],
    ["merged dependency", NEW_BLOCK("depends-on: #4"), 0, "is merged"],
    ["bad ref", NEW_BLOCK("depends-on: soon"), 1, "Unreadable depends-on"],
    [
      "unterminated block",
      "<!-- crew-net\ndepends-on: #4",
      1,
      "Invalid crew-net state block",
    ],
  ])("%s", (_name, body, status, message) => {
    const result = runScript(["check-queue", ref(7)], {
      ...PULLS,
      "/pulls/7": { body },
    });
    expect(result.status).toBe(status);
    expect(result.output).toContain(message);
  });

  test("reads the PR from the API, not from the event", () => {
    const result = runScript(["check-queue", ref(7)], {
      ...PULLS,
      "/pulls/7": { body: null },
    });
    expect(result.status).toBe(0);
  });

  test.each([
    ["queue branch", "gh-readonly-queue/main/pr-12-0123456", ["12"]],
    [
      "queue branch with refs/heads",
      "refs/heads/gh-readonly-queue/dev/pr-5-abcdef1234",
      ["5"],
    ],
    [
      "queue branch of a slashed base",
      "refs/heads/gh-readonly-queue/release/1.x/pr-9-abcdef1",
      ["9"],
    ],
  ])("queuePullNumbers: %s", (_name, headRef, expected) => {
    expect(queuePullNumbers(headRef)).toEqual(expected);
  });

  test.each([
    "",
    "refs/heads/main",
    "refs/heads/feature/pr-12-abcdef1",
    "gh-readonly-queue/main/pr-x-abcdef1",
    "gh-readonly-queue/main/12",
  ])("fails closed on an unrecognised ref: %j", (headRef) => {
    expect(() => queuePullNumbers(headRef)).toThrow(
      "Unrecognised merge queue ref",
    );
    const result = runScript(["check-queue", headRef || "x"], PULLS);
    expect(result.status).toBe(1);
    expect(result.output).toContain("Unrecognised merge queue ref");
  });
});

describe("rerun", () => {
  const open = (number: number, body: string) => ({
    number,
    body,
    head: { sha: `sha${number}`, ref: `branch${number}` },
  });
  const runsFor = (number: number) => ({
    [`head_sha=sha${number}&per_page=100`]: {
      workflow_runs: [
        {
          id: 900 + number,
          head_branch: `branch${number}`,
          pull_requests: [{ number }],
        },
      ],
    },
  });

  test("reruns dependents in either block format", () => {
    const result = runScript(["rerun", "2"], {
      "pulls?state=open&per_page=100": [
        [
          open(10, NEW_BLOCK("depends-on: #2")),
          open(11, OLD_BLOCK("depends-on: #2")),
          open(12, NEW_BLOCK("depends-on: #3")),
          open(13, "no block"),
        ],
      ],
      ...runsFor(10),
      ...runsFor(11),
    });
    expect(result.status).toBe(0);
    expect(result.output).toContain("Reran crew-deps run 910 for PR #10");
    expect(result.output).toContain("Reran crew-deps run 911 for PR #11");
    expect(result.output).not.toContain("PR #12");
  });

  test("an unreadable block fails the job instead of being skipped", () => {
    const result = runScript(["rerun", "2"], {
      "pulls?state=open&per_page=100": [
        [
          open(10, "<!-- crew-net\ndepends-on: #2"),
          open(11, NEW_BLOCK("depends-on: #2")),
        ],
      ],
      ...runsFor(11),
    });
    expect(result.status).toBe(1);
    expect(result.output).toContain("PR #10: unreadable state block");
    expect(result.output).toContain("Reran crew-deps run 911 for PR #11");
  });
});
