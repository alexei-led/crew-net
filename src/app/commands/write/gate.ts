import {
  type DependencyState,
  dependencies,
  detectMerge,
  type MergeTarget,
  gate as orderGate,
} from "../../../core/order/index";
import type { GitHubPort } from "../../../ports/index";
import { parseRepoIdentity } from "../../../protocol/index";
import { currentWorktree, same, type WriteContext } from "./context";

export interface GateArgs {
  /** The Bash command: one argument holding the whole line, or its words. */
  argv: readonly string[];
  /** `gh alias list`, when the caller has it. Without it an unknown gh command gates the current PR. */
  aliases?: ReadonlyMap<string, string>;
  /** Give up and deny after this long. Default 10 s: a hook that times out may let the merge through. */
  deadlineMs?: number;
}

export interface GateResult {
  decision: "allow" | "deny";
  reasons: string[];
  /** PRs the command merges, as read from GitHub: `owner/name#N`. */
  checked: string[];
  /** True when the gate itself failed (GitHub unreadable, timeout). The decision is then deny. */
  failed: boolean;
}

export const GATE_DEADLINE_MS = 10_000;

/** Quote words so the line lexes back to the same words. */
function commandLine(argv: readonly string[]): string {
  if (argv.length === 1) return argv[0] as string;
  return argv
    .map((w) =>
      /^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replaceAll("'", `'\\''`)}'`,
    )
    .join(" ");
}

class GateFailure extends Error {}

/** A shell operator as its own word: the caller split the line itself, so the words cannot be trusted. */
const SHELL_WORD = /[;&|<>()`$\n]/;

/** Reasons can carry peer text (a teammate's `depends-on` value): one short line, no control characters. */
const REASON_MAX = 160;
const clean = (reason: string): string =>
  Array.from(reason, (c) => (c.charCodeAt(0) < 32 || c === "\x7f" ? " " : c))
    .join("")
    .slice(0, REASON_MAX);

/** True for a split line whose words hold shell operators: the gate denies it. */
const splitLine = (argv: readonly string[]): boolean =>
  argv.length > 1 && argv.some((w) => SHELL_WORD.test(w));

/** True when the command may merge, so the gate must look at it. */
export function mayMerge(
  argv: readonly string[],
  aliases?: ReadonlyMap<string, string>,
): boolean {
  if (splitLine(argv)) return true;
  return (
    detectMerge(commandLine(argv), aliases === undefined ? {} : { aliases })
      .kind !== "none"
  );
}

/** Where a target's PR lives, and the GitHub that reads it. */
interface Located {
  host: string;
  repo: string;
  github: GitHubPort;
}

const REMOTE_RANK: Record<string, number> = {
  upstream: 3,
  github: 2,
  origin: 1,
};

/**
 * The repo gh merges in when the command names none (design §11): `GH_REPO`,
 * else the remote `gh repo set-default` resolved (`gh-resolved`), else the
 * first remote in gh's order (upstream, github, origin, the rest). In a fork
 * clone that can be the parent, not origin.
 */
async function defaultRepo(
  ctx: WriteContext,
): Promise<{ host?: string; repo: string }> {
  if (ctx.ghRepo !== undefined) {
    const parts = ctx.ghRepo.split("/").filter(Boolean);
    if (parts.length === 2) return { repo: parts.join("/") };
    if (parts.length === 3)
      return {
        host: (parts[0] as string).toLowerCase(),
        repo: parts.slice(1).join("/"),
      };
    throw new GateFailure(`cannot read GH_REPO ${ctx.ghRepo}`);
  }
  const remotes = (await ctx.git.remotes()).flatMap((r) => {
    try {
      return [{ ...r, ...parseRepoIdentity(r.url) }];
    } catch {
      // A local path is no GitHub repo; a URL gh may read but crew-net cannot denies.
      if (/:/.test(r.url))
        throw new GateFailure(`cannot read remote ${r.name} (${r.url})`);
      return [];
    }
  });
  // gh keeps only the remotes on GH_HOST when it is set.
  const onHost =
    ctx.ghHost === undefined
      ? remotes
      : remotes.filter((r) => same(r.host, ctx.ghHost as string));
  if (ctx.ghHost !== undefined && remotes.length > 0 && onHost.length === 0)
    throw new GateFailure(`no remote on GH_HOST ${ctx.ghHost}`);
  const ranked = onHost
    .map((r, i) => ({ r, i, rank: REMOTE_RANK[r.name.toLowerCase()] ?? 0 }))
    .sort((a, b) => b.rank - a.rank || a.i - b.i)
    .map((x) => x.r);
  const resolved = ranked.find((r) => r.ghResolved !== undefined);
  if (resolved && resolved.ghResolved !== "base") {
    if (!/^[\w.-]+\/[\w.-]+$/.test(resolved.ghResolved ?? ""))
      throw new GateFailure(
        `cannot read gh's default repo ${resolved.ghResolved}`,
      );
    return { host: resolved.host, repo: resolved.ghResolved as string };
  }
  const chosen = resolved ?? ranked[0];
  return chosen
    ? { host: chosen.host, repo: chosen.repo }
    : { host: ctx.host, repo: ctx.repo };
}

