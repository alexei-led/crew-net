import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStoreAdapter } from "../adapters/store/index";
import type { StorePort } from "../ports/index";
import { readDeps, readRadar, readSnapshot } from "./files";
import { comment, pull } from "./fixtures/fakes";
import { world as makeWorld, REF, REPO, START } from "./fixtures/world";
import { notificationsCursor } from "./inbox";
import type { AppPorts } from "./ports";
import { DEFAULT_SETTINGS } from "./settings";
import { INTERVALS, runSync } from "./sync";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function world() {
  return makeWorld((clock) => {
    const dir = mkdtempSync(join(tmpdir(), "crew-net-app-"));
    dirs.push(dir);
    return new FileStoreAdapter(dir, clock);
  });
}

/** The same store, except one method throws: a sync killed at that point. */
function crashing(
  ports: AppPorts,
  part: "cursors" | "repos",
  method: string,
  when: (...args: unknown[]) => boolean = () => true,
): AppPorts {
  const real = ports.store[part] as unknown as Record<
    string,
    (...args: unknown[]) => Promise<unknown>
  >;
  const wrapped = {
    ...real,
    [method]: (...args: unknown[]) => {
      if (when(...args)) throw new Error("killed");
      return real[method]?.(...args);
    },
  };
  const store = Object.create(ports.store) as StorePort;
  Object.defineProperty(store, part, { value: wrapped });
  return { ...ports, store };
}

const ASK =
  "<!-- crew-net:msg kind=ask id=k3f9 -->\n\n@me does #2 need the column?";
const thread = (number: number, updatedAt = "2026-11-09T11:59:00Z") => ({
  threadId: String(number),
  repo: REPO,
  kind: "pull" as const,
  number,
  reason: "author" as const,
  updatedAt,
});

