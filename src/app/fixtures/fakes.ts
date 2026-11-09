import type {
  BranchAuthor,
  Checkout,
  CommentCursor,
  EnvPort,
  GitHubPort,
  GitPort,
  IssueComment,
  LandedCommit,
  ManagedHooksPolicy,
  MergedPull,
  MergeTreeResult,
  NotificationPage,
  NotificationThread,
  PullRequest,
  PullReview,
  RemoteBranch,
  RepoIdentity,
  RequestStats,
  ThreadState,
  WorktreeBranch,
} from "../../ports/index";

/** In-memory GitHub for one host. Tests fill the maps; `calls` records each request. */
export class FakeGitHub implements GitHubPort {
  login = "me";
  readonly open = new Map<string, PullRequest[]>();
  readonly pulls = new Map<string, PullRequest>();
  threads: NotificationThread[] = [];
  readonly comments = new Map<string, IssueComment[]>();
  readonly reviews = new Map<string, PullReview[]>();
  /** `repo#N` → paths the PR changes. */
  readonly files = new Map<string, string[]>();
  /** repo → default branch; `main` when absent. */
  readonly defaults = new Map<string, string>();
  /** `repo#N` → thread state; `open` when absent. */
  readonly states = new Map<string, ThreadState>();
  readonly posted: { repo: string; number: number; body: string }[] = [];
  readonly autoMergeOff: string[] = [];
  readonly calls: string[] = [];
  /** Method name → error it throws until removed. */
  readonly failing = new Map<string, Error>();
  pollIntervalMs: number | null = 60_000;
  ssoPartialOrgs: string[] = [];

  private call(name: string, detail = ""): void {
    this.calls.push(detail ? `${name} ${detail}` : name);
    const error = this.failing.get(name);
    if (error) throw error;
  }

  async viewer(): Promise<string> {
    this.call("viewer");
    return this.login;
  }

  async notifications(since: string): Promise<NotificationPage> {
    this.call("notifications", since);
    return {
      modified: true,
      threads: this.threads.filter((t) => t.updatedAt > since),
      pollIntervalMs: this.pollIntervalMs,
      ssoPartialOrgs: this.ssoPartialOrgs,
    };
  }

  async listOpenPulls(repo: string): Promise<PullRequest[]> {
    this.call("listOpenPulls", repo);
    return this.open.get(repo) ?? [];
  }

  async listMergedPulls(): Promise<MergedPull[]> {
    this.call("listMergedPulls");
    return [];
  }

  async getPull(repo: string, number: number): Promise<PullRequest> {
    this.call("getPull", `${repo}#${number}`);
    const pull = this.pulls.get(`${repo}#${number}`);
    if (!pull) throw new Error(`no pull ${repo}#${number}`);
    return pull;
  }

  async listPullFiles(repo: string, number: number): Promise<string[]> {
    this.call("listPullFiles", `${repo}#${number}`);
    const files = this.files.get(`${repo}#${number}`);
    if (!files) throw new Error(`no files for ${repo}#${number}`);
    return files;
  }

  async defaultBranch(repo: string): Promise<string> {
    this.call("defaultBranch", repo);
    return this.defaults.get(repo) ?? "main";
  }

  async threadState(repo: string, number: number): Promise<ThreadState> {
    this.call("threadState", `${repo}#${number}`);
    return this.states.get(`${repo}#${number}`) ?? "open";
  }

  async listThreadComments(
    repo: string,
    number: number,
    after: CommentCursor,
  ): Promise<IssueComment[]> {
    this.call("listThreadComments", `${repo}#${number}`);
    return (this.comments.get(`${repo}#${number}`) ?? [])
      .filter(
        (c) =>
          c.updatedAt > after.updatedAt ||
          (c.updatedAt === after.updatedAt && c.id > after.id),
      )
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id - b.id);
  }

  async listReviews(repo: string, number: number): Promise<PullReview[]> {
    this.call("listReviews", `${repo}#${number}`);
    return this.reviews.get(`${repo}#${number}`) ?? [];
  }

  async postComment(repo: string, number: number, body: string) {
    this.call("postComment", `${repo}#${number}`);
    this.posted.push({ repo, number, body });
  }

  async updatePullBody(): Promise<void> {
    this.call("updatePullBody");
  }

  async disableAutoMerge(repo: string, number: number): Promise<void> {
    this.call("disableAutoMerge", `${repo}#${number}`);
    this.autoMergeOff.push(`${repo}#${number}`);
  }

  async createIssue(): Promise<number> {
    this.call("createIssue");
    return 1;
  }

  requestStats(): RequestStats {
    return {
      requests: this.calls.length,
      notModified: 0,
      writes: 0,
      rateLimitRemaining: null,
    };
  }
}

export function pull(
  number: number,
  author: string,
  headRef: string,
  extra: Partial<PullRequest> = {},
): PullRequest {
  return {
    number,
    nodeId: `PR_${number}`,
    title: `PR ${number}`,
    author,
    headRef,
    headSha: `sha-${headRef}`,
    baseRef: "main",
    state: "open",
    draft: false,
    body: "",
    updatedAt: "2026-11-09T10:00:00Z",
    autoMerge: false,
    merged: false,
    ...extra,
  };
}

export function comment(
  issueNumber: number,
  id: number,
  author: string,
  body: string,
  updatedAt = "2026-11-09T10:00:00Z",
): IssueComment {
  return {
    id,
    issueNumber,
    author,
    body,
    createdAt: updatedAt,
    updatedAt,
    url: `https://github.com/o/r/pull/${issueNumber}#issuecomment-${id}`,
  };
}

