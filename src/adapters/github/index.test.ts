import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import type { JsonValue, StorePort } from "../../ports/index";
import comments from "./fixtures/comments.json";
import pulls from "./fixtures/pulls.json";
import recorded from "./fixtures/recorded.json";
import {
  AuthError,
  apiUrls,
  BudgetError,
  type Fetch,
  GitHubAdapter,
  GitHubResponseError,
  RateLimitError,
  SsoError,
  WRITE_WINDOWS,
} from "./index";

const API = "https://api.github.com";
const REPO = "alexei-led/crew-net-sandbox";
const REPO_URL = `${API}/repos/${REPO}`;

/** The store's cross-process KV, as every sync process on the laptop shares it. */
type Kv = StorePort["kv"];

class FakeKv implements Kv {
  readonly values = new Map<string, JsonValue>();
  async get(key: string) {
    return this.values.get(key);
  }
  async set(key: string, value: JsonValue) {
    this.values.set(key, value);
  }
  async update(key: string, fn: (current: JsonValue | undefined) => JsonValue) {
    const value = fn(this.values.get(key));
    this.values.set(key, value);
    return value;
  }
  writes(host = "github.com"): unknown[] {
    const log = this.values.get(`github:writes:${host}`);
    return Array.isArray(log) ? log : [];
  }
}

interface Call {
  url: string;
  init: RequestInit;
}

function setup(
  responses: Response[],
  extra: Partial<ConstructorParameters<typeof GitHubAdapter>[0]> = {},
) {
  const calls: Call[] = [];
  const fetch: Fetch = async (url, init) => {
    calls.push({ url, init });
    const response = responses.shift();
    if (!response) throw new Error(`Unexpected HTTP request ${url}`);
    return response;
  };
  const kv = new FakeKv();
  const adapter = new GitHubAdapter({
    host: "github.com",
    tokenProvider: async () => "test-token",
    kv,
    fetch,
    ...extra,
  });
  return { adapter, calls, kv: (extra.kv as FakeKv | undefined) ?? kv };
}

const json = (value: unknown, headers?: HeadersInit) =>
  Response.json(value, headers === undefined ? {} : { headers });

const replay = (r: {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}) =>
  new Response(r.status === 304 ? null : JSON.stringify(r.body), {
    status: r.status,
    headers: r.headers,
  });

const header = (call: Call | undefined, name: string) =>
  new Headers(call?.init.headers).get(name);

async function caught(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected a rejection");
}

