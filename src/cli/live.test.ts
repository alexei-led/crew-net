import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "./main";
import { createRuntime } from "./runtime";

const LIVE = process.env.CREW_NET_LIVE === "1";
const SANDBOX = "alexei-led/crew-net-sandbox";
const root = LIVE ? mkdtempSync(join(tmpdir(), "crew-net-live-")) : "";

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

async function run(cwd: string, env: NodeJS.ProcessEnv, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(argv, createRuntime(cwd, env), {
    out: (t) => out.push(t),
    err: (t) => err.push(t),
  });
  return { code, out: out.join(""), err: err.join("") };
}

// Opt-in: CREW_NET_LIVE=1 bun test src/cli/live.test.ts
// Reads the sandbox through the real adapters; the only write it can cause
// is turning auto-merge off on one of my sandbox PRs with an open dependency.
test.skipIf(!LIVE)(
  "live sandbox: one sync pass and a digest from the store",
  async () => {
    const clone = join(root, "sandbox");
    execFileSync("gh", ["repo", "clone", SANDBOX, clone, "--", "--quiet"]);
    const env = { ...process.env, XDG_STATE_HOME: join(root, "state") };
    const sync = await run(clone, env, "sync", "--json");
    const report = JSON.parse(sync.out);
    expect(
      report.jobs.filter((j: { outcome: string }) => j.outcome === "failed"),
    ).toEqual([]);
    expect(report.jobs.map((j: { job: string }) => j.job)).toEqual(
      expect.arrayContaining([
        `repo:github.com/${SANDBOX}`,
        `radar:github.com/${SANDBOX}`,
      ]),
    );
    const digest = JSON.parse((await run(clone, env, "--json")).out);
    expect(digest.stale).toBe(false);
    expect(digest.refreshing).toBe(false);
    expect(digest.digest.repo).toBe(SANDBOX);
    const again = JSON.parse((await run(clone, env, "sync", "--json")).out);
    expect(
      again.jobs.every((j: { outcome: string }) => j.outcome === "fresh"),
    ).toBe(true);
  },
  120_000,
);