describe("inbox job", () => {
  test("a crew ask to me becomes an addressed item, then the cursors move", async () => {
    const w = world();
    w.github.threads = [thread(2)];
    w.github.comments.set(`${REPO}#2`, [comment(2, 11, "maria", ASK)]);
    await w.sync();
    expect(await w.items()).toEqual([
      {
        type: "item",
        id: "comment:github.com/o/r#2:11",
        kind: "message",
        text: "@me does #2 need the column?",
        addressed: true,
        from: "maria",
        repo: REPO,
        thread: 2,
        event: "ask",
      },
    ]);
    expect(await w.store.cursors.get(notificationsCursor("github.com"))).toBe(
      "2026-11-09T12:00:00Z",
    );
  });

  test("the item is written before any cursor: a kill at the first cursor write leaves the item and no cursor", async () => {
    const w = world();
    w.github.threads = [thread(2)];
    w.github.comments.set(`${REPO}#2`, [comment(2, 11, "maria", ASK)]);
    const report = await w.sync(crashing(w.ports, "cursors", "set"));
    expect(report.jobs.find((j) => j.job.startsWith("inbox"))?.outcome).toBe(
      "failed",
    );
    expect(await w.items()).toHaveLength(1);
    expect(
      await w.store.cursors.get(notificationsCursor("github.com")),
    ).toBeUndefined();
    expect(
      await w.store.cursors.get("thread:github.com/o/r#2"),
    ).toBeUndefined();
  });

  test("replay after a kill mid-pass delivers each comment once", async () => {
    const w = world();
    w.github.threads = [thread(2, "2026-11-09T11:58:00Z"), thread(3)];
    w.github.comments.set(`${REPO}#2`, [comment(2, 11, "maria", ASK)]);
    w.github.comments.set(`${REPO}#3`, [comment(3, 12, "dmitri", "looks off")]);
    const real = w.github.listThreadComments.bind(w.github);
    w.github.listThreadComments = async (repo, n, after) => {
      if (n === 3) throw new Error("killed");
      return real(repo, n, after);
    };
    await w.sync();
    expect((await w.items()).map((i) => i.id)).toEqual([
      "comment:github.com/o/r#2:11",
    ]);
    w.github.listThreadComments = real;
    w.advance(INTERVALS.inbox);
    await w.sync();
    expect((await w.items()).map((i) => i.id).sort()).toEqual([
      "comment:github.com/o/r#2:11",
      "comment:github.com/o/r#3:12",
    ]);
    expect(await w.itemEvents()).toHaveLength(2);
  });

  test("a second trigger within the interval is a no-op", async () => {
    const w = world();
    await w.sync();
    const calls = w.github.calls.length;
    const report = await w.sync();
    expect(report.jobs.every((j) => j.outcome === "fresh")).toBe(true);
    expect(w.github.calls.length).toBe(calls);
  });

  test("X-Poll-Interval above 60 s stretches the inbox interval", async () => {
    const w = world();
    w.github.pollIntervalMs = 120_000;
    await w.sync();
    w.advance(90_000);
    const report = await w.sync();
    expect(report.jobs.find((j) => j.job === "inbox:github.com")?.outcome).toBe(
      "fresh",
    );
  });

  test.each([
    ["my own comment", "me", "hello", undefined],
    ["a known bot", "dependabot", "bump", undefined],
    ["a GitHub App", "greptile-apps[bot]", "<!-- summary -->", undefined],
    ["a person", "maria", "nice", { event: "comment", addressed: false }],
    [
      "a malformed marker",
      "maria",
      "<!-- crew-net:msg kind=ask -->\n@me x",
      { event: "comment", addressed: false },
    ],
    [
      "an ask to someone else",
      "maria",
      "<!-- crew-net:msg kind=ask id=abcd -->\n@dmitri x",
      { event: "ask", addressed: false },
    ],
  ])("%s", async (_name, author, body, expected) => {
    const w = world();
    w.github.threads = [thread(2)];
    w.github.comments.set(`${REPO}#2`, [comment(2, 11, author, body)]);
    await w.sync();
    const items = await w.items();
    if (expected === undefined) expect(items).toEqual([]);
    else expect(items[0]).toMatchObject(expected);
  });

  test.each([
    ["accepted", "in-progress"],
    ["done", undefined],
    ["declined", undefined],
    ["answered", undefined],
  ])(
    "a %s reply from the recipient moves my request to %p",
    async (status, after) => {
      const w = world();
      await w.store.outbox.put({
        id: "k3f9",
        repo: "github.com/o/r",
        number: 2,
        to: "maria",
        kind: "review",
        text: "please review",
        createdAtMs: START - 60_000,
        status: "open",
      });
      w.github.threads = [thread(2)];
      w.github.comments.set(`${REPO}#2`, [
        comment(
          2,
          11,
          "maria",
          `<!-- crew-net:msg kind=reply re=k3f9 status=${status} -->\n@me ok`,
        ),
      ]);
      await w.sync();
      expect(
        (await w.store.outbox.list())[0]?.status as string | undefined,
      ).toBe(after);
      expect((await w.items())[0]?.event).toBe("reply");
      const logged = (await w.store.events.read()).find(
        (e) => e.type === "request",
      );
      expect(logged).toMatchObject({
        id: "k3f9",
        outcome: status,
        openMs: 60_000,
      });
    },
  );

  test("a reply from someone else does not touch my request", async () => {
    const w = world();
    await w.store.outbox.put({
      id: "k3f9",
      repo: "github.com/o/r",
      number: 2,
      to: "maria",
      kind: "ask",
      text: "q",
      createdAtMs: START,
      status: "open",
    });
    w.github.threads = [thread(2)];
    w.github.comments.set(`${REPO}#2`, [
      comment(2, 11, "eve", "<!-- crew-net:msg kind=reply re=k3f9 -->\n@me no"),
    ]);
    await w.sync();
    expect(await w.store.outbox.list()).toHaveLength(1);
    expect((await w.items())[0]?.event).toBe("comment");
  });

  test("reviews become items once; empty COMMENTED reviews are skipped", async () => {
    const w = world();
    w.github.threads = [thread(2)];
    const review = (id: number, state: string, body: string, at: string) => ({
      id,
      author: "maria",
      state,
      body,
      submittedAt: at,
      url: "u",
    });
    w.github.reviews.set(`${REPO}#2`, [
      review(1, "APPROVED", "", "2026-11-09T11:50:00Z"),
      review(2, "COMMENTED", "", "2026-11-09T11:51:00Z"),
      review(3, "CHANGES_REQUESTED", "fix x", "2026-11-09T11:52:00Z"),
    ]);
    await w.sync();
    w.advance(INTERVALS.inbox);
    w.github.threads = [thread(2, "2026-11-09T12:00:30Z")];
    await w.sync();
    expect((await w.items()).map((i) => i.text)).toEqual([
      "approved",
      "changes requested: fix x",
    ]);
  });

  test("a rate limit fails the job, keeps the cursor and says until when", async () => {
    const w = world();
    const limited = Object.assign(new Error("GitHub rate limit reached"), {
      name: "RateLimitError",
      retryAfterMs: 120_000,
    });
    w.github.failing.set("notifications", limited);
    const report = await w.sync();
    expect(report.notice).toMatch(/^crew-net: rate-limited until \d\d:\d\d$/);
    expect(
      await w.store.cursors.get(notificationsCursor("github.com")),
    ).toBeUndefined();
  });

  test("an auth failure skips the host's other GitHub jobs", async () => {
    const w = world();
    w.github.failing.set(
      "viewer",
      Object.assign(new Error("GitHub authentication failed"), {
        name: "AuthError",
      }),
    );
    const report = await w.sync();
    expect(report.jobs.find((j) => j.job === "repo:github.com/o/r")).toEqual({
      job: "repo:github.com/o/r",
      outcome: "failed",
      error: "skipped: GitHub auth",
    });
    expect(w.github.calls).not.toContain("listOpenPulls o/r");
  });
});

