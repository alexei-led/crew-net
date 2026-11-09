import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStateBlock } from "../src/protocol/state-block";
import {
  queuePullNumbers,
  parseStateBlock as standaloneParse,
} from "./scripts/crew-deps.mjs";

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
  "<!-- crew-net state: review depends-on: #2 -->",
  "<!-- crew-net v1 lead: a/b state: review depends-on: #2 -->",
  "<!-- crew-net\ndepends-on:\ndepends-on: #2\n-->",
  "<!-- crew-net\n- depends-on: #2\n-->",
  "<!-- crew-net\ndepends_on: #2\n-->",
  "Mentions `<!-- crew-net -->`.\n\n<!-- crew-net\ndepends-on: #2\n-->",
  "<!-- crew-net\ndepends-on: #2\n-->\nand `<!-- crew-net -->`",
  "Uses <!-- crew-net comments.\n\n<!-- crew-net\nstate: building\n-->",
  "<!-- Crew-Net v1\nlead: a/b\nstate: review\ndepends-on: #2\n-->",
  "<!--\ncrew-net\ndepends-on: #2\n-->",
];

describe("standalone reader", () => {
  test.each(fixtures)("agrees with protocol for %j", (body) => {
    expect(standaloneParse(body)).toEqual(parseStateBlock(body));
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

// One stub directory for the file; each run passes its routes in the environment.
let bin: string;
let bodies = 0;
beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "crew-deps-"));
  writeFileSync(join(bin, "gh"), GH_STUB, { mode: 0o755 });
});
afterAll(() => rmSync(bin, { recursive: true, force: true }));

function bodyFile(body: string): string {
  const file = join(bin, `body-${bodies++}`);
  writeFileSync(file, body);
  return file;
}

/** Runs the script under node, as the workflow does, with the gh stub first on PATH. */
function runScript(
  args: string[],
  routes: Record<string, unknown>,
  env: Record<string, string> = {},
): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [script, ...args], {
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GH_ROUTES: JSON.stringify(routes),
        GITHUB_REPOSITORY: "owner/repo",
        ...env,
      },
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, output }));
  });
}

const PULLS = {
  "/pulls/2": { merged_at: null },
  "/pulls/4": { merged_at: "2026-01-01" },
};

describe.concurrent("check", () => {
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
      "bad ref beside a merged one",
      NEW_BLOCK("state: review\ndepends-on: #4, soon"),
      "same",
      1,
      'Unreadable depends-on value "soon"',
    ],
    [
      "depends-on on the same line as state",
      "<!-- crew-net state: review depends-on: #4 -->",
      "same",
      1,
      "Unreadable depends-on",
    ],
    [
      "prose mention of the format before the block",
      "About `<!-- crew-net -->`.\n\n<!-- crew-net\ndepends-on: #4\n-->",
      "same",
      1,
      "more than one state block",
    ],
    [
      "block with a different spelling of the tag",
      "<!-- Crew-Net v1\nlead: a/b\ndepends-on: #2\n-->",
      "same",
      1,
      "not merged",
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
  ])("%s", async (_name, body, current, status, message) => {
    const result = await runScript(
      ["check", bodyFile(body)],
      { ...PULLS, "/pulls/1": { body: current === "same" ? body : current } },
      { GITHUB_PR_NUMBER: "1" },
    );
    expect(result.status).toBe(status);
    expect(result.output).toContain(message);
  });

  test("a block without dependencies passes and prints nothing", async () => {
    const body = NEW_BLOCK("state: review");
    const result = await runScript(
      ["check", bodyFile(body)],
      { ...PULLS, "/pulls/1": { body } },
      { GITHUB_PR_NUMBER: "1" },
    );
    expect(result).toEqual({ status: 0, output: "" });
  });
});

describe.concurrent("check-queue", () => {
  const ref = (n: number) =>
    `refs/heads/gh-readonly-queue/main/pr-${n}-0123456789abcdef0123456789abcdef01234567`;

  test.each([
    ["open dependency", NEW_BLOCK("depends-on: #2"), 1, "not merged"],
    ["merged dependency", NEW_BLOCK("depends-on: #4"), 0, "is merged"],
    ["bad ref", NEW_BLOCK("depends-on: soon"), 1, "Unreadable depends-on"],
    [
      "unterminated block",
      "<!-- crew-net\ndepends-on: #4",
      1,
      "Invalid crew-net state block",
    ],
  ])("%s", async (_name, body, status, message) => {
    const result = await runScript(["check-queue", ref(7)], {
      ...PULLS,
      "/pulls/7": { body },
    });
    expect(result.status).toBe(status);
    expect(result.output).toContain(message);
  });

  test("reads the PR from the API, not from the event", async () => {
    const result = await runScript(["check-queue", ref(7)], {
      ...PULLS,
      "/pulls/7": { body: null },
    });
    expect(result.status).toBe(0);
    expect(result.output).toContain("Merge queue entry for PR #7.");
    expect(result.output).toContain("no dependencies");
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
  ])("queuePullNumbers fails closed on an unrecognised ref: %j", (headRef) => {
    expect(() => queuePullNumbers(headRef)).toThrow(
      "Unrecognised merge queue ref",
    );
  });

  test("check-queue fails the check on an unrecognised ref", async () => {
    const result = await runScript(["check-queue", "refs/heads/main"], PULLS);
    expect(result.status).toBe(1);
    expect(result.output).toContain("Unrecognised merge queue ref");
  });
});

describe.concurrent("rerun", () => {
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

  test("reruns dependents in either block format", async () => {
    const result = await runScript(["rerun", "2"], {
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

  test("an unreadable block fails the job instead of being skipped", async () => {
    const result = await runScript(["rerun", "2"], {
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