/**
 * In-memory git for one clone. `branch(name, paths)` makes a remote branch
 * whose diff against `origin/<base>` is `paths`.
 */
export class FakeGit implements GitPort {
  fetches = 0;
  worktrees: WorktreeBranch[] = [];
  remotes: RemoteBranch[] = [];
  /** `base...head` → changed paths. */
  readonly diffs = new Map<string, string[]>();
  /** `a|b` → conflicted paths. */
  readonly conflicts = new Map<string, string[]>();
  /** `ref:path` → text. */
  readonly files = new Map<string, string>();
  /** `from..to` → commits. */
  readonly landedCommits = new Map<string, LandedCommit[]>();
  readonly mergeTrees: string[] = [];
  /** `base..tip` → the branch's own last author. */
  readonly authors = new Map<string, BranchAuthor>();
  /** Root of the clone every worktree belongs to; else each worktree is its own. */
  clone: string | undefined;
  /** The directory `checkout()` answers for; `at(dir)` gives a view for another. */
  cwd = "/work/r";

  /** A remote branch; `loginHint` and `authorEmail` name its own last author. */
  remote(
    name: string,
    paths: string[],
    extra: Partial<RemoteBranch & BranchAuthor> & { base?: string } = {},
  ): void {
    const {
      base = "main",
      lastCommitAt = "2026-11-09T09:00:00Z",
      authorEmail = "someone@example.test",
      loginHint = null,
    } = extra;
    const tip = `refs/remotes/origin/${name}`;
    this.remotes.push({ name, lastCommitAt });
    this.diffs.set(`origin/${base}...${tip}`, paths);
    this.authors.set(`origin/${base}..${tip}`, { authorEmail, loginHint });
  }

  local(branch: string, paths: string[], base = "main"): void {
    this.worktrees.push({ path: `/work/${branch}`, branch });
    this.diffs.set(`origin/${base}...refs/heads/${branch}`, paths);
  }

  /** This clone seen from `dir`, as the app's `git(dir)` gets it. */
  at(dir: string): GitPort {
    return {
      checkout: async () => this.checkoutOf(dir),
      fetch: () => this.fetch(),
      worktreeBranches: () => this.worktreeBranches(),
      remoteBranches: () => this.remoteBranches(),
      mergeBase: (a, b) => this.mergeBase(a, b),
      mergeTree: (a, b) => this.mergeTree(a, b),
      changedFiles: (base, head) => this.changedFiles(base, head),
      showFile: (ref, path) => this.showFile(ref, path),
      branchAuthor: (base, tip) => this.branchAuthor(base, tip),
      landed: (from, to) => this.landed(from, to),
    };
  }

  /** The worktree whose path holds `dir` (the longest match). */
  private checkoutOf(dir: string): Checkout {
    const match = this.worktrees
      .filter((wt) => dir === wt.path || dir.startsWith(`${wt.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
    if (!match) throw new Error(`not a git repository: ${dir}`);
    return {
      root: match.path,
      clone: this.clone ?? match.path,
      branch: match.branch,
    };
  }

  async checkout(): Promise<Checkout> {
    return this.checkoutOf(this.cwd);
  }

  async fetch(): Promise<void> {
    this.fetches++;
  }

  async worktreeBranches(): Promise<WorktreeBranch[]> {
    return this.worktrees;
  }

  async remoteBranches(): Promise<RemoteBranch[]> {
    return this.remotes;
  }

  async mergeBase(a: string, b: string): Promise<string | undefined> {
    return `fork(${a},${b})`;
  }

  async mergeTree(a: string, b: string): Promise<MergeTreeResult> {
    this.mergeTrees.push(`${a}|${b}`);
    const paths = this.conflicts.get(`${a}|${b}`) ?? [];
    return { clean: paths.length === 0, conflictedPaths: paths };
  }

  async changedFiles(base: string, head: string): Promise<string[]> {
    const paths = this.diffs.get(`${base}...${head}`);
    if (!paths) throw new Error(`unknown revision ${head}`);
    return paths;
  }

  async showFile(ref: string, path: string): Promise<string | undefined> {
    return this.files.get(`${ref}:${path}`);
  }

  async branchAuthor(
    base: string,
    tip: string,
  ): Promise<BranchAuthor | undefined> {
    return this.authors.get(`${base}..${tip}`);
  }

  async landed(from: string, to: string): Promise<LandedCommit[]> {
    return this.landedCommits.get(`${from}..${to}`) ?? [];
  }
}

export class FakeEnv implements EnvPort {
  identity: RepoIdentity | Error = { host: "github.com", repo: "o/r" };
  token: string | Error = "token";
  policy: ManagedHooksPolicy = { status: "known", enabled: false };

  async githubToken(): Promise<string> {
    if (this.token instanceof Error) throw this.token;
    return this.token;
  }
  /** Directories repoIdentity was asked about. */
  readonly identityDirs: string[] = [];
  async repoIdentity(dir: string): Promise<RepoIdentity> {
    this.identityDirs.push(dir);
    if (this.identity instanceof Error) throw this.identity;
    return this.identity;
  }
  async managedHooksOnly(): Promise<ManagedHooksPolicy> {
    return this.policy;
  }
  stateDir(): string {
    return "/state/crew-net";
  }
  configDir(): string {
    return "/config/crew-net";
  }
}
