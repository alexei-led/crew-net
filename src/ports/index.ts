import type { ItemEvent } from "../protocol/index";

/** Plain GitHub facts, independent of the coordination core. */
export interface PullRequest {
  number: number;
  nodeId: string;
  title: string;
  author: string;
  headRef: string;
  headSha: string;
  /** `owner/repo` of the head branch; "" when its fork was deleted. Absent when unknown. */
  headRepo?: string;
  baseRef: string;
  state: "open" | "closed";
  draft: boolean;
  body: string;
  updatedAt: string;
  autoMerge: boolean;
  merged: boolean;
}

export interface IssueComment {
  id: number;
  issueNumber: number;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
  url: string;
}

export interface RequestStats {
  requests: number;
  notModified: number;
  writes: number;
  rateLimitRemaining: number | null;
}

/** Reasons that make a notification a crew-net inbound candidate (design §8.2). */
export type NotificationReason =
  | "mention"
  | "team_mention"
  | "author"
  | "comment"
  | "review_requested"
  | "assign";

export interface NotificationThread {
  threadId: string;
  /** owner/repo of the thread's subject. */
  repo: string;
  kind: "pull" | "issue";
  number: number;
  reason: NotificationReason;
  updatedAt: string;
}

export interface NotificationPage {
  /** False when GitHub answered 304: nothing changed since the last poll. */
  modified: boolean;
  threads: NotificationThread[];
  /** From X-Poll-Interval, in milliseconds; null when GitHub sent none. */
  pollIntervalMs: number | null;
  /**
   * Org ids whose threads GitHub left out because the token lacks SSO
   * authorization (`X-GitHub-SSO: partial-results`). Show the fix (design §18).
   */
  ssoPartialOrgs: string[];
}

export interface PullReview {
  id: number;
  author: string;
  /** GitHub review state, e.g. APPROVED, CHANGES_REQUESTED, COMMENTED. */
  state: string;
  body: string;
  /** Null for pending reviews. */
  submittedAt: string | null;
  url: string;
}

export interface MergedPull extends PullRequest {
  merged: true;
  mergedAt: string;
}

export type ThreadState = "open" | "closed" | "merged";

/** Position in a thread's comments: strictly after this (updatedAt, id) pair. */
export interface CommentCursor {
  updatedAt: string;
  id: number;
}

/**
 * GitHub operations for one host. Every repository argument is `owner/repo`.
 * Adapters are per host; the token and any GHES base URL belong to the adapter.
 */
export interface GitHubPort {
  /** Login of the user the token belongs to (`GET /user`), as GitHub spells it. */
  viewer(): Promise<string>;
  /** Notification threads updated after `since`, filtered to crew-net reasons. */
  notifications(since: string): Promise<NotificationPage>;
  listOpenPulls(repo: string): Promise<PullRequest[]>;
  /** Pulls merged at or after `sinceIso`, most recently updated first, at most 50. */
  listMergedPulls(repo: string, sinceIso: string): Promise<MergedPull[]>;
  getPull(repo: string, number: number): Promise<PullRequest>;
  /** Paths a PR changes (`GET /pulls/{n}/files`, every page), for repos without a clone here. */
  listPullFiles(repo: string, number: number): Promise<string[]>;
  /** The repo's default branch (`GET /repos/{o}/{r}`). */
  defaultBranch(repo: string): Promise<string>;
  /** Whether an Issue or PR is open, closed or merged (`GET /issues/{n}`). */
  threadState(repo: string, number: number): Promise<ThreadState>;
  /** Every comment on the issue or PR after `after`, ordered by (updatedAt, id). */
  listThreadComments(
    repo: string,
    number: number,
    after: CommentCursor,
  ): Promise<IssueComment[]>;
  listReviews(repo: string, number: number): Promise<PullReview[]>;
  postComment(repo: string, number: number, body: string): Promise<void>;
  updatePullBody(repo: string, number: number, body: string): Promise<void>;
  disableAutoMerge(repo: string, number: number): Promise<void>;
  /** Opens an issue and returns its number. */
  createIssue(repo: string, title: string, body: string): Promise<number>;
  requestStats(): RequestStats;
}

/** Result of inspecting a prospective merge. */
export interface MergeTreeResult {
  clean: boolean;
  conflictedPaths: string[];
}

