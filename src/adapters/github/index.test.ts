import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import comments from "./fixtures/comments.json";
import pulls from "./fixtures/pulls.json";
import recorded from "./fixtures/recorded.json";
import {
  AuthError,
  BudgetError,
  type Fetch,
  GitHubAdapter,
  GitHubResponseError,
  RateLimitError,
} from "./index";

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
    if (!response) throw new Error("Unexpected HTTP request");
    return response;
  };
  const adapter = new GitHubAdapter({
    owner: "alexei-led",
    repo: "crew-net-sandbox",
    tokenProvider: async () => "test-token",
    fetch,
    ...extra,
  });
  return { adapter, calls };
}

const json = (value: unknown, headers?: HeadersInit) =>
  Response.json(value, headers === undefined ? {} : { headers });

test("pull facts and ETag reuse, including cached pagination metadata on 304", async () => {
  const next =
    "https://api.github.com/repos/alexei-led/crew-net-sandbox/pulls?state=open&per_page=100&page=2";
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
  const first = await adapter.listOpenPulls();
  expect(first).toEqual([
    {
      number: 7,
      nodeId: "PR_sandbox7",
      title: "Sandbox draft",
      author: "alexei-led",
      headRef: "feat/sandbox",
      headSha: "0123456789abcdef0123456789abcdef01234567",
      baseRef: "main",
      draft: true,
      body: "Sandbox body",
      updatedAt: "2026-11-07T12:00:00Z",
      autoMerge: false,
      merged: false,
    },
  ]);
  expect(await adapter.listOpenPulls()).toEqual(first);
  expect(new Headers(calls[0]?.init.headers).get("if-none-match")).toBeNull();
  expect(new Headers(calls[2]?.init.headers).get("if-none-match")).toBe(
    '"page1"',
  );
  expect(new Headers(calls[3]?.init.headers).get("if-none-match")).toBe(
    '"page2"',
  );
  expect(adapter.requestStats()).toEqual({
    requests: 4,
    notModified: 2,
    writes: 0,
    rateLimitRemaining: 4999,
  });
  const stats = adapter.requestStats();
  stats.requests = 100;
  expect(adapter.requestStats().requests).toBe(4);
});

test("comments paginate and retain edits created before the cursor", async () => {
  const next =
    "https://api.github.com/repos/alexei-led/crew-net-sandbox/issues/comments?page=2";
  const { adapter, calls } = setup([
    json(comments, {
      link: `<${next}>; rel="next", <https://ignored>; rel="last"`,
    }),
    json([{ ...comments[0], id: 43 }]),
  ]);
  const result = await adapter.listCommentsSince("2026-11-07T00:00:00Z");
  expect(result.map((comment) => comment.id)).toEqual([42, 43]);
  expect(result[0]).toEqual({
    id: 42,
    issueNumber: 7,
    author: "alexei-led",
    body: "crew → maria/orion\nSandbox question",
    createdAt: "2026-11-06T12:00:00Z",
    updatedAt: "2026-11-07T12:00:00Z",
    url: "https://github.com/alexei-led/crew-net-sandbox/issues/7#issuecomment-42",
  });
  const query = new URL(calls[0]?.url ?? "").searchParams;
  expect(query.get("since")).toBe("2026-11-07T00:00:00Z");
  expect(query.get("sort")).toBe("updated");
  expect(query.get("direction")).toBe("asc");
});

test("recorded sandbox responses decode through the public port", async () => {
  const { adapter } = setup(
    recorded.map(
      (response) =>
        new Response(JSON.stringify(response.body), {
          status: response.status,
          headers: response.headers,
        }),
    ),
  );
  expect(await adapter.listOpenPulls()).toEqual([]);
  const comments = await adapter.listCommentsSince("2026-01-01T00:00:00Z");
  expect(comments).toHaveLength(1);
  expect(comments[0]).toMatchObject({
    issueNumber: 1,
    author: "fixture-user",
    id: 6704379443,
  });
});

