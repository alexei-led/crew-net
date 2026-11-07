import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseStateBlock } from "../src/protocol/state-block";

const script = join(import.meta.dir, "scripts/crew-deps.mjs");
const fixtures = [
  "",
  "no block",
  "<!-- crew-net -->",
  "<!-- crew-net v1\nlead: a/b",
  "text\n<!-- crew-net v1\nlead: a/b\nstate: building\ndepends-on: #12, Owner/Repo#3, other/repo#4\n-->\ntail",
  "<!-- crew-net v1.3\nLead: a/b\nSTATE: planning\nunknown: x\nscope: a, , b\n-->",
  "<!-- crew-net v1\nlead: first\nlead: second\nstate: review\ndepends-on: ,#01,\n-->",
  "<!-- crew-net v1\nstate: review\n-->",
  "<!-- crew-net v1\nlead: a/b\nstate: dancing\n-->",
  "<!-- crew-net v1\nlead: a/b\nstate: review\ndepends-on: nope\n-->",
  "<!-- crew-net v0\n-->",
  "<!-- crew-net v2.1\n-->",
  "<!-- crew-net v1\r\nlead: a/b\r\nstate: blocked\r\n-->",
];

describe("standalone reader", () => {
  test.each(fixtures)("agrees with protocol for %j", (body) => {
    const dir = mkdtempSync(join(import.meta.dir, ".test-"));
    try {
      const file = join(dir, "body");
      writeFileSync(file, body);
      const run = spawnSync("node", [script, "parse", file], {
        encoding: "utf8",
        env: { ...process.env, GITHUB_REPOSITORY: "owner/repo" },
      });
      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout)).toEqual(parseStateBlock(body));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });
  test.each([
    [
      "<!-- crew-net v1\nlead: a/b",
      "<!-- crew-net v1\nlead: a/b",
      1,
      "Malformed or incomplete",
    ],
    ["no block", "changed", 1, "PR body changed"],
    [
      "<!-- crew-net v2\n-->",
      "<!-- crew-net v2\n-->",
      1,
      "unsupported-version",
    ],
    [
      "<!-- crew-net v1\nlead: a/b\nstate: review\ndepends-on: #2, other/repo#3\n-->",
      "same",
      1,
      "not merged",
    ],
    [
      "<!-- crew-net v1\nlead: a/b\nstate: review\ndepends-on: #4, other/repo#3\n-->",
      "same",
      0,
      "not enforced",
    ],
  ])(
    "checks event body and dependency status",
    (body, current, status, message) => {
      const dir = mkdtempSync(join(import.meta.dir, ".test-"));
      try {
        const file = join(dir, "body");
        writeFileSync(file, body);
        writeFileSync(
          join(dir, "gh"),
          `#!/usr/bin/env node
const path = process.argv[3];
if (path.endsWith("/pulls/1")) console.log(JSON.stringify({body: process.env.CURRENT_BODY}));
else if (path.endsWith("/pulls/2")) console.log(JSON.stringify({merged_at: null}));
else if (path.endsWith("/pulls/4")) console.log(JSON.stringify({merged_at: "2026-01-01"}));
else process.exit(1);
`,
          { mode: 0o755 },
        );
        const run = spawnSync("node", [script, "check", file], {
          encoding: "utf8",
          env: {
            ...process.env,
            PATH: `${dir}:${process.env.PATH}`,
            CURRENT_BODY: current === "same" ? body : current,
            GITHUB_REPOSITORY: "owner/repo",
            GITHUB_PR_NUMBER: "1",
          },
        });
        expect(run.status).toBe(status);
        expect(run.stdout + run.stderr).toContain(message);
      } finally {
        rmSync(dir, { recursive: true });
      }
    },
  );
});
