/** Who a message is for. Replaced when routing is rewritten to design §9.3. */
export interface Address {
  developer: string;
  name?: string;
}

/** An inbound crew message, already parsed. */
export interface RoutedMessage {
  /** Parsed `crew → developer[/name]` line. */
  address: Address;
  /** PR or Issue number the comment sits on. */
  pr?: number;
}

/** An open PR in the repo. */
export interface PullFacts {
  number: number;
  /** GitHub login of the PR author. */
  author: string;
  branch: string;
  changedPaths: string[];
  /** `lead` field of the PR's state block, `developer/name`, if it has one. */
  lead?: string;
}

/** A branch a lead works on: a worktree checkout or a local branch with an open PR. */
export interface LeadWork {
  branch: string;
  changedPaths: string[];
}

export interface LeadFacts {
  /** `developer/name`. */
  address: string;
  developer: string;
  /** Holds an unexpired lease right now. */
  leaseLive: boolean;
  /** Epoch ms of the lead's last activity. */
  lastActiveMs: number;
  work: LeadWork[];
}

export interface RoutingFacts {
  pulls: PullFacts[];
  leads: LeadFacts[];
}

export type RouteStep = "state-block" | "overlap" | "recent-lease" | "named";

export type Route = { lead: string; step: RouteStep } | { wait: true };

const WAIT: Route = { wait: true };
const same = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/** Most recent first; ties break on address so the outcome is stable. */
function mostRecent(leads: LeadFacts[]): LeadFacts | undefined {
  return [...leads].sort(
    (a, b) =>
      b.lastActiveMs - a.lastActiveMs || a.address.localeCompare(b.address),
  )[0];
}

function overlaps(work: LeadWork[], pull: PullFacts): boolean {
  const paths = new Set(pull.changedPaths);
  return work.some(
    (w) => w.branch === pull.branch || w.changedPaths.some((p) => paths.has(p)),
  );
}

/**
 * Pick exactly one recipient lead for a message, or wait.
 *
 * `crew → dev/name`: that lead if it holds a lease, else wait.
 * `crew → dev`, first match wins:
 * 1. The comment is on one of the developer's PRs: the lead in its state block.
 * 2. The developer's lead whose open PR or worktree branch overlaps that PR.
 * 3. The developer's most recently active lead with a live lease.
 * 4. Wait for the developer's next lead.
 */
export function route(message: RoutedMessage, facts: RoutingFacts): Route {
  const { developer, name } = message.address;
  const mine = facts.leads.filter((l) => same(l.developer, developer));

  if (name !== undefined) {
    const target = `${developer}/${name}`;
    const lead = mine.find((l) => same(l.address, target));
    return lead?.leaseLive ? { lead: lead.address, step: "named" } : WAIT;
  }

  const pull =
    message.pr === undefined
      ? undefined
      : facts.pulls.find((p) => p.number === message.pr);

  // The state block names the owner even when no session holds it right now.
  if (
    pull?.lead !== undefined &&
    same(pull.lead.split("/")[0] ?? "", developer)
  ) {
    return { lead: pull.lead, step: "state-block" };
  }

  if (pull) {
    const lead = mostRecent(mine.filter((l) => overlaps(l.work, pull)));
    if (lead) return { lead: lead.address, step: "overlap" };
  }

  const lead = mostRecent(mine.filter((l) => l.leaseLive));
  return lead ? { lead: lead.address, step: "recent-lease" } : WAIT;
}