describe("repo state and scope", () => {
  test("open PRs are stored with their parsed state blocks", async () => {
    const w = world();
    w.github.open.set(REPO, [
      pull(4, "maria", "feat/x", {
        body: "<!-- crew-net\nstate: building\nscope: api/\ndepends-on: #3\n-->",
      }),
    ]);
    await w.sync();
    expect((await readSnapshot(w.store, REF))?.pulls[0]).toMatchObject({
      number: 4,
      state: "building",
      scope: ["api/"],
      dependsOn: ["#3"],
    });
  });

  test("a live session's repo is active; a repo seen 14+ days ago is dropped; muted repos are skipped", async () => {
    const w = world();
    await w.store.sessions.beat({
      sessionId: "s1",
      pid: 1,
      harness: "claude",
      role: "lead",
      worktree: "/work/a",
      repo: "github.com/o/a",
    });
    await w.store.kv.set("watched", {
      "github.com/o/old": START - 15 * 24 * 3600_000,
      "github.com/o/w": START - 3600_000,
      "github.com/o/muted": START,
    });
    const ports = {
      ...w.ports,
      settings: { ...DEFAULT_SETTINGS, mute: ["o/muted"] },
    };
    await runSync(ports);
    expect(w.github.calls.filter((c) => c.startsWith("listOpenPulls"))).toEqual(
      ["listOpenPulls o/a", "listOpenPulls o/w"],
    );
  });
});

describe("fetch and radar", () => {
  async function seeded() {
    const w = world();
    w.git.local("feat/mine", ["api/users.yaml", "api/server.ts"]);
    w.github.open.set(REPO, [
      pull(7, "me", "feat/mine"),
      pull(8, "maria", "feat/maria"),
    ]);
    w.git.remote("feat/mine", ["api/users.yaml", "api/server.ts"]);
    w.git.remote("feat/maria", ["api/users.yaml", "web/a.ts"]);
    w.git.conflicts.set("refs/heads/feat/mine|refs/remotes/origin/feat/maria", [
      "api/users.yaml",
    ]);
    return w;
  }

  test("a conflict with someone's PR becomes a finding item and radar.json", async () => {
    const w = await seeded();
    await w.sync();
    expect(w.git.fetches).toBe(1);
    const radar = await readRadar(w.store, REF);
    expect(radar?.findings.map((f) => f.kind)).toEqual(["conflict"]);
    expect(await w.items()).toEqual([
      expect.objectContaining({
        kind: "finding",
        event: "conflict",
        from: "maria",
        thread: 7,
        text: "⚠ #7 conflicts with maria #8: api/users.yaml",
      }),
    ]);
  });

  test("a finding is reported once, and again when its file set changes", async () => {
    const w = await seeded();
    await w.sync();
    w.advance(INTERVALS.radar);
    await w.sync();
    expect(await w.items()).toHaveLength(1);
    w.git.conflicts.set("refs/heads/feat/mine|refs/remotes/origin/feat/maria", [
      "api/server.ts",
      "api/users.yaml",
    ]);
    w.git.diffs.set("origin/main...refs/remotes/origin/feat/maria", [
      "api/users.yaml",
      "api/server.ts",
    ]);
    w.advance(INTERVALS.radar);
    await w.sync();
    expect(await w.items()).toHaveLength(2);
  });

  test("items are written before radar.json: a kill there re-reports nothing twice", async () => {
    const w = await seeded();
    await w.sync(
      crashing(w.ports, "repos", "write", (_ref, file) => file === "radar"),
    );
    expect(await w.items()).toHaveLength(1);
    expect(await readRadar(w.store, REF)).toBeUndefined();
    w.advance(INTERVALS.radar);
    await w.sync();
    expect(await w.itemEvents()).toHaveLength(1);
    expect(await readRadar(w.store, REF)).toBeDefined();
  });

  test("merge-tree runs only for pairs that share a file", async () => {
    const w = await seeded();
    w.git.remote("feat/other", ["docs/x.md"], { loginHint: "dmitri" });
    await w.sync();
    expect(w.git.mergeTrees).toEqual([
      "refs/heads/feat/mine|refs/remotes/origin/feat/maria",
    ]);
  });

  test("recent bare branches count, with the commit login as owner; old ones do not", async () => {
    const w = world();
    w.git.local("feat/mine", ["web/a.ts"]);
    w.git.remote("dmitri/x", ["web/a.ts"], {
      loginHint: "dmitri",
      lastCommitAt: "2026-11-09T11:00:00Z",
    });
    w.git.remote("old/y", ["web/a.ts"], {
      loginHint: "olga",
      lastCommitAt: "2026-11-01T11:00:00Z",
    });
    await w.sync();
    const radar = await readRadar(w.store, REF);
    expect(radar?.findings.map((f) => `${f.kind} ${f.other.owner}`)).toEqual([
      "overlap dmitri",
    ]);
    expect(radar?.work.find((x) => x.owner === "dmitri")?.pushedAtMs).toBe(
      Date.parse("2026-11-09T11:00:00Z"),
    );
  });

  test("a PR merged after my fork point that touches my files is stale", async () => {
    const w = world();
    w.git.local("feat/mine", ["api/server.ts"]);
    w.git.landedCommits.set(
      "fork(refs/heads/feat/mine,origin/main)..origin/main",
      [
        {
          sha: "a",
          subject: "feat: users (#5)",
          authorEmail: "5+maria@users.noreply.github.com",
          loginHint: "maria",
          paths: ["api/server.ts"],
        },
        {
          sha: "b",
          subject: "direct push",
          authorEmail: "x@y.z",
          loginHint: null,
          paths: ["api/server.ts"],
        },
      ],
    );
    await w.sync();
    expect((await w.items()).map((i) => i.text)).toEqual([
      "rebase feat/mine: maria #5 touched api/server.ts",
    ]);
  });

  test("the repo config adds contracts: an order finding across the contract", async () => {
    const w = world();
    w.git.files.set(
      "origin/HEAD:.github/crew-net.yml",
      "contracts:\n  - name: api\n    producer: [api/openapi/**]\n    consumers: [web/**]\n",
    );
    w.git.local("feat/mine", ["web/client.ts"]);
    w.github.open.set(REPO, [pull(8, "maria", "feat/api")]);
    w.git.remote("feat/api", ["api/openapi/users.yaml"]);
    await w.sync();
    expect((await readRadar(w.store, REF))?.findings).toEqual([
      expect.objectContaining({
        kind: "order",
        contract: "api",
        producer: "other",
      }),
    ]);
  });
});

