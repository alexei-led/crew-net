import type {
  GitHubPort,
  IssueComment,
  PullRequest,
  RequestStats,
} from "../../ports/index";

export class AuthError extends Error {
  constructor() {
    super("GitHub authentication failed after token refresh");
    this.name = "AuthError";
  }
}

export class RateLimitError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("GitHub rate limit reached");
    this.name = "RateLimitError";
  }
}

export class BudgetError extends Error {
  constructor(readonly retryAfterMs: number) {
    super("GitHub content-write budget exhausted");
    this.name = "BudgetError";
  }
}

export class GitHubResponseError extends Error {
  constructor(
    readonly status: number,
    message = "GitHub request failed",
  ) {
    super(`${message} (HTTP ${status})`);
    this.name = "GitHubResponseError";
  }
}

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface GitHubOptions {
  owner: string;
  repo: string;
  tokenProvider: () => Promise<string>;
  baseUrl?: string;
  fetch?: Fetch;
  now?: () => number;
  writesPerMinute?: number;
  writesPerHour?: number;
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid GitHub object");
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid GitHub string");
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
    throw new Error("Invalid GitHub identifier");
  return value;
}

function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("Invalid GitHub boolean");
  return value;
}

function pull(value: unknown): PullRequest {
  const raw = object(value);
  const head = object(raw.head);
  return {
    number: integer(raw.number),
    nodeId: string(raw.node_id),
    title: string(raw.title),
    author: string(object(raw.user).login),
    headRef: string(head.ref),
    headSha: string(head.sha),
    baseRef: string(object(raw.base).ref),
    draft: boolean(raw.draft),
    body: raw.body === null ? "" : string(raw.body),
    updatedAt: string(raw.updated_at),
    autoMerge: raw.auto_merge != null,
    // List responses omit merged; getPull includes it for the merge gate.
    merged: raw.merged === undefined ? false : boolean(raw.merged),
  };
}

function comment(value: unknown): IssueComment {
  const raw = object(value);
  const issueUrl = new URL(string(raw.issue_url));
  const issue = issueUrl.pathname.match(/\/issues\/(\d+)$/)?.[1];
  if (!issue) throw new Error("Invalid GitHub comment issue URL");
  return {
    id: integer(raw.id),
    issueNumber: integer(Number(issue)),
    author: string(object(raw.user).login),
    body: string(raw.body),
    createdAt: string(raw.created_at),
    updatedAt: string(raw.updated_at),
    url: string(raw.html_url),
  };
}

/** Fetch-only transport. Scheduling and retry sleeps belong to the app. */
export class GitHubAdapter implements GitHubPort {
  private readonly baseUrl: string;
  private readonly repoUrl: string;
  private readonly fetcher: Fetch;
  private readonly now: () => number;
  private readonly minuteCap: number;
  private readonly hourCap: number;
  private token: Promise<string> | undefined;
  private readonly cache = new Map<
    string,
    { etag: string; body: unknown; next?: string }
  >();
  private writeTimes: number[] = [];
  private readonly stats: RequestStats = {
    requests: 0,
    notModified: 0,
    writes: 0,
    rateLimitRemaining: null,
  };

  constructor(private readonly options: GitHubOptions) {
    this.baseUrl = (options.baseUrl ?? "https://api.github.com").replace(
      /\/$/,
      "",
    );
    this.repoUrl = `${this.baseUrl}/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repo)}`;
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
    this.minuteCap = options.writesPerMinute ?? 20;
    this.hourCap = options.writesPerHour ?? 200;
    for (const cap of [this.minuteCap, this.hourCap]) {
      if (!Number.isSafeInteger(cap) || cap < 1)
        throw new Error("Write caps must be positive integers");
    }
  }

  requestStats(): RequestStats {
    return { ...this.stats };
  }

  private reserveWrite(): void {
    const now = this.now();
    this.writeTimes = this.writeTimes.filter((at) => at > now - 3_600_000);
    const minute = this.writeTimes.filter((at) => at > now - 60_000);
    const waits: number[] = [];
    if (minute.length >= this.minuteCap)
      waits.push((minute[0] ?? now) + 60_000 - now);
    if (this.writeTimes.length >= this.hourCap)
      waits.push((this.writeTimes[0] ?? now) + 3_600_000 - now);
    if (waits.length) throw new BudgetError(Math.max(...waits));
    this.writeTimes.push(now);
  }

  private nextLink(response: Response, url: string): string | undefined {
    const link = response.headers.get("link");
    const next = link
      ?.split(",")
      .find((part) => /rel="next"/.test(part))
      ?.match(/<([^>]+)>/)?.[1];
    if (!next) return undefined;
    const resolved = new URL(next, url);
    // Never send the token to a host or endpoint supplied by an arbitrary Link.
    const expected = new URL(url);
    if (
      resolved.origin !== expected.origin ||
      resolved.pathname !== expected.pathname
    )
      throw new Error("Invalid GitHub pagination URL");
    return resolved.href;
  }