test("getPull retains merged and auto-merge facts, normalizes null bodies", async () => {
  const { adapter } = setup([
    json({ ...pulls[0], body: null, merged: true, auto_merge: {} }),
  ]);
  expect(await adapter.getPull(7)).toMatchObject({
    body: "",
    merged: true,
    autoMerge: true,
  });
});

test("body edit accepts an empty successful response", async () => {
  const { adapter } = setup([new Response(null, { status: 204 })]);
  await adapter.updatePullBody(7, "new body");
  expect(adapter.requestStats().writes).toBe(1);
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
  await expect(adapter.postComment(7, "test")).rejects.toThrow(
    "network offline",
  );
  expect(attempts).toBe(1);
});

test("401 re-reads the token once then succeeds", async () => {
  let reads = 0;
  const { adapter, calls } = setup(
    [new Response(null, { status: 401 }), json(pulls)],
    { tokenProvider: async () => `token-${++reads}` },
  );
  await adapter.listOpenPulls();
  expect(reads).toBe(2);
  expect(
    calls.map((call) => new Headers(call.init.headers).get("authorization")),
  ).toEqual(["Bearer token-1", "Bearer token-2"]);
});

test("401 twice throws AuthError without another token read", async () => {
  let reads = 0;
  const { adapter } = setup(
    [new Response(null, { status: 401 }), new Response(null, { status: 401 })],
    {
      tokenProvider: async () => {
        reads++;
        return "test-token";
      },
    },
  );
  await expect(adapter.listOpenPulls()).rejects.toBeInstanceOf(AuthError);
  expect(reads).toBe(2);
  expect(adapter.requestStats().requests).toBe(2);
});

test.each([
  [403, { "retry-after": "12" }, 12_000],
  [429, { "retry-after": "Thu, 01 Jan 1970 00:00:15 GMT" }, 14_000],
  [403, { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "20" }, 19_000],
  [429, {}, 60_000],
] as const)(
  "rate limit %s reports the wait without sleeping",
  async (status, headers, wait) => {
    const { adapter } = setup([new Response(null, { status, headers })], {
      now: () => 1000,
    });
    try {
      await adapter.listOpenPulls();
      throw new Error("Expected rate limit");
    } catch (error) {
      expect(error).toBeInstanceOf(RateLimitError);
      if (error instanceof RateLimitError)
        expect(error.retryAfterMs).toBe(wait);
    }
    expect(adapter.requestStats().requests).toBe(1);
  },
);

test("ordinary forbidden response is not mistaken for rate limiting", async () => {
  const { adapter } = setup([new Response(null, { status: 403 })]);
  await expect(adapter.getPull(7)).rejects.toBeInstanceOf(GitHubResponseError);
});

test("rolling write budgets refuse before fetch, and recover at the boundary", async () => {
  let now = 0;
  const { adapter, calls } = setup(
    Array.from({ length: 4 }, () => json({})),
    {
      now: () => now,
      writesPerMinute: 2,
      writesPerHour: 3,
    },
  );
  await adapter.postComment(7, "one");
  await adapter.updatePullBody(7, "two");
  await expect(adapter.postComment(7, "no")).rejects.toBeInstanceOf(
    BudgetError,
  );
  expect(calls).toHaveLength(2);
  now = 60_000;
  await adapter.postComment(7, "three");
  await expect(adapter.updatePullBody(7, "no")).rejects.toBeInstanceOf(
    BudgetError,
  );
  now = 3_600_000;
  await adapter.postComment(7, "four");
  expect(adapter.requestStats()).toMatchObject({ requests: 4, writes: 4 });
  expect(calls.map((call) => call.init.method)).toEqual([
    "POST",
    "PATCH",
    "POST",
    "POST",
  ]);
  expect(JSON.parse(String(calls[1]?.init.body))).toEqual({ body: "two" });
});

