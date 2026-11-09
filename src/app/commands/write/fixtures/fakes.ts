import type {
  FilesPort,
  GitHubPort,
  GitPort,
  GitRemote,
  InboxEntry,
  JsonObject,
  JsonValue,
  OutboundRequest,
  PullRequest,
  RequestStats,
  StorePort,
  WorktreeBranch,
} from "../../../../ports/index";
import type { ItemEvent } from "../../../../protocol/index";
import type { WriteContext } from "../context";

export const ME = "alexei";
export const REPO = "acme/app";

const key = (repo: string, number: number) => `${repo.toLowerCase()}#${number}`;

export function pull(
  number: number,
  over: Partial<PullRequest> = {},
): PullRequest {
  return {
    number,
    nodeId: `PR_${number}`,
    title: `PR ${number}`,
    author: ME,
    headRef: `branch-${number}`,
    headSha: "0".repeat(40),
    baseRef: "main",
    state: "open",
    draft: false,
    body: "",
    updatedAt: "2026-11-09T10:00:00Z",
    autoMerge: false,
    merged: false,
    ...over,
  };
}

const notFound = () =>
  Object.assign(new Error("GitHub request failed (HTTP 404)"), {
    status: 404,
  });

/** In-memory GitHub: PRs by repo and number, and a log of every write. */
export class FakeGitHub implements GitHubPort {
  readonly pulls = new Map<string, PullRequest & { repo: string }>();
  readonly comments: { repo: string; number: number; body: string }[] = [];
  readonly issues: {
    repo: string;
    number: number;
    title: string;
    body: string;
  }[] = [];
  /** Every write, in order: `comment`, `issue`, `body`, `auto-merge-off`. */
  readonly writes: string[] = [];
  readonly reads: string[] = [];
  /** Throw this from the named method. */
  readonly failures = new Map<string, Error>();
  /** Calls to these methods never settle. */
  readonly hangs = new Set<string>();
  nextIssue = 900;

  constructor(readonly login = ME) {}

  add(repo: string, pr: PullRequest): this {
    this.pulls.set(key(repo, pr.number), { ...pr, repo });
    return this;
  }

  body(repo: string, number: number): string {
    return this.pulls.get(key(repo, number))?.body ?? "";
  }

  private async enter(method: string): Promise<void> {
    if (this.hangs.has(method)) await new Promise(() => undefined);
    const failure = this.failures.get(method);
    if (failure) throw failure;
  }

  async viewer(): Promise<string> {
    await this.enter("viewer");
    return this.login;
  }

  async listOpenPulls(repo: string): Promise<PullRequest[]> {
    await this.enter("listOpenPulls");
    this.reads.push(`list ${repo}`);
    return [...this.pulls.values()]
      .filter((p) => p.repo.toLowerCase() === repo.toLowerCase())
      .filter((p) => p.state === "open")
      .map(({ repo: _, ...p }) => p);
  }

  async getPull(repo: string, number: number): Promise<PullRequest> {
    await this.enter("getPull");
    await this.enter(`getPull ${key(repo, number)}`);
    this.reads.push(`get ${key(repo, number)}`);
    const found = this.pulls.get(key(repo, number));
    if (!found) throw notFound();
    const { repo: _, ...pr } = found;
    return pr;
  }

  async postComment(repo: string, number: number, body: string): Promise<void> {
    await this.enter("postComment");
    this.writes.push(`comment ${key(repo, number)}`);
    this.comments.push({ repo, number, body });
  }

  async updatePullBody(repo: string, number: number, body: string) {
    await this.enter("updatePullBody");
    this.writes.push(`body ${key(repo, number)}`);
    const found = this.pulls.get(key(repo, number));
    if (!found) throw notFound();
    found.body = body;
  }

  async disableAutoMerge(repo: string, number: number): Promise<void> {
    await this.enter("disableAutoMerge");
    this.writes.push(`auto-merge-off ${key(repo, number)}`);
    const found = this.pulls.get(key(repo, number));
    if (found) found.autoMerge = false;
  }

  async createIssue(repo: string, title: string, body: string) {
    await this.enter("createIssue");
    const number = this.nextIssue++;
    this.writes.push(`issue ${key(repo, number)}`);
    this.issues.push({ repo, number, title, body });
    return number;
  }

  notifications(): never {
    throw new Error("not used by write commands");
  }
  listMergedPulls(): never {
    throw new Error("not used by write commands");
  }
  listThreadComments(): never {
    throw new Error("not used by write commands");
  }
  listReviews(): never {
    throw new Error("not used by write commands");
  }
  listPullFiles(): never {
    throw new Error("not used by write commands");
  }
  defaultBranch(): never {
    throw new Error("not used by write commands");
  }
  threadState(): never {
    throw new Error("not used by write commands");
  }
  requestStats(): RequestStats {
    return { requests: 0, notModified: 0, writes: 0, rateLimitRemaining: null };
  }
}