/**
 * The host and repo gh sends the merge to. A repo named without a host goes
 * to `GH_HOST`, else github.com; in a clone on another host gh's choice is
 * not certain, so the host must be named.
 */
async function locate(
  ctx: WriteContext,
  target: MergeTarget,
): Promise<Located> {
  const named =
    target.repo !== undefined
      ? { ...(target.host ? { host: target.host } : {}), repo: target.repo }
      : await defaultRepo(ctx);
  const host = target.host ?? named.host ?? ctx.ghHost ?? ctx.host;
  if (
    named.host === undefined &&
    target.host === undefined &&
    ctx.ghHost === undefined &&
    !same(ctx.host, "github.com")
  )
    throw new GateFailure(
      `${named.repo} names no host and this clone is on ${ctx.host}; name it: -R ${ctx.host}/${named.repo}`,
    );
  // Any host other than the clone's needs its own token; none denies.
  const github = same(host, ctx.host) ? ctx.github : ctx.githubFor(host);
  return { host: host.toLowerCase(), repo: named.repo, github };
}

async function resolve(
  ctx: WriteContext,
  where: Located,
  target: MergeTarget,
): Promise<{ repo: string; number: number }> {
  const { repo } = where;
  if (target.pr !== undefined) return { repo, number: target.pr };
  let branch = target.branch;
  if (branch === undefined) {
    const tree = await currentWorktree(ctx);
    if (!tree)
      throw new GateFailure(
        "no branch checked out here to find the PR; name it: gh pr merge N",
      );
    branch = tree.branch;
    // gh follows the branch's upstream (`gh pr checkout` sets refs/pull/N/head).
    const upstream = await ctx.git.configValue(`branch.${branch}.merge`);
    if (upstream !== undefined && upstream !== `refs/heads/${branch}`)
      throw new GateFailure(
        `branch ${branch} tracks ${upstream}; name the PR: gh pr merge N`,
      );
  }
  const head = branch;
  const matches = (await where.github.listOpenPulls(repo)).filter(
    (p) => p.headRef === head,
  );
  if (matches.length !== 1 || !matches[0])
    throw new GateFailure(
      matches.length === 0
        ? `no open PR for branch ${head} in ${repo}`
        : `several open PRs for branch ${head} in ${repo}; name it: gh pr merge N`,
    );
  return { repo, number: matches[0].number };
}

async function dependencyState(
  github: GitHubPort,
  ref: { repo: string; number: number },
): Promise<DependencyState | null> {
  try {
    const pr = await github.getPull(ref.repo, ref.number);
    return { ...ref, state: pr.merged ? "merged" : pr.state };
  } catch {
    // Unread: the order gate denies it as unknown (fail closed).
    return null;
  }
}