  private async request(
    url: string,
    method = "GET",
    body?: unknown,
    contentWrite = false,
  ): Promise<{ body: unknown; next?: string }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      this.token ??= this.options.tokenProvider();
      const token = await this.token;
      const cached = method === "GET" ? this.cache.get(url) : undefined;
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (cached) headers["If-None-Match"] = cached.etag;
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (contentWrite) this.reserveWrite();
      this.stats.requests++;
      if (method !== "GET") this.stats.writes++;
      const response = await this.fetcher(url, {
        method,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (remaining !== null && /^\d+$/.test(remaining))
        this.stats.rateLimitRemaining = Number(remaining);
      if (response.status === 401) {
        if (attempt === 1) throw new AuthError();
        this.token = undefined;
        continue;
      }
      if (response.status === 403 || response.status === 429) {
        const retry = response.headers.get("retry-after");
        if (retry !== null || remaining === "0" || response.status === 429) {
          const now = this.now();
          const reset = Number(response.headers.get("x-ratelimit-reset"));
          const wait =
            retry !== null
              ? /^\d+(\.\d+)?$/.test(retry)
                ? Number(retry) * 1000
                : Date.parse(retry) - now
              : remaining === "0" && reset > 0
                ? reset * 1000 - now
                : 60_000;
          throw new RateLimitError(
            Number.isFinite(wait) ? Math.max(0, wait) : 60_000,
          );
        }
      }
      if (response.status === 304) {
        this.stats.notModified++;
        if (!cached)
          throw new GitHubResponseError(
            304,
            "GitHub returned 304 without a cached body",
          );
        return cached;
      }
      if (!response.ok) throw new GitHubResponseError(response.status);
      const data: unknown =
        response.status === 204 ? null : await response.json();
      const next = this.nextLink(response, url);
      const result = { body: data, ...(next === undefined ? {} : { next }) };
      const etag = response.headers.get("etag");
      if (method === "GET") {
        if (etag) this.cache.set(url, { etag, ...result });
        else this.cache.delete(url);
      } else {
        // Body edits and comments can change any cached list or individual PR.
        this.cache.clear();
      }
      return result;
    }
    throw new AuthError();
  }

  private async list<T>(
    url: string,
    parse: (value: unknown) => T,
  ): Promise<T[]> {
    const result: T[] = [];
    const visited = new Set<string>();
    let next: string | undefined = url;
    while (next) {
      if (visited.has(next)) throw new Error("GitHub pagination cycle");
      visited.add(next);
      const page = await this.request(next);
      if (!Array.isArray(page.body)) throw new Error("Invalid GitHub list");
      result.push(...page.body.map(parse));
      next = page.next;
    }
    return result;
  }

  listOpenPulls(): Promise<PullRequest[]> {
    return this.list(`${this.repoUrl}/pulls?state=open&per_page=100`, pull);
  }

  listCommentsSince(cursor: string): Promise<IssueComment[]> {
    const query = new URLSearchParams({
      since: cursor,
      sort: "updated",
      direction: "asc",
      per_page: "100",
    });
    return this.list(`${this.repoUrl}/issues/comments?${query}`, comment);
  }

  async getPull(number: number): Promise<PullRequest> {
    return pull(
      (await this.request(`${this.repoUrl}/pulls/${integer(number)}`)).body,
    );
  }

  async postComment(number: number, body: string): Promise<void> {
    await this.request(
      `${this.repoUrl}/issues/${integer(number)}/comments`,
      "POST",
      { body },
      true,
    );
  }

  async updatePullBody(number: number, body: string): Promise<void> {
    await this.request(
      `${this.repoUrl}/pulls/${integer(number)}`,
      "PATCH",
      { body },
      true,
    );
  }

  async disableAutoMerge(number: number): Promise<void> {
    const pr = await this.getPull(number);
    const url = this.baseUrl.endsWith("/api/v3")
      ? `${this.baseUrl.slice(0, -7)}/api/graphql`
      : `${this.baseUrl}/graphql`;
    const response = object(
      (
        await this.request(url, "POST", {
          query:
            "mutation($id: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $id}) { pullRequest { id } } }",
          variables: { id: pr.nodeId },
        })
      ).body,
    );
    if (response.errors !== undefined || response.data == null)
      throw new GitHubResponseError(200, "GitHub GraphQL mutation failed");
    const mutation = object(object(response.data).disablePullRequestAutoMerge);
    if (object(mutation.pullRequest).id !== pr.nodeId)
      throw new GitHubResponseError(
        200,
        "Invalid GitHub GraphQL mutation result",
      );
  }
}
