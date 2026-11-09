import { parseStateBlock } from "../../protocol";

export * from "./merge";

/** A PR named in `depends-on`, with its repo made explicit. */
export interface DependencyRef {
  /** `owner/name`, lowercase. */
  repo: string;
  number: number;
}

/** State of one dependency as read from GitHub at gate time. */
export interface DependencyState extends DependencyRef {
  state: "open" | "merged" | "closed";
}

/** The PR being merged, read from GitHub at gate time. */
export interface GatedPr {
  /** `owner/name` of the PR. */
  repo: string;
  number: number;
  body: string;
}

export type Dependencies =
  | { ok: true; refs: DependencyRef[] }
  | { ok: false; reason: string };

export type GateDecision =
  | { decision: "allow" }
  | { decision: "deny"; reasons: string[] };

const REF = /^(?:([\w.-]+\/[\w.-]+))?#(\d+)$/;

const key = (ref: DependencyRef): string => `${ref.repo}#${ref.number}`;

/**
 * The PRs `pr` depends on, in every repo, so the caller knows what to read.
 * No state block: none. A block that cannot be read, or a `depends-on` value
 * the parser skipped, is an error: the gate must not read it as "no
 * dependency".
 */
export function dependencies(pr: GatedPr): Dependencies {
  const parsed = parseStateBlock(pr.body);
  if (parsed === null) return { ok: true, refs: [] };
  if (!parsed.ok)
    return {
      ok: false,
      reason: `PR #${pr.number}: malformed state block (${parsed.detail})`,
    };
  const bad = parsed.warnings.find((w) => w.field === "depends-on");
  if (bad)
    return {
      ok: false,
      reason: `PR #${pr.number}: bad depends-on ref ${bad.value}`,
    };
  const refs: DependencyRef[] = [];
  for (const ref of parsed.state.dependsOn) {
    const m = REF.exec(ref);
    if (!m)
      return {
        ok: false,
        reason: `PR #${pr.number}: bad depends-on ref ${ref}`,
      };
    const dep = {
      repo: (m[1] ?? pr.repo).toLowerCase(),
      number: Number(m[2]),
    };
    if (!refs.some((r) => key(r) === key(dep))) refs.push(dep);
  }
  return { ok: true, refs };
}

const label = (pr: GatedPr, dep: DependencyRef): string =>
  dep.repo === pr.repo.toLowerCase() ? `#${dep.number}` : key(dep);

/**
 * Decide whether `pr` may merge now. `states` holds what the caller read for
 * each dependency; a dependency with no state is unknown, and unknown denies
 * (fail closed). Same-repo and cross-repo dependencies are enforced alike.
 */
export function gate(
  pr: GatedPr,
  states: readonly DependencyState[],
): GateDecision {
  const deps = dependencies(pr);
  if (!deps.ok) return { decision: "deny", reasons: [deps.reason] };
  // Two reads of one dependency: the less merged one counts (fail closed).
  const byKey = new Map<string, DependencyState["state"]>();
  for (const s of states) {
    const k = key({ repo: s.repo.toLowerCase(), number: s.number });
    if (byKey.get(k) === undefined || byKey.get(k) === "merged")
      byKey.set(k, s.state);
  }
  const reasons: string[] = [];
  for (const dep of deps.refs) {
    const name = label(pr, dep);
    switch (byKey.get(key(dep))) {
      case "merged":
        break;
      case "open":
        reasons.push(`depends-on ${name} is not merged`);
        break;
      case "closed":
        reasons.push(`depends-on ${name}: dependency closed without merge`);
        break;
      default:
        reasons.push(`depends-on ${name}: state unknown`);
    }
  }
  return reasons.length > 0
    ? { decision: "deny", reasons }
    : { decision: "allow" };
}