/** Git with fixed worktrees; the write commands only ask where the cwd is. */
export class FakeGit implements GitPort {
  constructor(
    readonly trees: WorktreeBranch[] = [],
    readonly remoteList: GitRemote[] = [],
  ) {}
  async worktreeBranches(): Promise<WorktreeBranch[]> {
    return this.trees;
  }
  async remotes(): Promise<GitRemote[]> {
    return this.remoteList;
  }
  /** git config values by key. */
  readonly config = new Map<string, string>();
  async configValue(key: string): Promise<string | undefined> {
    return this.config.get(key);
  }
  checkout(): never {
    throw new Error("not used by write commands");
  }
  branchAuthor(): never {
    throw new Error("not used by write commands");
  }
  fetch(): never {
    throw new Error("not used by write commands");
  }
  remoteBranches(): never {
    throw new Error("not used by write commands");
  }
  mergeBase(): never {
    throw new Error("not used by write commands");
  }
  mergeTree(): never {
    throw new Error("not used by write commands");
  }
  changedFiles(): never {
    throw new Error("not used by write commands");
  }
  showFile(): never {
    throw new Error("not used by write commands");
  }
  landed(): never {
    throw new Error("not used by write commands");
  }
}

const unused = (): never => {
  throw new Error("not used by write commands");
};

/** The parts of the store the write commands use, in memory. */
export class FakeStore implements StorePort {
  readonly outboxItems = new Map<string, OutboundRequest>();
  readonly inboxItems = new Map<string, InboxEntry>();
  readonly values = new Map<string, JsonValue>();
  readonly eventLog: JsonObject[] = [];
  outboxFailure: Error | undefined;

  addInbox(item: ItemEvent): this {
    this.inboxItems.set(item.id, { item, receivedAtMs: 0 });
    return this;
  }

  inbox = {
    put: unused,
    get: async (id: string) => this.inboxItems.get(id),
    list: unused,
  };
  delivered = { claim: unused, get: unused };
  outbox = {
    put: async (r: OutboundRequest) => {
      if (this.outboxFailure) throw this.outboxFailure;
      this.outboxItems.set(r.id, r);
    },
    list: async () => [...this.outboxItems.values()],
    remove: unused,
  };
  sessions = { beat: unused, live: unused, remove: unused };
  repos = { read: unused, write: unused };
  cursors = { get: unused, set: unused };
  jobs = { run: unused, lastRun: unused };
  kv = {
    get: async (k: string) => this.values.get(k),
    set: async (k: string, v: JsonValue) => {
      this.values.set(k, v);
    },
    update: async (k: string, fn: (v: JsonValue | undefined) => JsonValue) => {
      const v = fn(this.values.get(k));
      this.values.set(k, v);
      return v;
    },
  };
  events = {
    append: async (e: JsonObject) => {
      this.eventLog.push(e);
    },
    read: async () => [...this.eventLog],
  };
  prune = unused;
}

/** Files in memory, keyed by absolute path. */
export class FakeFiles implements FilesPort {
  readonly files = new Map<string, string>();
  async exists(path: string) {
    return this.files.has(path);
  }
  async write(path: string, content: string, _root: string) {
    this.files.set(path, content);
  }
}

export const ROOT = "/work/app";
export const BRANCH = "feat-users";

export interface Harness {
  ctx: WriteContext;
  github: FakeGitHub;
  /** GitHub of other hosts by name; a host missing here has no token. */
  hosts: Map<string, FakeGitHub>;
  store: FakeStore;
  files: FakeFiles;
}

/** A context whose cwd is ROOT on BRANCH in REPO, with ids id00001, id00002, … */
export function harness(over: Partial<WriteContext> = {}): Harness {
  const github = new FakeGitHub();
  const hosts = new Map<string, FakeGitHub>();
  const store = new FakeStore();
  const files = new FakeFiles();
  let n = 0;
  const ctx: WriteContext = {
    github,
    githubFor: (host) => {
      const other = hosts.get(host);
      if (!other) throw new Error(`gh has no token for ${host}`);
      return other;
    },
    git: new FakeGit([{ path: ROOT, branch: BRANCH }]),
    store,
    files,
    clock: { now: () => 1_000_000 },
    host: "github.com",
    repo: REPO,
    cwd: ROOT,
    newId: () => `id${String(++n).padStart(5, "0")}`,
    ...over,
  };
  return { ctx, github, hosts, store, files };
}