async function check(
  ctx: WriteContext,
  target: MergeTarget,
): Promise<{ name: string; reasons: string[] }> {
  const where = await locate(ctx, target);
  const ref = await resolve(ctx, where, target);
  const name = `${same(where.host, ctx.host) ? "" : `${where.host}/`}${ref.repo}#${ref.number}`;
  const pr = await where.github.getPull(ref.repo, ref.number);
  const gated = { repo: ref.repo, number: ref.number, body: pr.body };
  const deps = dependencies(gated);
  // Dependencies are on the PR's host: depends-on names no host.
  const states = deps.ok
    ? (
        await Promise.all(
          deps.refs.map((d) => dependencyState(where.github, d)),
        )
      ).filter((s): s is DependencyState => s !== null)
    : [];
  const decision = orderGate(gated, states);
  return {
    name,
    reasons:
      decision.decision === "deny"
        ? decision.reasons.map((r) => `${name}: ${r}`)
        : [],
  };
}

async function decide(
  ctx: WriteContext,
  args: GateArgs,
): Promise<Omit<GateResult, "failed">> {
  if (splitLine(args.argv))
    return {
      decision: "deny",
      reasons: [
        "crew-net gate: the command was split into words; pass the whole line as one argument",
      ],
      checked: [],
    };
  const detection = detectMerge(
    commandLine(args.argv),
    args.aliases === undefined ? {} : { aliases: args.aliases },
  );
  if (detection.kind === "none")
    return { decision: "allow", reasons: [], checked: [] };
  if (detection.kind === "deny")
    return {
      decision: "deny",
      reasons: [clean(detection.reason)],
      checked: [],
    };
  const results = await Promise.all(
    detection.targets.map((t) => check(ctx, t)),
  );
  const checked = [...new Set(results.map((r) => r.name))];
  const reasons = results.flatMap((r) => r.reasons).map(clean);
  return {
    decision: reasons.length ? "deny" : "allow",
    reasons: [...new Set(reasons)],
    checked,
  };
}

/**
 * `crew-net gate --json -- <command>` (design §11): may this Bash command
 * merge now? Reads the PR and every dependency, in any repo, from GitHub at
 * call time. Anything it cannot read or decide denies (fail closed).
 */
export async function gate(
  ctx: WriteContext,
  args: GateArgs,
): Promise<GateResult> {
  const deadlineMs = args.deadlineMs ?? GATE_DEADLINE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new GateFailure(`no answer within ${deadlineMs} ms`)),
      deadlineMs,
    );
  });
  let result: GateResult;
  try {
    result = {
      ...(await Promise.race([decide(ctx, args), deadline])),
      failed: false,
    };
  } catch (error) {
    const why =
      error instanceof GateFailure
        ? error.message
        : `cannot read GitHub (${(error as Error).message})`;
    result = {
      decision: "deny",
      reasons: [`crew-net gate: ${why}; denied (fail closed)`],
      checked: [],
      failed: true,
    };
  } finally {
    clearTimeout(timer);
  }
  // A command that merges nothing is not a gate decision worth a stats line.
  if (result.decision === "allow" && result.checked.length === 0) return result;
  await ctx.store.events
    .append({
      type: "gate",
      decision: result.decision,
      failed: result.failed,
      checked: result.checked,
      // stats counts blocked merges per repo; a multi-PR command counts under its first.
      ...(result.checked[0] ? { repo: result.checked[0].split("#")[0] } : {}),
      reasons: result.reasons.length,
      atMs: ctx.clock.now(),
    })
    .catch(() => undefined);
  return result;
}

export function renderGate(r: GateResult): string {
  if (r.decision === "allow")
    return r.checked.length
      ? `allow: ${r.checked.join(", ")} may merge`
      : "allow: no merge";
  return [`deny:`, ...r.reasons.map((x) => `  ${x}`)].join("\n");
}

/** Exit code for the CLI: decisions are 0, a failed gate is 1. */
export const gateExitCode = (r: GateResult): number => (r.failed ? 1 : 0);
