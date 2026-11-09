import type {
  CommentCursor,
  GitHubPort,
  IssueComment,
  JsonValue,
  MergedPull,
  NotificationPage,
  NotificationReason,
  NotificationThread,
  PullRequest,
  PullReview,
  RequestStats,
  StorePort,
  ThreadState,
} from "../../ports/index";

/** GitHub allows 80/min and 500/h content writes per user; crew-net keeps well under (design: Sync). */
export const WRITE_WINDOWS: readonly { windowMs: number; max: number }[] = [
  { windowMs: 60_000, max: 20 },
  { windowMs: 3_600_000, max: 200 },
];

const SECONDARY_BACKOFF_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const MERGED_LIMIT = 50;

const REASONS: ReadonlySet<string> = new Set<NotificationReason>([
  "mention",
  "team_mention",
  "author",
  "comment",
  "review_requested",
  "assign",
]);

/** Token rejected after one re-read, or no token at all. Latched for the process. */
export class AuthError extends Error {
  constructor(readonly host: string) {
    super(
      `GitHub authentication failed for ${host}. Run: gh auth refresh --hostname ${host}`,
    );
    this.name = "AuthError";
  }
}

/** The organization enforces SAML SSO and the token is not authorized for it. */
export class SsoError extends Error {
  constructor(
    readonly host: string,
    readonly authorizeUrl: string | undefined,
  ) {
    super(
      `GitHub SSO authorization required on ${host}. ${
        authorizeUrl
          ? `Authorize the token: ${authorizeUrl}`
          : `Run: gh auth refresh --hostname ${host}`
      }`,
    );
    this.name = "SsoError";
  }
}

export class RateLimitError extends Error {
  constructor(
    readonly retryAfterMs: number,
    readonly secondary: boolean,
  ) {
    super(
      `GitHub ${secondary ? "secondary " : ""}rate limit reached; retry in ${Math.ceil(retryAfterMs / 1000)} s`,
    );
    this.name = "RateLimitError";
  }
}

export class BudgetError extends Error {
  constructor(readonly retryAfterMs: number) {
    super(
      `crew-net write budget exhausted (20/min, 200/h); retry in ${Math.ceil(retryAfterMs / 1000)} s`,
    );
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
  /** github.com, a GHE.com data-residency host (`*.ghe.com`) or a GHES host. */
  host: string;
  tokenProvider: () => Promise<string>;
  /** The store's cross-process KV: HTTP validators and the write log live there. */
  kv: StorePort["kv"];
  fetch?: Fetch;
  now?: () => number;
}

function validHost(host: string): string {
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host))
    throw new Error("Invalid GitHub host");
  return host;
}