describe("notifications", () => {
  test("recorded poll keeps crew reasons, then a 304 replays the cached threads", async () => {
    const { adapter, calls } = setup([
      replay(recorded.notifications),
      replay(recorded.notificationsNotModified),
    ]);
    const first = await adapter.notifications("2026-11-01T00:00:00Z");
    expect(first.modified).toBe(true);
    expect(first.pollIntervalMs).toBe(60_000);
    expect(first.threads).toEqual([
      {
        threadId: "1000",
        repo: REPO,
        kind: "pull",
        number: 375,
        reason: "author",
        updatedAt: "2026-11-09T09:01:44Z",
      },
      {
        threadId: "1001",
        repo: REPO,
        kind: "pull",
        number: 374,
        reason: "author",
        updatedAt: "2026-11-09T08:51:51Z",
      },
      {
        threadId: "1003",
        repo: REPO,
        kind: "pull",
        number: 408,
        reason: "review_requested",
        updatedAt: "2026-11-09T03:22:20Z",
      },
    ]);
    const query = new URL(calls[0]?.url ?? "").searchParams;
    expect(query.get("all")).toBe("true");
    expect(query.get("since")).toBe("2026-11-01T00:00:00Z");

    const second = await adapter.notifications("2026-11-01T00:00:00Z");
    expect(header(calls[1], "if-modified-since")).toBe(
      recorded.notifications.headers["last-modified"],
    );
    expect(header(calls[1], "if-none-match")).toBe(
      recorded.notifications.headers.etag,
    );
    expect(second).toEqual({ ...first, modified: false });
    expect(adapter.requestStats()).toMatchObject({
      requests: 2,
      notModified: 1,
    });
  });

  const note = (reason: string, type: string, url: string | null) => ({
    id: "1",
    reason,
    updated_at: "2026-11-09T00:00:00Z",
    repository: { full_name: REPO },
    subject: { type, title: "t", url },
  });

  test.each([
    ["mention", "Issue", `${REPO_URL}/issues/5`, "issue"],
    ["team_mention", "PullRequest", `${REPO_URL}/pulls/5`, "pull"],
    ["author", "PullRequest", `${REPO_URL}/pulls/5`, "pull"],
    ["comment", "Issue", `${REPO_URL}/issues/5`, "issue"],
    ["review_requested", "PullRequest", `${REPO_URL}/pulls/5`, "pull"],
    ["assign", "Issue", `${REPO_URL}/issues/5`, "issue"],
    ["subscribed", "PullRequest", `${REPO_URL}/pulls/5`, null],
    ["state_change", "PullRequest", `${REPO_URL}/pulls/5`, null],
    ["ci_activity", "CheckSuite", null, null],
    ["mention", "Discussion", null, null],
    ["mention", "Release", `${REPO_URL}/releases/5`, null],
    ["author", "Commit", `${REPO_URL}/commits/abc`, null],
  ] as const)(
    "reason %s on %s is kept as %s",
    async (reason, type, url, kind) => {
      const { adapter } = setup([json([note(reason, type, url)])]);
      const { threads } = await adapter.notifications("2026-11-01T00:00:00Z");
      expect(threads.map((t) => t.kind)).toEqual(kind ? [kind] : []);
    },
  );

  test("persistent cache makes a second adapter instance poll conditionally", async () => {
    const kv = new FakeKv();
    const { adapter: first } = setup([replay(recorded.notifications)], {
      kv,
    });
    await first.notifications("2026-11-01T00:00:00Z");
    const { adapter: second, calls } = setup(
      [replay(recorded.notificationsNotModified)],
      { kv },
    );
    const page = await second.notifications("2026-11-01T00:00:00Z");
    expect(header(calls[0], "if-modified-since")).toBe(
      "Mon, 09 Nov 2026 09:01:44 GMT",
    );
    expect(page.modified).toBe(false);
    expect(page.threads).toHaveLength(3);
  });
});

describe("viewer", () => {
  test("reads the token user's login from /user and revalidates with the ETag", async () => {
    const { adapter, calls } = setup([
      json({ login: "alexei-led", id: 1 }, { etag: '"u1"' }),
      new Response(null, { status: 304 }),
    ]);
    expect(await adapter.viewer()).toBe("alexei-led");
    expect(await adapter.viewer()).toBe("alexei-led");
    expect(calls[0]?.url).toBe(`${API}/user`);
    expect(header(calls[1], "if-none-match")).toBe('"u1"');
  });

  test("a response without a login is rejected", async () => {
    const { adapter } = setup([json({ id: 1 })]);
    await expect(adapter.viewer()).rejects.toThrow();
  });
});