describe("dependencies", () => {
  async function blocked() {
    const w = world();
    w.github.open.set(REPO, [
      pull(10, "me", "feat/b", {
        body: "<!-- crew-net\ndepends-on: #9\n-->",
        autoMerge: true,
      }),
    ]);
    w.github.pulls.set(`${REPO}#9`, pull(9, "maria", "feat/a"));
    await w.sync();
    return w;
  }

  test("auto-merge is turned off while a dependency is open, and the owner is told", async () => {
    const w = await blocked();
    expect(w.github.autoMergeOff).toEqual([`${REPO}#10`]);
    expect((await w.items()).map((i) => i.event)).toEqual(["auto-merge-off"]);
    expect((await readDeps(w.store)).prs[`${REPO}#10`]).toEqual({
      deps: { [`${REPO}#9`]: "open" },
      blocked: true,
    });
  });

  test("the job polls every minute while blocked, then says unblocked once", async () => {
    const w = await blocked();
    w.github.open.set(REPO, [
      pull(10, "me", "feat/b", { body: "<!-- crew-net\ndepends-on: #9\n-->" }),
    ]);
    w.github.pulls.set(
      `${REPO}#9`,
      pull(9, "maria", "feat/a", { state: "closed", merged: true }),
    );
    w.advance(INTERVALS.depsBlocked);
    await w.sync();
    w.advance(INTERVALS.deps);
    await w.sync();
    expect((await w.items()).map((i) => i.event).sort()).toEqual([
      "auto-merge-off",
      "unblocked",
    ]);
  });

  test("a dependency closed without merge is reported once", async () => {
    const w = await blocked();
    w.github.pulls.set(
      `${REPO}#9`,
      pull(9, "maria", "feat/a", { state: "closed" }),
    );
    for (let i = 0; i < 2; i++) {
      w.advance(INTERVALS.deps);
      await w.sync();
    }
    const closed = (await w.items()).filter(
      (i) => i.event === "dependency-closed",
    );
    expect(closed.map((i) => i.text)).toEqual([
      "#10 depends on #9, which was closed without merging",
    ]);
  });

  test("someone's PR that waits on mine is announced once", async () => {
    const w = world();
    w.github.open.set(REPO, [
      pull(10, "me", "feat/b"),
      pull(11, "maria", "feat/c", {
        body: "<!-- crew-net\ndepends-on: o/r#10\n-->",
      }),
    ]);
    await w.sync();
    w.advance(INTERVALS.deps);
    await w.sync();
    expect(await w.items()).toEqual([
      expect.objectContaining({
        event: "waits-on-you",
        from: "maria",
        thread: 10,
        text: "#11 (maria) waits on your #10",
      }),
    ]);
  });
});