/** REST and GraphQL endpoints for a host. */
export function apiUrls(host: string): { rest: string; graphql: string } {
  validHost(host);
  if (host === "github.com")
    return {
      rest: "https://api.github.com",
      graphql: "https://api.github.com/graphql",
    };
  if (host.endsWith(".ghe.com"))
    return {
      rest: `https://api.${host}`,
      graphql: `https://api.${host}/graphql`,
    };
  return {
    rest: `https://${host}/api/v3`,
    graphql: `https://${host}/api/graphql`,
  };
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

/** Deleted accounts come back as `user: null`; GitHub shows them as ghost. */
function login(value: unknown): string {
  return value === null ? "ghost" : string(object(value).login);
}

function repoPath(repo: string): string {
  const parts = repo.split("/");
  const [owner, name] = parts;
  if (
    parts.length !== 2 ||
    !owner ||
    !name ||
    !/^[A-Za-z0-9_.-]+$/.test(owner) ||
    !/^[A-Za-z0-9_.-]+$/.test(name) ||
    owner === "." ||
    owner === ".." ||
    name === "." ||
    name === ".."
  )
    throw new Error("Repository must be owner/repo");
  return `/repos/${owner}/${name}`;
}

function pull(value: unknown): PullRequest {
  const raw = object(value);
  const head = object(raw.head);
  const state = string(raw.state);
  if (state !== "open" && state !== "closed")
    throw new Error("Invalid GitHub pull state");
  return {
    number: integer(raw.number),
    nodeId: string(raw.node_id),
    title: string(raw.title),
    author: login(raw.user),
    headRef: string(head.ref),
    headSha: string(head.sha),
    ...(head.repo === undefined
      ? {}
      : {
          headRepo:
            head.repo === null ? "" : string(object(head.repo).full_name),
        }),
    baseRef: string(object(raw.base).ref),
    state,
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
  const issue = new URL(string(raw.issue_url)).pathname.match(
    /\/issues\/(\d+)$/,
  )?.[1];
  if (!issue) throw new Error("Invalid GitHub comment issue URL");
  return {
    id: integer(raw.id),
    issueNumber: integer(Number(issue)),
    author: login(raw.user),
    body: string(raw.body),
    createdAt: string(raw.created_at),
    updatedAt: string(raw.updated_at),
    url: string(raw.html_url),
  };
}

function review(value: unknown): PullReview {
  const raw = object(value);
  return {
    id: integer(raw.id),
    author: login(raw.user),
    state: string(raw.state),
    body: raw.body == null ? "" : string(raw.body),
    submittedAt: raw.submitted_at == null ? null : string(raw.submitted_at),
    url: string(raw.html_url),
  };
}

/** Pull and issue threads with a crew-net reason; everything else is dropped. */
function thread(value: unknown): NotificationThread | undefined {
  const raw = object(value);
  const reason = string(raw.reason);
  if (!REASONS.has(reason)) return undefined;
  const subject = object(raw.subject);
  const type = string(subject.type);
  const kind =
    type === "PullRequest" ? "pull" : type === "Issue" ? "issue" : undefined;
  if (!kind || typeof subject.url !== "string") return undefined;
  const number = new URL(subject.url).pathname.match(
    /\/(?:pulls|issues)\/(\d+)$/,
  )?.[1];
  if (!number) throw new Error("Invalid GitHub notification subject URL");
  return {
    threadId: string(raw.id),
    repo: string(object(raw.repository).full_name),
    kind,
    number: integer(Number(number)),
    reason: reason as NotificationReason,
    updatedAt: string(raw.updated_at),
  };
}

/** Orders by time, then id. Times compare as instants: `…00.500Z` and `…00Z` differ as text. */
function compareCursor(a: CommentCursor, b: CommentCursor): number {
  return Date.parse(a.updatedAt) - Date.parse(b.updatedAt) || a.id - b.id;
}

interface Cached {
  etag?: string;
  lastModified?: string;
  body: JsonValue;
  next?: string;
}

/**
 * Notifications are keyed without `since`: the cursor moves after every change,
 * and a per-cursor key would make each next poll unconditional and leave orphans.
 * A 304 then replays an older body, which notifications() filters by `since`.
 */
function cacheKey(url: string): string {
  const parsed = new URL(url);
  if (parsed.pathname.endsWith("/notifications"))
    parsed.searchParams.delete("since");
  return `github:cache:${parsed.href}`;
}
const writesKey = (host: string) => `github:writes:${host}`;
const blockedKey = (host: string) => `github:blocked:${host}`;

/** A KV value is data from disk; anything not shaped like an entry is a miss. */
function cached(value: JsonValue | undefined): Cached | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const { etag, lastModified, body, next } = value;
  if (body === undefined) return undefined;
  if (typeof etag !== "string" && typeof lastModified !== "string")
    return undefined;
  return {
    ...(typeof etag === "string" ? { etag } : {}),
    ...(typeof lastModified === "string" ? { lastModified } : {}),
    body,
    ...(typeof next === "string" ? { next } : {}),
  };
}

/**
 * Wait until every window has room for one more write at `now`, 0 when it fits.
 * `log` holds write times inside the longest window.
 */
export function budgetWait(log: readonly number[], now: number): number {
  const waits = WRITE_WINDOWS.flatMap(({ windowMs, max }) => {
    const inside = log.filter((at) => at > now - windowMs);
    return inside.length >= max ? [(inside[0] ?? now) + windowMs - now] : [];
  });
  return waits.length ? Math.max(...waits) : 0;
}

const LONGEST_WINDOW_MS = Math.max(...WRITE_WINDOWS.map((w) => w.windowMs));

interface Page {
  body: unknown;
  next?: string;
  modified: boolean;
  pollIntervalMs: number | null;
  /** Org ids GitHub left out because the token lacks SSO authorization. */
  ssoPartial: string[];
}

function ssoPartial(response: Response): string[] {
  const sso = response.headers.get("x-github-sso");
  if (!sso?.startsWith("partial-results")) return [];
  return (sso.match(/organizations=([^;\s]+)/)?.[1] ?? "")
    .split(",")
    .filter(Boolean);
}

interface Call {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  /** Content-creating write that spends the shared budget. */
  budgeted?: boolean;
  /** False: no conditional request and no cached body (large bodies the app keeps itself). */
  cache?: boolean;
}

/** Fetch-only transport for one GitHub host. Scheduling and sleeps belong to the app. */
export class GitHubAdapter implements GitHubPort {
  private readonly host: string;
  private readonly rest: string;
  private readonly graphql: string;
  private readonly fetcher: Fetch;
  private readonly now: () => number;
  private token: Promise<string> | undefined;
  private reread = false;
  private authFailure: AuthError | undefined;
  private readonly stats: RequestStats = {
    requests: 0,
    notModified: 0,
    writes: 0,
    rateLimitRemaining: null,
  };

  constructor(private readonly options: GitHubOptions) {
    this.host = validHost(options.host);
    ({ rest: this.rest, graphql: this.graphql } = apiUrls(this.host));
    this.fetcher = options.fetch ?? globalThis.fetch;
    this.now = options.now ?? Date.now;
  }

  requestStats(): RequestStats {
    return { ...this.stats };
  }

  private async currentToken(): Promise<string> {
    this.token ??= this.options.tokenProvider().then((token) => {
      if (!token) throw new Error("empty token");
      return token;
    });
    try {
      return await this.token;
    } catch {
      // No further gh calls in this process: the fix needs the developer.
      this.authFailure = new AuthError(this.host);
      throw this.authFailure;
    }
  }

  private nextLink(response: Response, url: string): string | undefined {
    const next = response.headers
      .get("link")
      ?.split(",")
      .find((part) => /rel="next"/.test(part))
      ?.match(/<([^>]+)>/)?.[1];
    if (!next) return undefined;
    return new URL(next, url).href;
  }

  /** Persisted so the next short-lived sync process waits too. */
  private async backOff(ms: number, secondary: boolean): Promise<never> {
    const wait = Number.isFinite(ms) ? Math.max(0, ms) : SECONDARY_BACKOFF_MS;
    await this.options.kv.set(blockedKey(this.host), {
      until: this.now() + wait,
      secondary,
    });
    throw new RateLimitError(wait, secondary);
  }

  private async blocked(): Promise<void> {
    const value = await this.options.kv.get(blockedKey(this.host));
    if (typeof value !== "object" || value === null || Array.isArray(value))
      return;
    const wait =
      (typeof value.until === "number" ? value.until : 0) - this.now();
    if (wait > 0) throw new RateLimitError(wait, value.secondary === true);
  }

  private async limited(response: Response): Promise<void> {
    if (response.status !== 403 && response.status !== 429) return;
    const sso = response.headers.get("x-github-sso");
    if (response.status === 403 && sso?.startsWith("required"))
      throw new SsoError(this.host, sso.match(/url=(\S+)/)?.[1]);
    const now = this.now();
    const retry = response.headers.get("retry-after");
    const remaining = response.headers.get("x-ratelimit-remaining");
    if (retry !== null) {
      const secondary = remaining !== "0";
      await this.backOff(
        /^\d+(\.\d+)?$/.test(retry)
          ? Number(retry) * 1000
          : Date.parse(retry) - now,
        secondary,
      );
    }
    if (remaining === "0") {
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      await this.backOff(
        reset > 0 ? reset * 1000 - now : SECONDARY_BACKOFF_MS,
        false,
      );
    }
    if (response.status === 429) await this.backOff(SECONDARY_BACKOFF_MS, true);
    // A secondary limit may come as a plain 403; only its message tells it from a permission error.
    const text = await response.text().catch(() => "");
    if (/secondary rate limit|abuse detection/i.test(text))
      await this.backOff(SECONDARY_BACKOFF_MS, true);
  }

  private async request(url: string, call: Call = {}): Promise<Page> {
    if (this.authFailure) throw this.authFailure;
    await this.blocked();
    const method = call.method ?? "GET";
    if (call.budgeted) {
      // Reserved once per logical write: a 401 retry is the same write.
      const now = this.now();
      let wait = 0;
      await this.options.kv.update(writesKey(this.host), (current) => {
        const log = (Array.isArray(current) ? current : [])
          .filter((at): at is number => typeof at === "number")
          .filter((at) => at > now - LONGEST_WINDOW_MS)
          .sort((a, b) => a - b);
        wait = budgetWait(log, now);
        return wait > 0 ? log : [...log, now];
      });
      if (wait > 0) throw new BudgetError(wait);
    }
    const caching = method === "GET" && call.cache !== false;
    const hit = caching
      ? cached(await this.options.kv.get(cacheKey(url)))
      : undefined;
    for (;;) {
      const token = await this.currentToken();
      const used = this.token;
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      };
      if (hit?.etag) headers["If-None-Match"] = hit.etag;
      if (hit?.lastModified) headers["If-Modified-Since"] = hit.lastModified;
      if (call.body !== undefined) headers["Content-Type"] = "application/json";
      this.stats.requests++;
      if (method !== "GET") this.stats.writes++;
      const response = await this.fetcher(url, {
        method,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        ...(call.body === undefined ? {} : { body: JSON.stringify(call.body) }),
      });
      const remaining = response.headers.get("x-ratelimit-remaining");
      if (url !== this.graphql && remaining !== null && /^\d+$/.test(remaining))
        this.stats.rateLimitRemaining = Number(remaining);
      if (response.status === 401) {
        // A concurrent request already replaced the token this one used: retry with it.
        if (this.token !== undefined && used !== this.token) continue;
        if (this.reread) {
          this.authFailure = new AuthError(this.host);
          throw this.authFailure;
        }
        this.reread = true;
        this.token = undefined;
        continue;
      }
      await this.limited(response);
      const poll = response.headers.get("x-poll-interval");
      const pollIntervalMs =
        poll && /^\d+$/.test(poll) ? Number(poll) * 1000 : null;
      if (response.status === 304) {
        this.stats.notModified++;
        if (!hit)
          throw new GitHubResponseError(
            304,
            "GitHub returned 304 without a cached body",
          );
        return {
          body: hit.body,
          ...(hit.next === undefined ? {} : { next: hit.next }),
          modified: false,
          pollIntervalMs,
          ssoPartial: ssoPartial(response),
        };
      }
      if (!response.ok) throw new GitHubResponseError(response.status);
      let body: unknown = null;
      if (response.status !== 204) {
        try {
          body = await response.json();
        } catch {
          // The parser quotes the body; keep it out of error text.
          throw new GitHubResponseError(response.status, "Invalid GitHub JSON");
        }
      }
      const next = this.nextLink(response, url);
      if (caching) {
        const etag = response.headers.get("etag");
        const lastModified = response.headers.get("last-modified");
        if (etag || lastModified)
          await this.options.kv.set(cacheKey(url), {
            ...(etag ? { etag } : {}),
            ...(lastModified ? { lastModified } : {}),
            body: body as JsonValue,
            ...(next === undefined ? {} : { next }),
          });
      }
      return {
        body,
        ...(next === undefined ? {} : { next }),
        modified: true,
        pollIntervalMs,
        ssoPartial: ssoPartial(response),
      };
    }
  }

  /** Reads every page (or until `stop` says so); `modified` is true when any page was a 200. */
  private async pages(
    url: string,
    stop: (items: unknown[]) => boolean = () => false,
    call: Call = {},
  ): Promise<{
    items: unknown[];
    modified: boolean;
    pollIntervalMs: number | null;
    ssoPartial: string[];
  }> {
    const items: unknown[] = [];
    const visited = new Set<string>();
    const sso = new Set<string>();
    const origin = new URL(url).origin;
    let modified = false;
    let pollIntervalMs: number | null = null;
    let next: string | undefined = url;
    while (next) {
      // Checked here, not only on fresh Link headers: a cached next comes from disk.
      if (new URL(next).origin !== origin)
        throw new Error("Invalid GitHub pagination URL");
      if (visited.has(next)) throw new Error("GitHub pagination cycle");
      visited.add(next);
      const page = await this.request(next, call);
      if (!Array.isArray(page.body)) throw new Error("Invalid GitHub list");
      modified ||= page.modified;
      pollIntervalMs ??= page.pollIntervalMs;
      for (const org of page.ssoPartial) sso.add(org);
      items.push(...page.body);
      if (stop(page.body)) break;
      next = page.next;
    }
    return { items, modified, pollIntervalMs, ssoPartial: [...sso] };
  }

  private async list<T>(
    url: string,
    parse: (value: unknown) => T,
  ): Promise<T[]> {
    return (await this.pages(url)).items.map(parse);
  }

  async notifications(since: string): Promise<NotificationPage> {
    const query = new URLSearchParams({ all: "true", since, per_page: "50" });
    const after = Date.parse(since);
    if (!Number.isFinite(after)) throw new Error("Invalid notifications since");
    const { items, modified, pollIntervalMs, ssoPartial } = await this.pages(
      `${this.rest}/notifications?${query}`,
    );
    return {
      modified,
      // A 304 may replay a body fetched with an older `since`.
      threads: items
        .flatMap((value) => thread(value) ?? [])
        .filter((t) => Date.parse(t.updatedAt) >= after),
      pollIntervalMs,
      ssoPartialOrgs: ssoPartial,
    };
  }

  async listOpenPulls(repo: string): Promise<PullRequest[]> {
    return this.list(
      `${this.rest}${repoPath(repo)}/pulls?state=open&per_page=100`,
      pull,
    );
  }

  async listMergedPulls(repo: string, sinceIso: string): Promise<MergedPull[]> {
    const since = Date.parse(sinceIso);
    if (!Number.isFinite(since)) throw new Error("Invalid merged-since date");
    const result: MergedPull[] = [];
    await this.pages(
      `${this.rest}${repoPath(repo)}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
      (page) => {
        for (const value of page) {
          const raw = object(value);
          // Sorted by updated_at: everything after this is older than `since`.
          if (Date.parse(string(raw.updated_at)) < since) return true;
          if (raw.merged_at == null) continue;
          const mergedAt = string(raw.merged_at);
          if (Date.parse(mergedAt) < since) continue;
          result.push({ ...pull(value), merged: true, mergedAt });
          if (result.length === MERGED_LIMIT) return true;
        }
        return false;
      },
    );
    return result;
  }

  async viewer(): Promise<string> {
    return login((await this.request(`${this.rest}/user`)).body);
  }

  async getPull(repo: string, number: number): Promise<PullRequest> {
    return pull(
      (
        await this.request(
          `${this.rest}${repoPath(repo)}/pulls/${integer(number)}`,
        )
      ).body,
    );
  }

  /** Not cached: pages carry each file's patch; the app keeps the paths by head sha. */
  async listPullFiles(repo: string, number: number): Promise<string[]> {
    const { items } = await this.pages(
      `${this.rest}${repoPath(repo)}/pulls/${integer(number)}/files?per_page=100`,
      undefined,
      { cache: false },
    );
    return items.flatMap((value) => {
      const raw = object(value);
      // A rename lists its old path too, as the radar's git diff does.
      return raw.previous_filename === undefined
        ? [string(raw.filename)]
        : [string(raw.filename), string(raw.previous_filename)];
    });
  }

  async defaultBranch(repo: string): Promise<string> {
    const branch = string(
      object((await this.request(`${this.rest}${repoPath(repo)}`)).body)
        .default_branch,
    );
    if (branch === "") throw new Error("Invalid GitHub default branch");
    return branch;
  }

  async threadState(repo: string, number: number): Promise<ThreadState> {
    const raw = object(
      (
        await this.request(
          `${this.rest}${repoPath(repo)}/issues/${integer(number)}`,
        )
      ).body,
    );
    const state = string(raw.state);
    if (state === "open") return "open";
    if (state !== "closed") throw new Error("Invalid GitHub issue state");
    // The issues endpoint answers for PRs too; a merged PR has merged_at.
    return raw.pull_request != null &&
      object(raw.pull_request).merged_at != null
      ? "merged"
      : "closed";
  }

  async listThreadComments(
    repo: string,
    number: number,
    cursor: CommentCursor,
  ): Promise<IssueComment[]> {
    const query = new URLSearchParams({
      since: cursor.updatedAt,
      per_page: "100",
    });
    const comments = await this.list(
      `${this.rest}${repoPath(repo)}/issues/${integer(number)}/comments?${query}`,
      comment,
    );
    if (!Number.isFinite(Date.parse(cursor.updatedAt)))
      throw new Error("Invalid comment cursor");
    return comments
      .filter((c) => compareCursor(c, cursor) > 0)
      .sort(compareCursor);
  }

  async listReviews(repo: string, number: number): Promise<PullReview[]> {
    return this.list(
      `${this.rest}${repoPath(repo)}/pulls/${integer(number)}/reviews?per_page=100`,
      review,
    );
  }

  async postComment(repo: string, number: number, body: string): Promise<void> {
    await this.request(
      `${this.rest}${repoPath(repo)}/issues/${integer(number)}/comments`,
      { method: "POST", body: { body }, budgeted: true },
    );
  }

  async updatePullBody(
    repo: string,
    number: number,
    body: string,
  ): Promise<void> {
    await this.request(
      `${this.rest}${repoPath(repo)}/pulls/${integer(number)}`,
      { method: "PATCH", body: { body }, budgeted: true },
    );
  }

  async createIssue(
    repo: string,
    title: string,
    body: string,
  ): Promise<number> {
    const page = await this.request(`${this.rest}${repoPath(repo)}/issues`, {
      method: "POST",
      body: { title, body },
      budgeted: true,
    });
    return integer(object(page.body).number);
  }

  /** Not a content write: it spends no budget. */
  async disableAutoMerge(repo: string, number: number): Promise<void> {
    const pr = await this.getPull(repo, number);
    if (!pr.autoMerge) return;
    const response = object(
      (
        await this.request(this.graphql, {
          method: "POST",
          body: {
            query:
              "mutation($id: ID!) { disablePullRequestAutoMerge(input: {pullRequestId: $id}) { pullRequest { id } } }",
            variables: { id: pr.nodeId },
          },
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
