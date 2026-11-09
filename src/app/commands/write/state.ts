import type { PullRequest } from "../../../ports/index";
import {
  PR_STATES,
  type PrState,
  parseStateBlock,
  replaceStateBlock,
} from "../../../protocol/index";
import {
  CommandError,
  currentPr,
  guardKeywords,
  label,
  parseThreadRef,
  readPull,
  same,
  type ThreadRef,
  type WriteContext,
} from "./context";

interface TargetArgs {
  /** `#N`, `owner/repo#N` or a URL. Default: my PR for the current branch. */
  pr?: string;
}

export interface StateResult {
  repo: string;
  number: number;
  /** False when every field already had this value: nothing was written. */
  changed: boolean;
  state?: PrState;
  scope: string[];
  dependsOn: string[];
  /** `dep add` turned auto-merge off, so the server cannot merge before the dependency. */
  autoMergeDisabled: boolean;
}

interface Fields {
  state?: PrState;
  scope: string[];
  dependsOn: string[];
}

async function targetPr(
  ctx: WriteContext,
  args: TargetArgs,
  me: string,
): Promise<{ pr: PullRequest; ref: ThreadRef }> {
  if (args.pr === undefined) {
    const pr = await currentPr(ctx, me);
    if (!pr)
      throw new CommandError(
        "not-found",
        `the current branch has no open PR of yours in ${ctx.repo}; push and open one, or pass --pr #N`,
      );
    return { pr, ref: { repo: ctx.repo, number: pr.number } };
  }
  const ref = parseThreadRef(args.pr, ctx.repo);
  if (!ref)
    throw new CommandError(
      "usage",
      `--pr expects #N, owner/repo#N or a URL, got ${JSON.stringify(args.pr)}`,
    );
  const pr = await readPull(ctx, ref);
  // Changing another developer's PR is theirs to confirm (design §13).
  if (!same(pr.author, me))
    throw new CommandError(
      "refused",
      `${label(ref, ctx.repo)} belongs to @${pr.author}; crew-net only edits your own PRs`,
    );
  if (pr.state !== "open")
    throw new CommandError("refused", `${label(ref, ctx.repo)} is not open`);
  return { pr, ref };
}

/** The block's fields, or a refusal when rewriting it could drop something. */
function currentFields(pr: PullRequest, ref: ThreadRef, home: string): Fields {
  const parsed = parseStateBlock(pr.body);
  if (parsed === null) return { scope: [], dependsOn: [] };
  if (!parsed.ok)
    throw new CommandError(
      "refused",
      `${label(ref, home)}: the state block is unreadable (${parsed.detail}); fix the PR body by hand`,
    );
  // A skipped ref would vanish on rewrite and with it a dependency the author meant.
  const bad = parsed.warnings.find((w) => w.field === "depends-on");
  if (bad)
    throw new CommandError(
      "refused",
      `${label(ref, home)}: depends-on has an unreadable entry ${JSON.stringify(bad.value)} (${bad.detail}); fix the PR body by hand`,
    );
  const { state, scope, dependsOn } = parsed.state;
  return { ...(state === undefined ? {} : { state }), scope, dependsOn };
}

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Write `next` into the PR body when a field changed (design §7.1: no heartbeats). */
async function write(
  ctx: WriteContext,
  pr: PullRequest,
  ref: ThreadRef,
  current: Fields,
  next: Fields,
  before: () => Promise<boolean> = async () => false,
): Promise<StateResult> {
  const result = {
    repo: ref.repo,
    number: ref.number,
    ...(next.state === undefined ? {} : { state: next.state }),
    scope: next.scope,
    dependsOn: next.dependsOn,
  };
  if (
    current.state === next.state &&
    sameList(current.scope, next.scope) &&
    sameList(current.dependsOn, next.dependsOn)
  )
    return { ...result, changed: false, autoMergeDisabled: false };
  const replaced = replaceStateBlock(pr.body, next);
  if (!replaced.ok) {
    const error = replaced.error;
    switch (error.reason) {
      case "closing-keyword":
        throw new CommandError(
          "closing-keyword",
          `the state block would hold a closing keyword (${error.matches.map((m) => `${m.keyword} ${m.reference}`).join(", ")}); reword it`,
        );
      case "invalid":
        throw new CommandError(
          "usage",
          `bad ${error.field}: ${JSON.stringify(error.detail)}`,
        );
      default:
        throw new CommandError(
          "refused",
          `the state block is unreadable (${error.detail}); fix the PR body by hand`,
        );
    }
  }
  const autoMergeDisabled = await before();
  await ctx.github.updatePullBody(ref.repo, ref.number, replaced.body);
  return { ...result, changed: true, autoMergeDisabled };
}