/** The working copy a directory belongs to. Paths are absolute, symlinks resolved. */
export interface Checkout {
  /** Root of the worktree. */
  root: string;
  /** Root of the clone: the parent of the git common dir, shared by all its worktrees. */
  clone: string;
  /** Branch checked out; absent on a detached HEAD. */
  branch?: string;
}

/** The author of a branch's newest own commit. */
export interface BranchAuthor {
  authorEmail: string;
  /** GitHub login from a users.noreply.github.com address, else null. */
  loginHint: string | null;
}

/** A git remote, as `gh` reads it to pick a repo. */
export interface GitRemote {
  name: string;
  url: string;
  /** `remote.<name>.gh-resolved`, set by `gh repo set-default`: `base` or `owner/repo`. */
  ghResolved?: string;
}

export interface WorktreeBranch {
  path: string;
  branch: string;
}

/** A remote-tracking branch. Its owner comes from `GitPort.branchAuthor`. */
export interface RemoteBranch {
  /** Branch name without the remote prefix. */
  name: string;
  /** Committer date of the branch tip, ISO 8601. */
  lastCommitAt: string;
}

/** A commit on a base branch after some point, with the paths it changed. */
export interface LandedCommit {
  sha: string;
  subject: string;
  authorEmail: string;
  /** GitHub login from a users.noreply.github.com address, else null. */
  loginHint: string | null;
  /** Paths changed against the first parent. */
  paths: string[];
}

/** Git operations used by the application. */
export interface GitPort {
  /** Fetch and prune remote refs. */
  fetch(): Promise<void>;
  /** The worktree, clone and branch of the directory this port runs in. */
  checkout(): Promise<Checkout>;
  /** Remotes with a URL, in config order. */
  remotes(): Promise<GitRemote[]>;
  /** Branches checked out in the main and linked worktrees, with their paths. */
  worktreeBranches(): Promise<WorktreeBranch[]>;
  /** Remote-tracking branches on origin. */
  remoteBranches(): Promise<RemoteBranch[]>;
  /** Merge base of two refs, or undefined when they share no history. */
  mergeBase(a: string, b: string): Promise<string | undefined>;
  /** Inspect the merge of two refs. */
  mergeTree(a: string, b: string): Promise<MergeTreeResult>;
  /** Paths changed on head since it forked from base. */
  changedFiles(base: string, head: string): Promise<string[]>;
  /** Text of `path` at `ref`, or undefined when the ref or the path does not exist. */
  showFile(ref: string, path: string): Promise<string | undefined>;
  /**
   * Author of the newest non-merge commit on `tip`'s first-parent line that
   * `base` does not have: who works on the branch, not who merged into it.
   * Undefined when the branch has no such commit.
   */
  branchAuthor(base: string, tip: string): Promise<BranchAuthor | undefined>;
  /** First-parent commits reachable from `to` and not from `from`, newest first, at most 100. */
  landed(from: string, to: string): Promise<LandedCommit[]>;
}

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** Lifecycle of a request I sent, until a reply or thread close removes it. */
export type RequestStatus = "open" | "in-progress";

/** A crew request I sent and still track (design §7.3). */
export interface OutboundRequest {
  /** Marker id, unique per sender. */
  id: string;
  /** host/owner/repo of the thread. */
  repo: string;
  /** Issue or PR number of the thread. */
  number: number;
  /** GitHub login of the recipient. */
  to: string;
  /** Marker kind: ask, review, fix, bug or info. */
  kind: string;
  /** Short summary shown in the inbox and digest. */
  text: string;
  createdAtMs: number;
  status: RequestStatus;
}

/** An inbound item as stored, with the time sync first wrote it. */
export interface InboxEntry {
  item: ItemEvent;
  receivedAtMs: number;
  /** Set once a session has claimed delivery. */
  delivered?: DeliveryClaim;
}

/** Which session delivered an item, and when. */
export interface DeliveryClaim {
  sessionId: string;
  atMs: number;
}

export type SessionRole = "lead" | "worker";

/** What a session writes about itself on every heartbeat. */
export interface SessionHeartbeat {
  sessionId: string;
  pid: number;
  /** claude, pi, codex or cli. */
  harness: string;
  role: SessionRole;
  worktree: string;
  /** Root of the clone the worktree belongs to; routing matches worktrees of one clone (design §9.3). */
  clone?: string;
  /** host/owner/repo of the origin remote, when the worktree has one. */
  repo?: string;
  branch?: string;
  lastPromptAtMs?: number;
}

