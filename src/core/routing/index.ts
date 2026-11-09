/** An inbound item, as far as routing cares. */
export interface RouteItem {
  /** `owner/repo` of the thread the item sits on. */
  repo: string;
  /** PR or Issue number of the thread, if any. */
  thread?: number;
  /** Head branch of the PR; absent for Issues and items without a thread. */
  branch?: string;
  /** `owner/repo` of the PR head when it differs from `repo` (a fork). Fork branches are never checked out here. */
  headRepo?: string;
}

export type SessionRole = "lead" | "worker";

/** A live session on this laptop, from its heartbeat. Stale heartbeats are filtered out by the caller. */
export interface LiveSession {
  id: string;
  role: SessionRole;
  /** `owner/repo` of the session's working copy. */
  repo: string;
  /** Path of the session's working copy. */
  worktree: string;
  /** Branch checked out in the working copy. */
  branch: string;
  /** Path of the clone the working copy belongs to (shared by all its worktrees). */
  cloneRoot: string;
  /** Epoch ms of the session's last activity. */
  lastActiveMs: number;
}

/**
 * Which rule picked the session (design §9.3):
 * `checkout`: the session has the PR branch checked out.
 * `clone`: the PR branch is checked out in another worktree of the session's clone.
 * `repo`: most recently active session in the item's repo.
 * `any`: most recently active session in any repo; never woken.
 * `none`: no lead session; the item waits for the next session's digest.
 */
export type RouteStep = "checkout" | "clone" | "repo" | "any";

export type Route =
  | { session: string; step: RouteStep; wakeable: boolean }
  | { session: null; step: "none"; wakeable: false };

const NONE: Route = { session: null, step: "none", wakeable: false };

const same = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/** Most recent first; ties break on id so the outcome is stable. */
function mostRecent(sessions: readonly LiveSession[]): LiveSession | undefined {
  return [...sessions].sort(
    (a, b) => b.lastActiveMs - a.lastActiveMs || a.id.localeCompare(b.id),
  )[0];
}

/**
 * Pick exactly one session for an item, or none. First match wins:
 * 1. A lead whose working copy has the item's PR branch checked out.
 * 2. A lead whose clone has that branch in another worktree (a worker's).
 * 3. The most recently active lead in the item's repo.
 * 4. The most recently active lead in any repo; `wakeable` is false.
 * 5. None.
 * Workers are never a target. Several matches in one step: most recent.
 */
export function route(
  item: RouteItem,
  sessions: readonly LiveSession[],
): Route {
  const leads = sessions.filter((s) => s.role === "lead");
  const inRepo = leads.filter((s) => same(s.repo, item.repo));
  const pick = (candidates: LiveSession[], step: RouteStep): Route | null => {
    const session = mostRecent(candidates);
    return session
      ? { session: session.id, step, wakeable: step !== "any" }
      : null;
  };

  const { branch } = item;
  const fromFork =
    item.headRepo !== undefined && !same(item.headRepo, item.repo);
  if (branch !== undefined && !fromFork) {
    const checkedOut = sessions.filter(
      (s) => same(s.repo, item.repo) && s.branch === branch,
    );
    const roots = new Set(checkedOut.map((s) => s.cloneRoot));
    const hit =
      pick(
        inRepo.filter((s) => s.branch === branch),
        "checkout",
      ) ??
      pick(
        inRepo.filter((s) => roots.has(s.cloneRoot)),
        "clone",
      );
    if (hit) return hit;
  }
  return pick(inRepo, "repo") ?? pick(leads, "any") ?? NONE;
}
