import type { ItemEvent } from "../protocol/index";

/** Plain GitHub facts, independent of the coordination core. */
export interface PullRequest {
  number: number;
  nodeId: string;
  title: string;
  author: string;
  headRef: string;
  headSha: string;
  baseRef: string;
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

/** GitHub operations used by the application. */
export interface GitHubPort {
  listOpenPulls(): Promise<PullRequest[]>;
  listCommentsSince(cursor: string): Promise<IssueComment[]>;
  getPull(number: number): Promise<PullRequest>;
  postComment(number: number, body: string): Promise<void>;
  updatePullBody(number: number, body: string): Promise<void>;
  disableAutoMerge(number: number): Promise<void>;
  requestStats(): RequestStats;
}

/** Result of inspecting a prospective merge. */
export interface MergeTreeResult {
  clean: boolean;
  conflictedPaths: string[];
}

/** Git operations used by the application. */
export interface GitPort {
  /** Fetch remote refs. */
  fetch(): Promise<void>;
  /** List branches checked out in worktrees. */
  worktreeBranches(): Promise<string[]>;
  /** Inspect the merge of two refs. */
  mergeTree(a: string, b: string): Promise<MergeTreeResult>;
  /** List paths changed from base to a. */
  changedPaths(a: string, base: string): Promise<string[]>;
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
  };
  /** Remove expired delivered items, dead sessions, recovery markers and orphan temp files. */
  prune(): Promise<void>;
}

export interface ClockPort {
  now(): number;
}

export type ManagedHooksPolicy =
  | { status: "known"; enabled: boolean }
  | { status: "unknown"; reason: string };

/** Machine facts needed by the application. */
export interface EnvPort {
  githubToken(): Promise<string>;
  /** owner/repo, parsed from the origin remote. */
  repoIdentity(): Promise<string>;
  managedHooksOnly(): Promise<ManagedHooksPolicy>;
}