describe("pulls, comments and reviews", () => {
  test("recorded merged and closed pulls carry state, merged and branches", async () => {
    const { adapter, calls } = setup([
      replay(recorded.mergedPull),
      replay(recorded.closedPull),
    ]);
    expect(await adapter.getPull(REPO, 2)).toMatchObject({
      number: 2,
      state: "closed",
      merged: true,
      headRef: "crew-deps-validation-a",
      baseRef: "main",
      autoMerge: false,
    });
    expect(await adapter.getPull(REPO, 3)).toMatchObject({
      state: "closed",
      merged: false,
      baseRef: "crew-deps-validation-a",
    });
    expect(calls[0]?.url).toBe(`${REPO_URL}/pulls/2`);
  });

  test("recorded thread comments and reviews decode", async () => {
    const { adapter, calls } = setup([
      replay(recorded.comments),
      replay(recorded.reviews),
    ]);
    const thread = await adapter.listThreadComments(REPO, 1, {
      updatedAt: "2026-01-01T00:00:00Z",
      id: 0,
    });
    expect(thread).toEqual([
      {
        id: 6704379443,
        issueNumber: 1,
        author: "alexei-led",
        body: "[redacted fixture body]",
        createdAt: "2026-11-07T08:16:11Z",
        updatedAt: "2026-11-07T08:16:18Z",
        url: "https://github.com/alexei-led/crew-net-sandbox/issues/1#issuecomment-6704379443",
      },
    ]);
    expect(calls[0]?.url).toBe(`${API}${recorded.comments.path}`);
    expect(await adapter.listReviews(REPO, 2)).toEqual([]);
    expect(calls[1]?.url).toBe(`${API}${recorded.reviews.path}`);
  });

  test("reviews map pending, ghost and empty-body cases", async () => {
    const { adapter } = setup([
      json([
        {
          id: 9,
          user: null,
          state: "PENDING",
          body: null,
          html_url: "https://github.com/x#r9",
        },
        {
          id: 10,
          user: { login: "maria" },
          state: "APPROVED",
          body: "ok",
          submitted_at: "2026-11-09T00:00:00Z",
          html_url: "https://github.com/x#r10",
        },
      ]),
    ]);
    expect(await adapter.listReviews(REPO, 2)).toEqual([
      {
        id: 9,
        author: "ghost",
        state: "PENDING",
        body: "",
        submittedAt: null,
        url: "https://github.com/x#r9",
      },
      {
        id: 10,
        author: "maria",
        state: "APPROVED",
        body: "ok",
        submittedAt: "2026-11-09T00:00:00Z",
        url: "https://github.com/x#r10",
      },
    ]);
  });

  test("more than 100 comments with one updated_at are cut by (updatedAt, id)", async () => {
    const at = "2026-11-09T10:00:00Z";
    const later = "2026-11-09T10:00:01Z";
    const row = (id: number, updatedAt = at) => ({
      ...comments[0],
      id,
      updated_at: updatedAt,
    });
    const page2 = `${REPO_URL}/issues/7/comments?since=${encodeURIComponent(at)}&per_page=100&page=2`;
    const { adapter, calls } = setup([
      json(
        [row(500, later), ...Array.from({ length: 99 }, (_, i) => row(i + 1))],
        { link: `<${page2}>; rel="next"` },
      ),
      json(Array.from({ length: 50 }, (_, i) => row(i + 100))),
    ]);
    const result = await adapter.listThreadComments(REPO, 7, {
      updatedAt: at,
      id: 120,
    });
    expect(result.map((c) => c.id)).toEqual([
      ...Array.from({ length: 29 }, (_, i) => i + 121),
      500,
    ]);
    expect(new URL(calls[0]?.url ?? "").searchParams.get("since")).toBe(at);
    expect(calls).toHaveLength(2);
  });

  test("pagination follows a same-origin path change, never another origin", async () => {
    const moved = `${API}/repositories/123/issues/7/comments?page=2`;
    const { adapter, calls } = setup([
      json(comments, { link: `<${moved}>; rel="next"` }),
      json([{ ...comments[0], id: 43 }]),
    ]);
    const result = await adapter.listThreadComments(REPO, 7, {
      updatedAt: "2026-01-01T00:00:00Z",
      id: 0,
    });
    expect(result.map((c) => c.id)).toEqual([42, 43]);
    expect(calls[1]?.url).toBe(moved);

    const { adapter: evil, calls: evilCalls } = setup([
      json([], { link: '<https://evil.invalid/steal>; rel="next"' }),
    ]);
    await expect(evil.listOpenPulls(REPO)).rejects.toThrow("pagination URL");
    expect(evilCalls).toHaveLength(1);

    const { adapter: cycle } = setup([
      json([], {
        link: `<${REPO_URL}/pulls?state=open&per_page=100>; rel="next"`,
      }),
    ]);
    await expect(cycle.listOpenPulls(REPO)).rejects.toThrow("pagination cycle");
  });

  test("open pulls reuse the ETag on a 304, including cached next links", async () => {
    const next = `${REPO_URL}/pulls?state=open&per_page=100&page=2`;
    const { adapter, calls } = setup([
      json(pulls, {
        etag: '"page1"',
        link: `<${next}>; rel="next"`,
        "x-ratelimit-remaining": "4999",
      }),
      json([], { etag: '"page2"' }),
      new Response(null, { status: 304 }),
      new Response(null, { status: 304 }),
    ]);
    const first = await adapter.listOpenPulls(REPO);
    expect(first).toEqual([
      {
        number: 7,
        nodeId: "PR_sandbox7",
        title: "Sandbox draft",
        author: "alexei-led",
        headRef: "feat/sandbox",
        headSha: "0123456789abcdef0123456789abcdef01234567",
        baseRef: "main",
        state: "open",
        draft: true,
        body: "Sandbox body",
        updatedAt: "2026-11-07T12:00:00Z",
        autoMerge: false,
        merged: false,
      },
    ]);
    expect(await adapter.listOpenPulls(REPO)).toEqual(first);
    expect(header(calls[2], "if-none-match")).toBe('"page1"');
    expect(header(calls[3], "if-none-match")).toBe('"page2"');
    expect(adapter.requestStats()).toEqual({
      requests: 4,
      notModified: 2,
      writes: 0,
      rateLimitRemaining: 4999,
    });
  });

  test("merged pulls stop at the first pull updated before the cutoff", async () => {
    const closed = (n: number, updated: string, merged: string | null) => ({
      ...pulls[0],
      number: n,
      state: "closed",
      updated_at: updated,
      merged_at: merged,
    });
    const { adapter, calls } = setup([
      json(
        [
          closed(9, "2026-11-09T00:00:00Z", "2026-11-08T00:00:00Z"),
          closed(8, "2026-11-08T12:00:00Z", null),
          closed(7, "2026-11-08T00:00:00Z", "2026-11-01T00:00:00Z"),
          closed(6, "2026-11-01T00:00:00Z", "2026-11-01T00:00:00Z"),
        ],
        { link: `<${REPO_URL}/pulls?page=2>; rel="next"` },
      ),
    ]);
    const merged = await adapter.listMergedPulls(REPO, "2026-11-05T00:00:00Z");
    expect(merged.map((p) => [p.number, p.mergedAt])).toEqual([
      [9, "2026-11-08T00:00:00Z"],
    ]);
    expect(calls).toHaveLength(1);
  });

  test.each(["owner", "a/b/c", "../x", "a/..", "a b/c", ""])(
    "rejects repository %p before any request",
    async (repo) => {
      const { adapter, calls } = setup([]);
      await expect(adapter.listOpenPulls(repo)).rejects.toThrow("owner/repo");
      expect(calls).toHaveLength(0);
    },
  );

  test.each([
    json({}),
    json([{ number: "7" }]),
    new Response("not JSON"),
    new Response(null, { status: 304 }),
  ])("malformed list or unsolicited 304 is rejected", async (response) => {
    const { adapter } = setup([response]);
    await expect(adapter.listOpenPulls(REPO)).rejects.toBeInstanceOf(Error);
  });
});