/** A heartbeat with the time it was written. */
export interface SessionRecord extends SessionHeartbeat {
  seenAtMs: number;
}

/** A repository directory under repos/. Each part is a plain path segment. */
export interface RepoRef {
  host: string;
  owner: string;
  name: string;
}

export type RepoFile = "snapshot" | "radar";

/** ran: fn ran; fresh: it ran within the interval; busy: another process runs it. */
export type JobOutcome = "ran" | "fresh" | "busy";

/** Durable local state shared by sync and every session on this laptop (design §8.3). */
export interface StorePort {
  inbox: {
    /** Write or refresh an item. Keeps the first receivedAtMs. */
    put(item: ItemEvent): Promise<void>;
    get(id: string): Promise<InboxEntry | undefined>;
    /** All items, oldest first, with their delivery claim if any. */
    list(): Promise<InboxEntry[]>;
  };
  delivered: {
    /** Claim delivery. True when this session holds the claim, also on a repeat. */
    claim(id: string, sessionId: string): Promise<boolean>;
    get(id: string): Promise<DeliveryClaim | undefined>;
  };
  outbox: {
    put(request: OutboundRequest): Promise<void>;
    list(): Promise<OutboundRequest[]>;
    remove(id: string): Promise<void>;
  };
  sessions: {
    /** Write my heartbeat; the store stamps seenAtMs. */
    beat(session: SessionHeartbeat): Promise<void>;
    /** Sessions with a heartbeat younger than 3 minutes. */
    live(): Promise<SessionRecord[]>;
    remove(sessionId: string): Promise<void>;
  };
  repos: {
    read(repo: RepoRef, file: RepoFile): Promise<JsonValue | undefined>;
    write(repo: RepoRef, file: RepoFile, value: JsonValue): Promise<void>;
  };
  cursors: {
    get(name: string): Promise<string | undefined>;
    set(name: string, value: string): Promise<void>;
  };
  jobs: {
    /**
     * Take the job lock, skip if the job ran within intervalMs, run fn,
     * record the start time as the last run, release the lock.
     */
    run(
      name: string,
      intervalMs: number,
      fn: () => Promise<void>,
    ): Promise<JobOutcome>;
    lastRun(name: string): Promise<number | undefined>;
  };
  /** Small values that must survive across processes: HTTP cache, write budget. */
  kv: {
    get(key: string): Promise<JsonValue | undefined>;
    set(key: string, value: JsonValue): Promise<void>;
    /** Read-modify-write under a lock. fn must not do I/O. */
    update(
      key: string,
      fn: (current: JsonValue | undefined) => JsonValue,
    ): Promise<JsonValue>;
  };
  events: {
    /** Append one line to events.ndjson. */
    append(event: JsonObject): Promise<void>;
    /** Every logged event, oldest first (the rotated file, then the current one). Lines that are not JSON objects are skipped. */
    read(): Promise<JsonObject[]>;
  };
  /** Remove items delivered 14 days ago, session files older than 14 days, stale recovery markers and orphan temp files. */
  prune(): Promise<void>;
}

/** Files in the developer's working tree, for `crew-net init`. Paths are absolute. */
export interface FilesPort {
  /** True when anything exists at `path`, a dangling symlink included. */
  exists(path: string): Promise<boolean>;
  /** Write `content`, creating parent directories. Replaces an existing file. Refuses any path that resolves outside `root`, and a symlink at the file name. */
  write(path: string, content: string, root: string): Promise<void>;
}

export interface ClockPort {
  now(): number;
}

export type ManagedHooksPolicy =
  | { status: "known"; enabled: boolean }
  | { status: "unknown"; reason: string };

export interface RepoIdentity {
  /** Host of the origin remote, lowercase, without port. */
  host: string;
  /** owner/repo. */
  repo: string;
}

/** Machine facts needed by the application. */
export interface EnvPort {
  /** Token for `host` from `gh auth token --hostname`. */
  githubToken(host: string): Promise<string>;
  /** The origin remote of the working copy that contains `dir`. */
  repoIdentity(dir: string): Promise<RepoIdentity>;
  managedHooksOnly(): Promise<ManagedHooksPolicy>;
  /** `${XDG_STATE_HOME:-~/.local/state}/crew-net`. */
  stateDir(): string;
  /** `${XDG_CONFIG_HOME:-~/.config}/crew-net`. */
  configDir(): string;
}