test("defaults allow 20 writes per minute and 200 per hour", async () => {
  let now = 0;
  const { adapter } = setup(
    Array.from({ length: 201 }, () => json({})),
    { now: () => now },
  );
  for (let minute = 0; minute < 10; minute++) {
    now = minute * 60_000;
    for (let i = 0; i < 20; i++) await adapter.postComment(7, "message");
    await expect(adapter.postComment(7, "over minute")).rejects.toBeInstanceOf(
      BudgetError,
    );
  }
  now = 10 * 60_000;
  await expect(adapter.postComment(7, "over hour")).rejects.toBeInstanceOf(
    BudgetError,
  );
  now = 3_600_000;
  await adapter.postComment(7, "next hour");
  expect(adapter.requestStats().writes).toBe(201);
});

test("401 write retries consume budget too", async () => {
  const { adapter } = setup([new Response(null, { status: 401 }), json({})], {
    writesPerMinute: 1,
  });
  await expect(adapter.postComment(7, "message")).rejects.toBeInstanceOf(
    BudgetError,
  );
  expect(adapter.requestStats().requests).toBe(1);
});

test("enterprise base URL and GraphQL disable use node id variables", async () => {
  const { adapter, calls } = setup(
    [
      json({
        ...pulls[0],
        auto_merge: { enabled_by: { login: "alexei-led" } },
        merged: true,
      }),
      json({
        data: {
          disablePullRequestAutoMerge: { pullRequest: { id: "PR_sandbox7" } },
        },
      }),
    ],
    { baseUrl: "https://github.example/api/v3/" },
  );
  await adapter.disableAutoMerge(7);
  expect(calls.map((call) => call.url)).toEqual([
    "https://github.example/api/v3/repos/alexei-led/crew-net-sandbox/pulls/7",
    "https://github.example/api/graphql",
  ]);
  const mutation = JSON.parse(String(calls[1]?.init.body));
  expect(mutation.variables).toEqual({ id: "PR_sandbox7" });
  expect(mutation.query).toContain("disablePullRequestAutoMerge");
  expect(adapter.requestStats().writes).toBe(1);
});

test("GraphQL errors are failures even with HTTP 200", async () => {
  const { adapter } = setup([
    json(pulls[0]),
    json({ errors: [{ message: "denied" }] }),
  ]);
  await expect(adapter.disableAutoMerge(7)).rejects.toBeInstanceOf(
    GitHubResponseError,
  );
});

test("successful writes invalidate ETag caches", async () => {
  const { adapter, calls } = setup([
    json(pulls, { etag: '"old"' }),
    json({}),
    json(pulls),
  ]);
  await adapter.listOpenPulls();
  await adapter.postComment(7, "hello");
  await adapter.listOpenPulls();
  expect(new Headers(calls[2]?.init.headers).get("if-none-match")).toBeNull();
});

test.each([
  json({}),
  json([{ number: "7" }]),
  new Response("not JSON"),
  new Response(null, { status: 304 }),
])("malformed list or unsolicited 304 is rejected", async (response) => {
  const { adapter } = setup([response]);
  await expect(adapter.listOpenPulls()).rejects.toBeInstanceOf(Error);
});

test("pagination cannot exfiltrate tokens or loop", async () => {
  const { adapter, calls } = setup([
    json([], { link: '<https://evil.invalid/steal>; rel="next"' }),
  ]);
  await expect(adapter.listOpenPulls()).rejects.toThrow("pagination URL");
  expect(calls).toHaveLength(1);
  const { adapter: cycle } = setup([
    json([], {
      link: '<https://api.github.com/repos/alexei-led/crew-net-sandbox/pulls?state=open&per_page=100>; rel="next"',
    }),
  ]);
  await expect(cycle.listOpenPulls()).rejects.toThrow("pagination cycle");
});

test.skipIf(process.env.CREW_NET_LIVE !== "1")(
  "live sandbox reads only",
  async () => {
    const adapter = new GitHubAdapter({
      owner: "alexei-led",
      repo: "crew-net-sandbox",
      tokenProvider: async () =>
        execFileSync("gh", ["auth", "token"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim(),
    });
    expect(Array.isArray(await adapter.listOpenPulls())).toBe(true);
    expect(
      Array.isArray(await adapter.listCommentsSince("2026-01-01T00:00:00Z")),
    ).toBe(true);
    expect(adapter.requestStats().writes).toBe(0);
  },
  60_000,
);
