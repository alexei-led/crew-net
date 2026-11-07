/** GitHub operations used by the application. */
export interface GitHubPort {
  /** List open pull requests. */
  listOpenPulls(): Promise<unknown[]>;
  /** List comments since a cursor. */
  listCommentsSince(cursor: string): Promise<unknown[]>;
  /** Get one pull request. */
  getPull(number: number): Promise<unknown>;
  /** Post a comment on a pull request. */
  postComment(number: number, body: string): Promise<void>;
  /** Update a pull request body. */
  updatePullBody(number: number, body: string): Promise<void>;
  /** Disable automatic merge on a pull request. */
  disableAutoMerge(number: number): Promise<void>;
  /** Get request and rate-limit statistics. */
  requestStats(): unknown;
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

/** Durable local coordination state. */
export interface StorePort {
  /** Read and update the polling cursor. */
  cursor: {
    get(): Promise<string | undefined>;
    set(value: string): Promise<void>;
  };
  /** Persist, enumerate and acknowledge inbound items. */
  inbox: {
    put(id: string, item: unknown): Promise<void>;
    list(): Promise<unknown[]>;
    ack(id: string): Promise<void>;
  };
  /** List open outbound requests. */
  outbox: { open(): Promise<unknown[]> };
  /** Coordinate session ownership. */
  leases: {
    claim(name: string): Promise<boolean>;
    renew(name: string): Promise<boolean>;
    release(name: string): Promise<void>;
    holder(name: string): Promise<string | undefined>;
  };
  /** Track items already processed. */
  seen: { has(id: string): Promise<boolean>; add(id: string): Promise<void> };
}

/** Source of current time for application use cases. */
export interface ClockPort {
  /** Return the current time in milliseconds since the Unix epoch. */
  now(): number;
}

/** Machine facts needed by the application. */
export interface EnvPort {
  /** Read the GitHub authentication token. */
  githubToken(): Promise<string>;
  /** Read the repository identity. */
  repoIdentity(): Promise<string>;
  /** Check whether managed policy restricts hooks. */
  managedHooksOnly(): Promise<boolean>;
}