describe("authentication", () => {
  test("401 re-reads the token once, then a later 401 latches without gh or network", async () => {
    let reads = 0;
    const { adapter, calls } = setup(
      [
        new Response(null, { status: 401 }),
        json(pulls),
        new Response(null, { status: 401 }),
      ],
      { tokenProvider: async () => `token-${++reads}` },
    );
    await adapter.listOpenPulls(REPO);
    expect(calls.map((c) => header(c, "authorization"))).toEqual([
      "Bearer token-1",
      "Bearer token-2",
    ]);
    const error = await caught(adapter.listOpenPulls(REPO));
    expect(error).toBeInstanceOf(AuthError);
    expect(String(error)).toContain("gh auth refresh --hostname github.com");
    await expect(adapter.getPull(REPO, 7)).rejects.toBeInstanceOf(AuthError);
    expect(reads).toBe(2);
    expect(calls).toHaveLength(3);
  });

  test("401 twice throws and latches", async () => {
    let reads = 0;
    const { adapter, calls } = setup(
      [
        new Response(null, { status: 401 }),
        new Response(null, { status: 401 }),
      ],
      { tokenProvider: async () => `token-${++reads}` },
    );
    await expect(adapter.listOpenPulls(REPO)).rejects.toBeInstanceOf(AuthError);
    await expect(
      adapter.notifications("2026-11-01T00:00:00Z"),
    ).rejects.toBeInstanceOf(AuthError);
    expect(reads).toBe(2);
    expect(calls).toHaveLength(2);
  });

  test("a failing token provider latches after one call", async () => {
    let reads = 0;
    const { adapter, calls } = setup([], {
      tokenProvider: async () => {
        reads++;
        throw new Error("gh: not logged in, ghp_secret");
      },
    });
    const error = await caught(adapter.listOpenPulls(REPO));
    expect(error).toBeInstanceOf(AuthError);
    expect(String(error)).not.toContain("ghp_secret");
    await expect(adapter.listOpenPulls(REPO)).rejects.toBeInstanceOf(AuthError);
    expect(reads).toBe(1);
    expect(calls).toHaveLength(0);
  });

  test("403 with x-github-sso is an SSO error with the authorization link, not latched", async () => {
    const url = "https://github.com/orgs/acme/sso?authorization_request=abc";
    const { adapter, calls } = setup([
      new Response(null, {
        status: 403,
        headers: { "x-github-sso": `required; url=${url}` },
      }),
      json(pulls),
    ]);
    const error = await caught(adapter.listOpenPulls("acme/app"));
    expect(error).toBeInstanceOf(SsoError);
    if (error instanceof SsoError) expect(error.authorizeUrl).toBe(url);
    expect(String(error)).toContain(url);
    expect(await adapter.listOpenPulls(REPO)).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});

describe("rate limits", () => {
  test.each([
    [403, { "retry-after": "12" }, 12_000, true],
    [429, { "retry-after": "Thu, 01 Jan 1970 00:00:15 GMT" }, 14_000, true],
    [
      403,
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "20" },
      19_000,
      false,
    ],
    [429, {}, 60_000, true],
  ] as const)("%s %j waits %d ms", async (status, headers, wait, secondary) => {
    const { adapter } = setup([new Response(null, { status, headers })], {
      now: () => 1000,
    });
    const error = await caught(adapter.listOpenPulls(REPO));
    expect(error).toBeInstanceOf(RateLimitError);
    if (error instanceof RateLimitError) {
      expect(error.retryAfterMs).toBe(wait);
      expect(error.secondary).toBe(secondary);
    }
  });

  test("secondary 403 without retry-after backs off 60 s without touching the network", async () => {
    let now = 0;
    const { adapter, calls } = setup(
      [
        new Response(
          JSON.stringify({
            message:
              "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
          }),
          { status: 403 },
        ),
        json(pulls),
      ],
      { now: () => now },
    );
    const error = await caught(adapter.listOpenPulls(REPO));
    expect(error).toBeInstanceOf(RateLimitError);
    if (error instanceof RateLimitError) {
      expect(error.retryAfterMs).toBe(60_000);
      expect(error.secondary).toBe(true);
    }
    now = 59_000;
    const again = await caught(adapter.listOpenPulls(REPO));
    expect(again).toBeInstanceOf(RateLimitError);
    if (again instanceof RateLimitError) expect(again.retryAfterMs).toBe(1000);
    expect(calls).toHaveLength(1);
    now = 60_000;
    expect(await adapter.listOpenPulls(REPO)).toHaveLength(1);
    expect(calls).toHaveLength(2);
  });

  test("ordinary forbidden response is not mistaken for rate limiting", async () => {
    const { adapter } = setup([
      new Response(JSON.stringify({ message: "Resource not accessible" }), {
        status: 403,
      }),
    ]);
    await expect(adapter.getPull(REPO, 7)).rejects.toBeInstanceOf(
      GitHubResponseError,
    );
  });
});

describe("writes", () => {
  test("budget is shared across adapter instances through the persistent counter", async () => {
    const kv = new FakeKv();
    const now = () => 1_000;
    const first = setup(
      Array.from({ length: 12 }, () => json({})),
      { kv, now },
    );
    const second = setup(
      Array.from({ length: 8 }, () => json({})),
      { kv, now },
    );
    for (let i = 0; i < 12; i++)
      await first.adapter.postComment(REPO, 7, "one");
    for (let i = 0; i < 8; i++)
      await second.adapter.updatePullBody(REPO, 7, "two");
    const error = await caught(second.adapter.postComment(REPO, 7, "over"));
    expect(error).toBeInstanceOf(BudgetError);
    if (error instanceof BudgetError) expect(error.retryAfterMs).toBe(60_000);
    expect(second.calls).toHaveLength(8);
    expect(kv.writes()).toHaveLength(20);
    expect(WRITE_WINDOWS).toEqual([
      { windowMs: 60_000, max: 20 },
      { windowMs: 3_600_000, max: 200 },
    ]);
  });

  test("a 401 retry spends the budget once", async () => {
    const { adapter, kv, calls } = setup([
      new Response(null, { status: 401 }),
      json({}),
    ]);
    await adapter.postComment(REPO, 7, "message");
    expect(kv.writes()).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(adapter.requestStats()).toMatchObject({ requests: 2, writes: 2 });
  });

  test("createIssue posts title and body and returns the number", async () => {
    const { adapter, calls, kv } = setup([json({ number: 12 })]);
    expect(await adapter.createIssue(REPO, "Bug in api", "details")).toBe(12);
    expect(calls[0]?.url).toBe(`${REPO_URL}/issues`);
    expect(calls[0]?.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      title: "Bug in api",
      body: "details",
    });
    expect(kv.writes()).toHaveLength(1);
  });

  test("comment and body edit hit the repo endpoints; 204 is success", async () => {
    const { adapter, calls } = setup([
      json({}),
      new Response(null, { status: 204 }),
    ]);
    await adapter.postComment(REPO, 7, "hi");
    await adapter.updatePullBody(REPO, 7, "new body");
    expect(calls.map((c) => [c.init.method, c.url])).toEqual([
      ["POST", `${REPO_URL}/issues/7/comments`],
      ["PATCH", `${REPO_URL}/pulls/7`],
    ]);
    expect(JSON.parse(String(calls[1]?.init.body))).toEqual({
      body: "new body",
    });
  });

  test("network failures propagate without retrying writes", async () => {
    let attempts = 0;
    const { adapter } = setup([], {
      fetch: async (_url, init) => {
        attempts++;
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(init.redirect).toBe("error");
        throw new Error("network offline");
      },
    });
    await expect(adapter.postComment(REPO, 7, "test")).rejects.toThrow(
      "network offline",
    );
    expect(attempts).toBe(1);
  });

  test("disabling auto-merge on GHES uses its GraphQL endpoint and spends no budget", async () => {
    const { adapter, calls, kv } = setup(
      [
        json({ ...pulls[0], state: "open", auto_merge: {} }),
        json({
          data: {
            disablePullRequestAutoMerge: {
              pullRequest: { id: "PR_sandbox7" },
            },
          },
        }),
      ],
      { host: "github.example" },
    );
    await adapter.disableAutoMerge(REPO, 7);
    expect(calls.map((c) => c.url)).toEqual([
      `https://github.example/api/v3/repos/${REPO}/pulls/7`,
      "https://github.example/api/graphql",
    ]);
    expect(JSON.parse(String(calls[1]?.init.body)).variables).toEqual({
      id: "PR_sandbox7",
    });
    expect(kv.writes("github.example")).toHaveLength(0);
  });

  test("GraphQL errors are failures even with HTTP 200", async () => {
    const { adapter } = setup([
      json({ ...pulls[0], auto_merge: {} }),
      json({ errors: [{ message: "denied" }] }),
    ]);
    await expect(adapter.disableAutoMerge(REPO, 7)).rejects.toBeInstanceOf(
      GitHubResponseError,
    );
  });
});

