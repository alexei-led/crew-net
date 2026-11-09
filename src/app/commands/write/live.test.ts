import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesAdapter } from "../../../adapters/files/index";
import { GitHubAdapter } from "../../../adapters/github/index";
import { FileStoreAdapter } from "../../../adapters/store/index";
import { FakeGit } from "./fixtures/fakes";
import {
  ask,
  CommandError,
  dep,
  gate,
  reply,
  state,
  type WriteContext,
} from "./index";

// Opt-in: CREW_NET_LIVE=1 bun test src/app/commands/write/live.test.ts
// Writes only to alexei-led/crew-net-sandbox: two draft PRs on fixed
// branches (created once, reused), comments, and PR bodies it restores.
const LIVE = process.env.CREW_NET_LIVE === "1";
setDefaultTimeout(60_000);
const SANDBOX = "alexei-led/crew-net-sandbox";
/** A login that must not exist, so a mention notifies nobody. */
const PEER = "crew-net-sandbox-peer";
const BRANCHES = ["crew-net-live-a", "crew-net-live-b"] as const;

const gh = (...args: string[]): string =>
  execFileSync("gh", args, { encoding: "utf8" }).trim();
const api = (...args: string[]) => JSON.parse(gh("api", ...args));

/** The open PR for `branch`, created as a draft with one file when missing. */
function ensurePr(branch: string): number {
  const open = api(
    `repos/${SANDBOX}/pulls?state=open&head=alexei-led:${branch}`,
  ) as { number: number }[];
  if (open[0]) return open[0].number;
  const hasBranch = (
    api(`repos/${SANDBOX}/branches?per_page=100`) as { name: string }[]
  ).some((x) => x.name === branch);
  if (!hasBranch) {
    const main = api(`repos/${SANDBOX}/git/ref/heads/main`).object.sha;
    gh(
      "api",
      "-X",
      "POST",
      `repos/${SANDBOX}/git/refs`,
      "-f",
      `ref=refs/heads/${branch}`,
      "-f",
      `sha=${main}`,
    );
    gh(
      "api",
      "-X",
      "PUT",
      `repos/${SANDBOX}/contents/live/${branch}.txt`,
      "-f",
      "message=live test file",
      "-f",
      `content=${btoa(branch)}`,
      "-f",
      `branch=${branch}`,
    );
  }
  return api(
    "-X",
    "POST",
    `repos/${SANDBOX}/pulls`,
    "-f",
    `head=${branch}`,
    "-f",
    "base=main",
    "-f",
    `title=crew-net live test ${branch}`,
    "-f",
    "body=Live test PR for crew-net write commands.",
    "-F",
    "draft=true",
  ).number;
}

describe.skipIf(!LIVE)("live sandbox write commands", () => {
  let dir = "";
  let ctx: WriteContext;
  let a: number;
  let b: number;
  const bodies = new Map<number, string>();
  const comments: number[] = [];

  beforeAll(() => {
    expect(() => gh("api", `users/${PEER}`)).toThrow();
    [a, b] = BRANCHES.map(ensurePr) as [number, number];
    for (const n of [a, b])
      bodies.set(n, api(`repos/${SANDBOX}/pulls/${n}`).body ?? "");
    dir = mkdtempSync(join(tmpdir(), "crew-live-"));
    const clock = { now: () => Date.now() };
    const store = new FileStoreAdapter(join(dir, "state"), clock);
    let n = 0;
    ctx = {
      github: new GitHubAdapter({
        host: "github.com",
        tokenProvider: async () => gh("auth", "token"),
        kv: store.kv,
      }),
      githubFor: (host) => {
        throw new Error(`no token for ${host}`);
      },
      git: new FakeGit([{ path: dir, branch: BRANCHES[0] }]),
      store,
      files: new FilesAdapter(),
      clock,
      host: "github.com",
      repo: SANDBOX,
      cwd: dir,
      newId: () => `lv${Date.now().toString(36).slice(-5)}${n++}`,
    };
  });

  afterAll(() => {
    for (const [n, body] of bodies)
      gh(
        "api",
        "-X",
        "PATCH",
        `repos/${SANDBOX}/pulls/${n}`,
        "-f",
        `body=${body}`,
      );
    for (const id of comments)
      gh("api", "-X", "DELETE", `repos/${SANDBOX}/issues/comments/${id}`);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  const lastComment = (n: number) => {
    const all = api(`repos/${SANDBOX}/issues/${n}/comments?per_page=100`) as {
      id: number;
      body: string;
    }[];
    const last = all.at(-1);
    if (last) comments.push(last.id);
    return last?.body ?? "";
  };

  test("state writes the block once; a keyword is refused", async () => {
    const first = await state(ctx, { state: "building", scope: ["live/"] });
    expect(first).toMatchObject({ number: a, changed: true });
    expect(
      await state(ctx, { state: "building", scope: ["live/"] }),
    ).toMatchObject({ changed: false });
    await expect(
      state(ctx, { state: "building", scope: ["fixes #1"] }),
    ).rejects.toBeInstanceOf(CommandError);
    expect(api(`repos/${SANDBOX}/pulls/${a}`).body).toContain(
      "<!-- crew-net\nstate: building\nscope: live/\n-->",
    );
  });

  test("dep add blocks the gate; dep rm lets it through", async () => {
    await dep(ctx, { action: "add", ref: `#${b}` });
    const denied = await gate(ctx, { argv: [`gh pr merge ${a} --squash`] });
    expect(denied).toMatchObject({
      decision: "deny",
      reasons: [`${SANDBOX}#${a}: depends-on #${b} is not merged`],
    });
    const auto = await gate(ctx, { argv: ["gh pr merge --auto"] });
    expect(auto.decision).toBe("deny");
    await dep(ctx, { action: "rm", ref: `#${b}` });
    expect(await gate(ctx, { argv: [`gh pr merge ${a}`] })).toMatchObject({
      decision: "allow",
      checked: [`${SANDBOX}#${a}`],
    });
  });

  test("ask posts a marked comment; reply answers it", async () => {
    const sent = await ask(ctx, {
      target: `@${PEER}`,
      on: `#${a}`,
      text: "live test: does this thread work?",
    });
    expect(lastComment(a)).toBe(
      `<!-- crew-net:msg kind=ask id=${sent.id} -->\n\n@${PEER} live test: does this thread work?`,
    );
    await ctx.store.inbox.put({
      type: "item",
      id: "live-1",
      kind: "message",
      text: "q",
      addressed: true,
      from: PEER,
      repo: SANDBOX,
      thread: a,
      event: "ask",
      msgId: sent.id,
    });
    await reply(ctx, {
      item: "live-1",
      text: "live test: yes",
      status: "done",
    });
    expect(lastComment(a)).toBe(
      `<!-- crew-net:msg kind=reply re=${sent.id} status=done -->\n\n@${PEER} live test: yes`,
    );
  });
});