export interface StateArgs extends TargetArgs {
  state: string;
  /** Replaces the scope. Absent: keep it. */
  scope?: string[];
}

/** `crew-net state <planning|building|review|blocked> [--scope p…] [--pr N]`. */
export async function state(
  ctx: WriteContext,
  args: StateArgs,
): Promise<StateResult> {
  const value = PR_STATES.find((s) => s === args.state);
  if (!value)
    throw new CommandError(
      "usage",
      `state must be one of ${PR_STATES.join(", ")}, got ${JSON.stringify(args.state)}`,
    );
  const scope = args.scope?.map((p) => p.trim()).filter(Boolean);
  for (const path of scope ?? []) guardKeywords("the scope", path);
  const me = await ctx.github.viewer();
  const { pr, ref } = await targetPr(ctx, args, me);
  const current = currentFields(pr, ref, ctx.repo);
  return write(ctx, pr, ref, current, {
    state: value,
    scope: scope ?? current.scope,
    dependsOn: current.dependsOn,
  });
}

export interface DepArgs extends TargetArgs {
  action: string;
  /** The dependency: `#N`, `owner/repo#N` or a PR URL. */
  ref: string;
}

/** `#N` in the PR's own repo, `owner/name#N` elsewhere: the state block form. */
const blockRef = (dep: ThreadRef, home: string): string =>
  same(dep.repo, home) ? `#${dep.number}` : `${dep.repo}#${dep.number}`;

const sameDep = (a: string, b: ThreadRef, home: string): boolean => {
  const parsed = parseThreadRef(a, home);
  return (
    parsed !== null && same(parsed.repo, b.repo) && parsed.number === b.number
  );
};

/** `crew-net dep add|rm <PR ref> [--pr N]`. */
export async function dep(
  ctx: WriteContext,
  args: DepArgs,
): Promise<StateResult> {
  if (args.action !== "add" && args.action !== "rm")
    throw new CommandError(
      "usage",
      `dep takes add or rm, got ${JSON.stringify(args.action)}`,
    );
  const me = await ctx.github.viewer();
  const { pr, ref } = await targetPr(ctx, args, me);
  const depRef = parseThreadRef(args.ref, ref.repo);
  if (!depRef)
    throw new CommandError(
      "usage",
      `expected #N, owner/repo#N or a PR URL, got ${JSON.stringify(args.ref)}`,
    );
  const current = currentFields(pr, ref, ctx.repo);
  const rest = current.dependsOn.filter((d) => !sameDep(d, depRef, ref.repo));
  if (args.action === "rm")
    return write(ctx, pr, ref, current, { ...current, dependsOn: rest });

  if (same(depRef.repo, ref.repo) && depRef.number === ref.number)
    throw new CommandError("usage", "a PR cannot depend on itself");
  if (rest.length < current.dependsOn.length)
    return write(ctx, pr, ref, current, current);
  const target = await readPull(ctx, depRef);
  if (target.state === "closed" && !target.merged)
    throw new CommandError(
      "refused",
      `${label(depRef, ref.repo)} was closed without merge; the gate would block forever`,
    );
  const next = {
    ...current,
    dependsOn: [...current.dependsOn, blockRef(depRef, ref.repo)],
  };
  // Auto-merge would complete on the server, past every client gate (design §11).
  // Off first: if the body write then fails, nothing is left unguarded.
  return write(ctx, pr, ref, current, next, async () => {
    if (!pr.autoMerge || target.merged) return false;
    await ctx.github.disableAutoMerge(ref.repo, ref.number);
    return true;
  });
}

/** One line for the terminal. Refs and states only. */
export function renderState(r: StateResult, home: string): string {
  const where = label({ repo: r.repo, number: r.number }, home);
  const fields = [
    r.state === undefined ? undefined : `state: ${r.state}`,
    r.scope.length ? `scope: ${r.scope.join(", ")}` : undefined,
    `depends-on: ${r.dependsOn.length ? r.dependsOn.join(", ") : "none"}`,
  ].filter(Boolean);
  const head = r.changed ? `updated ${where}` : `${where} unchanged`;
  const auto = r.autoMergeDisabled
    ? "; auto-merge turned off until the dependency merges"
    : "";
  return `${head}: ${fields.join("; ")}${auto}`;
}
