import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileStoreAdapter } from "../adapters/store/index";
import type { StorePort } from "../ports/index";
import { buildDigest } from "./digest";
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
        msgId: "k3f9",
      },
    ]);
    expect(await w.store.cursors.get(notificationsCursor("github.com"))).toBe(
      "2026-11-09T11:59:00Z",
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

  test("a thread that keeps failing is given up after 3 passes; others still arrive", async () => {
    const w = world();
    w.github.threads = [thread(2, "2026-11-09T11:58:00Z"), thread(3)];
    w.github.comments.set(`${REPO}#3`, [comment(3, 12, "dmitri", "hi")]);
    const real = w.github.listThreadComments.bind(w.github);
    w.github.listThreadComments = async (repo, n, after) => {
      if (n === 2) throw new Error("HTTP 404");
      return real(repo, n, after);
    };
    const cursor = () => w.store.cursors.get(notificationsCursor("github.com"));
    await w.sync();
    expect((await w.items()).map((i) => i.id)).toEqual([
      "comment:github.com/o/r#3:12",
    ]);
    expect(await cursor()).toBe("2026-11-09T11:57:59Z");
    for (let i = 0; i < 2; i++) {
      w.advance(INTERVALS.inbox);
      await w.sync();
    }
    expect(await cursor()).toBe("2026-11-09T11:59:00Z");
    expect(
      (await w.store.events.read()).filter((e) => e.type === "sync-error"),
    ).toHaveLength(3);
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

  test("an accepted reply does not bring back a request closed meanwhile", async () => {
    const w = world();
    await w.store.outbox.put({
      id: "k3f9",
      repo: "github.com/o/r",
      number: 2,
      to: "maria",
      kind: "review",
      text: "please review",
      createdAtMs: START,
      status: "open",
    });
    w.github.threads = [thread(2)];
    w.github.comments.set(`${REPO}#2`, [
      comment(
        2,
        11,
        "maria",
        "<!-- crew-net:msg kind=reply re=k3f9 status=accepted -->\n@me ok",
      ),
    ]);
    // The repo job closes the request right after the inbox job read it.
    const list = w.store.outbox.list.bind(w.store.outbox);
    let reads = 0;
    w.store.outbox.list = async () => {
      const all = await list();
      if (++reads === 1) await w.store.outbox.remove("k3f9");
      return all;
    };
    await w.sync();
    w.store.outbox.list = list;
    expect(await w.store.outbox.list()).toEqual([]);
  });

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

  test("a review delivered and pruned weeks ago does not arrive again", async () => {
    const w = world();
    w.github.threads = [thread(2)];
    w.github.reviews.set(`${REPO}#2`, [
      {
        id: 3,
        author: "maria",
        state: "CHANGES_REQUESTED",
        body: "fix x",
        submittedAt: "2026-11-09T11:52:00Z",
        url: "u",
      },
    ]);
    await w.sync();
    const [first] = await w.items();
    await w.store.delivered.claim(first?.id ?? "", "s1");
    w.advance(15 * 24 * 60 * 60_000);
    await w.sync();
    expect(await w.items()).toEqual([]);
    w.advance(INTERVALS.inbox);
    w.github.threads = [thread(2, "2026-11-24T12:00:00Z")];
    await w.sync();
    expect(await w.items()).toEqual([]);
    expect(await w.itemEvents()).toHaveLength(1);
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

describe("request lifecycle", () => {
  const request = (id: string, number: number, repo = "github.com/o/r") => ({
    id,
    repo,
    number,
    to: "maria",
    kind: "review",
    text: "please review",
    createdAtMs: START - 60_000,
    status: "open" as const,
  });

  test.each([
    ["merged", "#2 merged"],
    ["closed", "#2 was closed"],
  ] as const)(
    "a request whose thread is %s leaves the outbox and shows once in the digest",
    async (state, why) => {
      const w = world();
      await w.store.outbox.put(request("k1", 2));
      w.github.states.set(`${REPO}#2`, state);
      await w.sync();
      expect(await w.store.outbox.list()).toEqual([]);
      const id = "request-closed:github.com/o/r#2:k1";
      expect(await w.items()).toEqual([
        expect.objectContaining({
          id,
          kind: "message",
          event: "request-closed",
          repo: REPO,
          thread: 2,
          text: `your review to maria on #2 is closed: ${why}`,
        }),
      ]);
      expect(
        (await w.store.events.read()).find((e) => e.type === "request"),
      ).toMatchObject({ id: "k1", outcome: `thread-${state}`, openMs: 60_000 });
      const shown = async () =>
        (await buildDigest(w.ports, REF, "main")).text.includes("is closed:");
      expect(await shown()).toBe(true);
      await w.store.delivered.claim(id, "s1");
      expect(await shown()).toBe(false);
    },
  );

  test("only threads that are not open PRs are read; open ones and other repos' keep their requests", async () => {
    const w = world();
    w.github.open.set(REPO, [pull(2, "maria", "feat/x")]);
    await w.store.outbox.put(request("k1", 2));
    await w.store.outbox.put(request("k2", 5));
    await w.store.outbox.put(request("k3", 1, "github.com/o/web"));
    await w.sync();
    expect((await w.store.outbox.list()).map((r) => r.id).sort()).toEqual([
      "k1",
      "k2",
      "k3",
    ]);
    expect(w.github.calls.filter((c) => c.startsWith("threadState"))).toEqual([
      "threadState o/r#5",
    ]);
  });

  test("a thread that cannot be read keeps its request and the snapshot", async () => {
    const w = world();
    await w.store.outbox.put(request("k1", 5));
    w.github.failing.set("threadState", new Error("socket hang up"));
    await w.sync();
    expect(await w.store.outbox.list()).toHaveLength(1);
    expect(await readSnapshot(w.store, REF)).toBeDefined();
  });

  test.each([404, 410])(
    "a thread gone with %d closes its request",
    async (status) => {
      const w = world();
      await w.store.outbox.put(request("k1", 5));
      w.github.failing.set(
        "threadState",
        Object.assign(new Error(`HTTP ${status}`), { status }),
      );
      await w.sync();
      expect(await w.store.outbox.list()).toEqual([]);
      expect((await w.items())[0]?.text).toBe(
        "your review to maria on #5 is closed: #5 is gone",
      );
    },
  );

  test("a rate limit on a thread fails the job with the notice and keeps the request", async () => {
    const w = world();
    await w.store.outbox.put(request("k1", 5));
    await w.store.outbox.put(request("k2", 6));
    w.github.failing.set(
      "threadState",
      Object.assign(new Error("GitHub rate limit reached"), {
        name: "RateLimitError",
        retryAfterMs: 120_000,
      }),
    );
    const report = await w.sync();
    expect(report.notice).toMatch(/^crew-net: rate-limited until/);
    expect(
      w.github.calls.filter((c) => c.startsWith("threadState")),
    ).toHaveLength(1);
    expect(await w.store.outbox.list()).toHaveLength(2);
  });

  test("a kill after the item is written closes the request once on the next pass", async () => {
    const w = world();
    await w.store.outbox.put(request("k1", 2));
    w.github.states.set(`${REPO}#2`, "closed");
    const remove = w.store.outbox.remove.bind(w.store.outbox);
    w.store.outbox.remove = async () => {
      throw new Error("killed");
    };
    await w.sync();
    w.store.outbox.remove = remove;
    expect(await w.store.outbox.list()).toHaveLength(1);
    w.advance(INTERVALS.repoActive);
    await w.sync();
    expect(await w.store.outbox.list()).toEqual([]);
    expect(await w.itemEvents()).toHaveLength(1);
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

  test("a colleague's bare branch I checked out is not compared with itself", async () => {
    const w = world();
    w.git.local("maria-x", ["web/a.ts"]);
    w.git.remote("maria-x", ["web/a.ts"], { loginHint: "maria" });
    await w.sync();
    expect((await readRadar(w.store, REF))?.findings).toEqual([]);
  });

  test("a fork PR is not matched to a same-named origin branch", async () => {
    const w = world();
    w.git.local("feat/mine", ["api/x.ts"]);
    w.github.open.set(REPO, [pull(9, "alice", "dev", { headRepo: "alice/r" })]);
    w.git.remote("dev", ["api/x.ts"], { loginHint: "dmitri" });
    await w.sync();
    const radar = await readRadar(w.store, REF);
    expect(
      radar?.work
        .filter((x) => !x.mine)
        .map((x) => `${x.owner} ${x.pr ?? x.branch}`),
    ).toEqual(["dmitri dev"]);
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

  test("a squash-merged branch nobody deleted is not bare work", async () => {
    const w = world();
    w.git.local("feat/mine", ["web/a.ts"]);
    w.git.remote("dmitri/merged", ["web/a.ts"], {
      loginHint: "dmitri",
      lastCommitAt: "2026-11-09T11:00:00Z",
      merged: true,
    });
    w.git.remote("dmitri/open", ["web/a.ts"], {
      loginHint: "dmitri",
      lastCommitAt: "2026-11-09T11:00:00Z",
    });
    await w.sync();
    const radar = await readRadar(w.store, REF);
    expect(radar?.work.map((x) => x.branch)).toEqual([
      "feat/mine",
      "dmitri/open",
    ]);
    expect(radar?.findings.map((f) => f.other.branch)).toEqual(["dmitri/open"]);
  });

  test("a failing content check keeps the bare branch and the pass", async () => {
    const w = world();
    w.git.local("feat/mine", ["web/a.ts"]);
    w.git.remote("dmitri/x", ["web/a.ts"], {
      loginHint: "dmitri",
      lastCommitAt: "2026-11-09T11:00:00Z",
    });
    w.git.sameContent = async () => {
      throw new Error("git timed out");
    };
    const report = await w.sync();
    expect(report.jobs.find((j) => j.job.startsWith("radar"))?.outcome).toBe(
      "ran",
    );
    expect(
      (await readRadar(w.store, REF))?.findings.map((f) => f.other.branch),
    ).toEqual(["dmitri/x"]);
  });

  test("bare branches are diffed against the default branch GitHub names, read once a day", async () => {
    const w = world();
    w.github.defaults.set(REPO, "dev");
    w.git.local("feat/mine", ["web/a.ts"], "dev");
    w.git.remote("dmitri/x", ["web/a.ts"], {
      loginHint: "dmitri",
      base: "dev",
    });
    await w.sync();
    expect(
      (await readRadar(w.store, REF))?.findings.map(
        (f) => `${f.kind} ${f.other.branch} ${f.mine.branch}`,
      ),
    ).toEqual(["overlap dmitri/x feat/mine"]);
    w.advance(INTERVALS.radar);
    await w.sync();
    expect(w.github.calls.filter((c) => c.startsWith("defaultBranch"))).toEqual(
      ["defaultBranch o/r"],
    );
  });

  test("the repo config is read from the default branch GitHub names", async () => {
    const w = world();
    w.github.defaults.set(REPO, "dev");
    w.git.files.set(
      "origin/dev:.github/crew-net.yml",
      "contracts:\n  - name: api\n    producer: [api/openapi/**]\n    consumers: [web/**]\n",
    );
    w.git.local("feat/mine", ["web/client.ts"], "dev");
    w.github.open.set(REPO, [pull(8, "maria", "feat/api", { baseRef: "dev" })]);
    w.git.remote("feat/api", ["api/openapi/users.yaml"], { base: "dev" });
    await w.sync();
    expect(
      (await readRadar(w.store, REF))?.findings.map((f) => f.contract),
    ).toEqual(["api"]);
  });

  test("the default branch: re-read after a day, the last known one when GitHub fails, the radar fails with none", async () => {
    const w = world();
    w.github.defaults.set(REPO, "dev");
    await w.sync();
    w.github.failing.set("defaultBranch", new Error("offline"));
    w.advance(24 * 60 * 60 * 1000);
    const stale = await w.sync();
    expect(stale.jobs.find((j) => j.job.startsWith("radar:"))?.outcome).toBe(
      "ran",
    );
    expect(
      w.github.calls.filter((c) => c.startsWith("defaultBranch")),
    ).toHaveLength(2);
    const fresh = world();
    fresh.github.failing.set("defaultBranch", new Error("offline"));
    const report = await fresh.sync();
    expect(report.jobs.find((j) => j.job.startsWith("radar:"))).toMatchObject({
      outcome: "failed",
      error: "offline",
    });
  });

  test("a bare branch I merged main into is still its author's work", async () => {
    const w = world();
    w.git.local("feat/mine", ["web/a.ts"]);
    // The tip is my merge commit; the branch's own commits are maria's.
    w.git.remote("maria/x", ["web/a.ts"], {
      authorEmail: "9+me@users.noreply.github.com",
      loginHint: "me",
    });
    w.git.authors.set("origin/main..refs/remotes/origin/maria/x", {
      authorEmail: "5+maria@users.noreply.github.com",
      loginHint: "maria",
    });
    await w.sync();
    expect(
      (await readRadar(w.store, REF))?.findings.map(
        (f) => `${f.kind} ${f.other.owner}`,
      ),
    ).toEqual(["overlap maria"]);
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

describe("cross-repo contracts", () => {
  const CONFIG =
    'contracts:\n  - name: api\n    producer: [api/openapi/**]\n    consumers: ["o/web:clients/r/**"]\n';

  async function producing() {
    const w = world();
    w.git.files.set("origin/HEAD:.github/crew-net.yml", CONFIG);
    w.git.local("feat/mine", ["api/openapi/users.yaml"]);
    w.github.open.set(REPO, [pull(7, "me", "feat/mine")]);
    w.github.open.set("o/web", [
      pull(3, "dmitri", "feat/client"),
      pull(4, "olga", "docs"),
      pull(5, "me", "feat/mine-web"),
    ]);
    w.github.files.set("o/web#3", ["clients/r/users.ts"]);
    w.github.files.set("o/web#4", ["docs/x.md"]);
    return w;
  }

  test("my producer change and a consumer PR in a watched repo without a clone make an order finding", async () => {
    const w = await producing();
    await w.store.kv.set("watched", { "github.com/o/web": START });
    await w.sync();
    expect((await readRadar(w.store, REF))?.findings).toEqual([
      expect.objectContaining({
        kind: "order",
        contract: "api",
        producer: "mine",
        mine: expect.objectContaining({ repo: REPO, pr: 7 }),
        other: expect.objectContaining({
          repo: "o/web",
          owner: "dmitri",
          pr: 3,
        }),
        paths: ["api/openapi/users.yaml", "clients/r/users.ts"],
      }),
    ]);
    expect((await w.items()).map((i) => i.text)).toEqual([
      "order: #7 changes api, dmitri o/web#3 uses it. Add depends-on?",
    ]);
    expect(
      w.github.calls.filter((c) => c.startsWith("listPullFiles")).sort(),
    ).toEqual(["listPullFiles o/web#3", "listPullFiles o/web#4"]);
  });

  test("bot PRs are never read; unchanged PRs are read once; a failed read is logged", async () => {
    const w = await producing();
    await w.store.kv.set("watched", { "github.com/o/web": START });
    w.github.open.set("o/web", [
      pull(3, "dmitri", "feat/client"),
      pull(6, "renovate[bot]", "deps"),
      pull(7, "olga", "feat/broken"),
    ]);
    w.github.failing.set("listPullFiles", new Error("boom"));
    await w.sync();
    expect(
      (await w.store.events.read()).filter(
        (e) => e.type === "sync-error" && e.job === "radar:github.com/o/r",
      ),
    ).toHaveLength(2);
    w.github.failing.delete("listPullFiles");
    w.github.files.set("o/web#7", ["docs/y.md"]);
    w.advance(INTERVALS.radar);
    await w.sync();
    w.advance(INTERVALS.radar);
    await w.sync();
    expect(
      w.github.calls.filter((c) => c.startsWith("listPullFiles")).sort(),
    ).toEqual([
      "listPullFiles o/web#3",
      "listPullFiles o/web#3",
      "listPullFiles o/web#7",
      "listPullFiles o/web#7",
    ]);
    expect((await readRadar(w.store, REF))?.findings).toHaveLength(1);
  });

  test("without a producer change of mine, the consumer repo's files are not read", async () => {
    const w = await producing();
    await w.store.kv.set("watched", { "github.com/o/web": START });
    w.git.worktrees = [];
    w.git.local("feat/mine", ["web/x.ts"]);
    await w.sync();
    expect(w.github.calls.filter((c) => c.startsWith("listPullFiles"))).toEqual(
      [],
    );
  });

  test("a consumer named in another case still matches", async () => {
    const w = await producing();
    w.git.files.set(
      "origin/HEAD:.github/crew-net.yml",
      CONFIG.replace("o/web:", "O/Web:"),
    );
    await w.store.kv.set("watched", { "github.com/o/web": START });
    await w.sync();
    expect((await readRadar(w.store, REF))?.findings).toHaveLength(1);
  });

  test("a consumer repo that is not watched is never read", async () => {
    const w = await producing();
    await w.sync();
    expect((await readRadar(w.store, REF))?.findings).toEqual([]);
    expect(w.github.calls.filter((c) => c.includes("o/web"))).toEqual([]);
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

  test("a refused auto-merge change is logged and the other PRs still get their items", async () => {
    const w = world();
    w.github.open.set(REPO, [
      pull(10, "me", "feat/b", {
        body: "<!-- crew-net\ndepends-on: #9\n-->",
        autoMerge: true,
      }),
      pull(11, "me", "feat/c", { body: "<!-- crew-net\ndepends-on: #8\n-->" }),
    ]);
    w.github.pulls.set(`${REPO}#9`, pull(9, "maria", "feat/a"));
    w.github.pulls.set(
      `${REPO}#8`,
      pull(8, "maria", "feat/z", { state: "closed" }),
    );
    w.github.failing.set("disableAutoMerge", new Error("forbidden"));
    const report = await w.sync();
    expect(report.jobs.find((j) => j.job === "deps")?.outcome).toBe("ran");
    expect((await w.items()).map((i) => i.event)).toEqual([
      "dependency-closed",
    ]);
    expect(Object.keys((await readDeps(w.store)).prs).sort()).toEqual([
      `${REPO}#10`,
      `${REPO}#11`,
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

describe("store maintenance", () => {
  const DAY = 24 * 60 * 60_000;
  const item = (id: string) => ({
    type: "item" as const,
    id,
    kind: "message" as const,
    text: "hi",
    addressed: false,
    from: "maria",
    repo: REPO,
    thread: 2,
  });

  test("sync prunes items delivered more than 14 days ago, once a day", async () => {
    const w = world();
    await w.store.inbox.put(item("old"));
    await w.store.delivered.claim("old", "s1");
    w.advance(10 * DAY);
    await w.store.inbox.put(item("recent"));
    await w.store.delivered.claim("recent", "s1");
    await w.store.inbox.put(item("unclaimed"));
    w.advance(5 * DAY);
    const report = await w.sync();
    expect(report.jobs).toContainEqual({ job: "prune", outcome: "ran" });
    expect((await w.items()).map((i) => i.id).sort()).toEqual([
      "recent",
      "unclaimed",
    ]);
    w.advance(DAY - 1);
    expect((await w.sync()).jobs).toContainEqual({
      job: "prune",
      outcome: "fresh",
    });
  });
});
