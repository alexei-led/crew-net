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

/** An addressed request awaiting a reply or explicit acknowledgement. */
export interface OutboundRequest {
  id: string;
  issueNumber: number;
  to: string;
  body: string;
  createdAt: string;
}

/** Durable local coordination state. */
export interface StorePort {
  cursor: {
    get(): Promise<string | undefined>;
    set(value: string): Promise<void>;
  };
  inbox: {
    put(id: string, item: ItemEvent): Promise<void>;
    list(): Promise<ItemEvent[]>;
    ack(id: string): Promise<void>;
  };
  outbox: {
    put(id: string, request: OutboundRequest): Promise<void>;
    open(): Promise<OutboundRequest[]>;
    ack(id: string): Promise<void>;
  };
  leases: {
    claim(name: string, holder: string, nowMs: number): Promise<boolean>;
    renew(name: string, holder: string, nowMs: number): Promise<boolean>;
    release(name: string, holder: string): Promise<void>;
    holder(name: string, nowMs: number): Promise<string | undefined>;
  };
  seen: { has(id: string): Promise<boolean>; add(id: string): Promise<void> };
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
