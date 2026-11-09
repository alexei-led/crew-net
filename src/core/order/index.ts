import { parseStateBlock } from "../../protocol";

/** The PR the merge command targets. */
export interface MergeTarget {
  /** `owner/repo` of the PR. */
  repo: string;
  number: number;
  /** PR body as GitHub returns it. */
  body: string;
}

/** Current state of one same-repo PR named in `depends-on`. */
export interface DependencyFacts {
  number: number;
  merged: boolean;
}

export type GateDecision =
  | { decision: "allow"; advisory: string[] }
  | { decision: "deny"; reasons: string[]; advisory: string[] };

const CROSS_REPO_REF = /^([^#]+)#(\d+)$/;

/** True for `gh pr merge` in any form, including `--auto` and global flags before `pr`. */
export function isMergeCommand(argv: readonly string[]): boolean {
  if (argv[0]?.split("/").pop() !== "gh") return false;
  return argv.some((arg, i) => arg === "pr" && argv[i + 1] === "merge");
}

/**
 * Decide whether `argv` may run.
 * - Not a merge command: allow.
 * - Merge: deny while any same-repo `depends-on` PR is unmerged or unknown.
 * - Unreadable state block or bad depends-on ref: deny (fail closed).
 * - No state block: allow, nothing is declared.
 * - Cross-repo refs are listed in `advisory` and never block.
 */
export function gateDecision(
  pr: MergeTarget,
  deps: readonly DependencyFacts[],
  argv: readonly string[],
): GateDecision {
  if (!isMergeCommand(argv)) return { decision: "allow", advisory: [] };

  const parsed = parseStateBlock(pr.body);
  if (parsed === null) return { decision: "allow", advisory: [] };
  if (!parsed.ok) {
    return {
      decision: "deny",
      reasons: [`PR #${pr.number}: malformed state block (${parsed.detail})`],
      advisory: [],
    };
  }
  // The parser drops a bad ref and keeps the rest; the gate must not read that as "no dependency".
  const badRef = parsed.warnings.find((w) => w.field === "depends-on");
  if (badRef) {
    return {
      decision: "deny",
      reasons: [`PR #${pr.number}: bad depends-on ref ${badRef.value}`],
      advisory: [],
    };
  }

  const reasons: string[] = [];
  const advisory: string[] = [];
  for (const ref of parsed.state.dependsOn) {
    const cross = CROSS_REPO_REF.exec(ref);
    const refRepo = cross?.[1];
    if (
      refRepo !== undefined &&
      refRepo.toLowerCase() !== pr.repo.toLowerCase()
    ) {
      advisory.push(`depends-on ${ref} is in another repo; not enforced`);
      continue;
    }
    const number = Number(cross?.[2] ?? ref.slice(1));
    const dep = deps.find((d) => d.number === number);
    if (dep === undefined) {
      reasons.push(`depends-on #${number}: state unknown`);
    } else if (!dep.merged) {
      reasons.push(`depends-on #${number} is not merged`);
    }
  }
  return reasons.length > 0
    ? { decision: "deny", reasons, advisory }
    : { decision: "allow", advisory };
}