test.each([
  ["github.com", "https://api.github.com", "https://api.github.com/graphql"],
  [
    "acme.ghe.com",
    "https://api.acme.ghe.com",
    "https://api.acme.ghe.com/graphql",
  ],
  [
    "github.example",
    "https://github.example/api/v3",
    "https://github.example/api/graphql",
  ],
])("host %s uses REST %s and GraphQL %s", (host, rest, graphql) => {
  expect(apiUrls(host)).toEqual({ rest, graphql });
});

test.each(["https://github.com", "GitHub.com", "evil.com/x", ""])(
  "rejects host %p",
  (host) => {
    expect(() => apiUrls(host)).toThrow("host");
  },
);

test.skipIf(process.env.CREW_NET_LIVE !== "1")(
  "live sandbox reads only",
  async () => {
    const adapter = new GitHubAdapter({
      host: "github.com",
      tokenProvider: async () =>
        execFileSync("gh", ["auth", "token", "--hostname", "github.com"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim(),
      kv: new FakeKv(),
    });
    const since = new Date(Date.now() - 86_400_000).toISOString();
    const page = await adapter.notifications(since);
    expect(page.pollIntervalMs).toBeGreaterThan(0);
    expect((await adapter.notifications(since)).modified).toBe(false);
    expect(Array.isArray(await adapter.listOpenPulls(REPO))).toBe(true);
    expect((await adapter.getPull(REPO, 2)).merged).toBe(true);
    expect(
      await adapter.listThreadComments(REPO, 1, {
        updatedAt: "2026-01-01T00:00:00Z",
        id: 0,
      }),
    ).not.toHaveLength(0);
    expect(Array.isArray(await adapter.listReviews(REPO, 2))).toBe(true);
    expect(adapter.requestStats().writes).toBe(0);
  },
  60_000,
);

describe("review regressions", () => {
  test("two in-flight requests hit by one token expiry both recover with one re-read", async () => {
    let reads = 0;
    let arrived = 0;
    let release: () => void = () => {};
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { adapter, calls } = setup([], {
      tokenProvider: async () => `token-${++reads}`,
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (header({ url, init }, "authorization") === "Bearer token-1") {
          if (++arrived === 2) release();
          await barrier;
          return new Response(null, { status: 401 });
        }
        return json(pulls);
      },
    });
    const [a, b] = await Promise.all([
      adapter.listOpenPulls(REPO),
      adapter.getPull(REPO, 7).catch((e: unknown) => e),
    ]);
    expect(a).toHaveLength(1);
    expect(b).not.toBeInstanceOf(AuthError);
    expect(reads).toBe(2);
    expect(await adapter.listOpenPulls(REPO)).toHaveLength(1);
  });

  test("notifications report orgs left out for missing SSO authorization", async () => {
    const { adapter } = setup([
      json([], {
        "x-github-sso": "partial-results; organizations=21955855,20582480",
      }),
    ]);
    const page = await adapter.notifications("2026-11-01T00:00:00Z");
    expect(page.ssoPartialOrgs).toEqual(["21955855", "20582480"]);
  });

  test("SSO error without a link falls back to gh auth refresh", async () => {
    const { adapter } = setup([
      new Response(null, {
        status: 403,
        headers: { "x-github-sso": "required" },
      }),
    ]);
    const error = await caught(adapter.listOpenPulls(REPO));
    expect(error).toBeInstanceOf(SsoError);
    expect(String(error)).toContain("gh auth refresh --hostname github.com");
  });

  test("a moved notifications cursor still polls conditionally and filters the replayed body", async () => {
    const { adapter, calls, kv } = setup([
      replay(recorded.notifications),
      replay(recorded.notificationsNotModified),
    ]);
    await adapter.notifications("2026-11-01T00:00:00Z");
    const page = await adapter.notifications("2026-11-09T08:00:00Z");
    expect(new URL(calls[1]?.url ?? "").searchParams.get("since")).toBe(
      "2026-11-09T08:00:00Z",
    );
    expect(header(calls[1], "if-modified-since")).toBe(
      "Mon, 09 Nov 2026 09:01:44 GMT",
    );
    expect(page.modified).toBe(false);
    expect(page.threads.map((t) => t.threadId)).toEqual(["1000", "1001"]);
    expect(
      [...kv.values.keys()].filter((k) => k.includes("notifications")),
    ).toHaveLength(1);
  });

  test("a cursor with milliseconds compares as time, not text", async () => {
    const { adapter } = setup([
      json([
        { ...comments[0], id: 1, updated_at: "2026-11-09T10:00:00Z" },
        { ...comments[0], id: 2, updated_at: "2026-11-09T10:00:01Z" },
      ]),
    ]);
    const result = await adapter.listThreadComments(REPO, 7, {
      updatedAt: "2026-11-09T10:00:00.500Z",
      id: 0,
    });
    expect(result.map((c) => c.id)).toEqual([2]);
  });

  test("a cached next link to another origin is never followed", async () => {
    const { adapter, calls, kv } = setup([new Response(null, { status: 304 })]);
    await kv.set(`github:cache:${REPO_URL}/pulls?state=open&per_page=100`, {
      etag: '"x"',
      body: [],
      next: "https://evil.invalid/steal",
    });
    await expect(adapter.listOpenPulls(REPO)).rejects.toThrow("pagination URL");
    expect(calls).toHaveLength(1);
  });

  test("invalid JSON errors carry no response body", async () => {
    const { adapter } = setup([new Response("secret-body-text {")]);
    const error = await caught(adapter.getPull(REPO, 7));
    expect(error).toBeInstanceOf(GitHubResponseError);
    expect(String(error)).not.toContain("secret-body-text");
  });

  test("a rate-limit backoff is shared with the next process through the store", async () => {
    const kv = new FakeKv();
    const now = () => 1_000;
    const first = setup([new Response(null, { status: 429 })], { kv, now });
    await expect(first.adapter.listOpenPulls(REPO)).rejects.toBeInstanceOf(
      RateLimitError,
    );
    const second = setup([], { kv, now: () => 31_000 });
    const error = await caught(
      second.adapter.notifications("2026-11-01T00:00:00Z"),
    );
    expect(error).toBeInstanceOf(RateLimitError);
    if (error instanceof RateLimitError) {
      expect(error.retryAfterMs).toBe(30_000);
      expect(error.secondary).toBe(true);
    }
    expect(second.calls).toHaveLength(0);
  });

  test("disableAutoMerge is a no-op when auto-merge is off", async () => {
    const { adapter, calls } = setup([json({ ...pulls[0], auto_merge: null })]);
    await adapter.disableAutoMerge(REPO, 7);
    expect(calls).toHaveLength(1);
  });

  test("GraphQL calls do not overwrite the REST rate-limit count", async () => {
    const { adapter } = setup([
      json(
        { ...pulls[0], auto_merge: {} },
        { "x-ratelimit-remaining": "4000" },
      ),
      json(
        {
          data: {
            disablePullRequestAutoMerge: { pullRequest: { id: "PR_sandbox7" } },
          },
        },
        { "x-ratelimit-remaining": "4999" },
      ),
    ]);
    await adapter.disableAutoMerge(REPO, 7);
    expect(adapter.requestStats().rateLimitRemaining).toBe(4000);
  });

  test("a GHE.com host sends REST calls to its API subdomain", async () => {
    const { adapter, calls } = setup([json(pulls)], { host: "acme.ghe.com" });
    await adapter.listOpenPulls(REPO);
    expect(calls[0]?.url).toBe(
      `https://api.acme.ghe.com/repos/${REPO}/pulls?state=open&per_page=100`,
    );
  });
});
