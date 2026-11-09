import { CommandError, currentWorktree, type WriteContext } from "./context";

/** Repo-kit files, bundled into the CLI by the composition root. */
export interface InitKit {
  /** `repo-kit/templates/crew-net.yml`. */
  config: string;
  /** `repo-kit/workflows/crew-deps.yml`. */
  crewDeps: string;
  /** `repo-kit/workflows/crew-deps-rerun.yml`. */
  crewDepsRerun: string;
  /** `repo-kit/scripts/crew-deps.mjs`. */
  crewDepsScript: string;
}

export interface InitArgs {
  kit: InitKit;
  /** Also write the `crew-deps` workflows and script (adoption level 3). */
  deps?: boolean;
  /** Replace files that exist. */
  force?: boolean;
}

export interface InitResult {
  /** The working tree the files went into. */
  root: string;
  /** Paths relative to `root`. */
  written: string[];
  /** What the developer does next. */
  next: string[];
}

export const CONFIG_PATH = ".github/crew-net.yml";

/** `crew-net init [--deps] [--force]` (design: user guide). Writes files for review; never commits or pushes. */
export async function init(
  ctx: WriteContext,
  args: InitArgs,
): Promise<InitResult> {
  const tree = await currentWorktree(ctx);
  if (!tree)
    throw new CommandError(
      "usage",
      "run crew-net init inside a git working tree with a branch checked out",
    );
  const files: [string, string][] = [[CONFIG_PATH, args.kit.config]];
  if (args.deps)
    files.push(
      [".github/workflows/crew-deps.yml", args.kit.crewDeps],
      [".github/workflows/crew-deps-rerun.yml", args.kit.crewDepsRerun],
      [".github/scripts/crew-deps.mjs", args.kit.crewDepsScript],
    );
  const abs = (path: string) => `${tree.path}/${path}`;
  if (!args.force) {
    const existing: string[] = [];
    for (const [path] of files)
      if (await ctx.files.exists(abs(path))) existing.push(path);
    if (existing.length)
      throw new CommandError(
        "refused",
        `already present: ${existing.join(", ")}. Nothing was written; review them, then rerun with --force to replace`,
      );
  }
  for (const [path, content] of files)
    await ctx.files.write(abs(path), content, tree.path);
  const next = [
    "Review the files (git status, git diff) and edit them to fit the repo.",
    "Commit them through a PR; crew-net never commits or pushes.",
    `Set early-drafts: true in ${CONFIG_PATH} only after gating expensive CI jobs on drafts (see the comments there).`,
  ];
  if (args.deps)
    next.push(
      "After the PR merges, make the crew-deps job a required check in branch protection or a ruleset.",
    );
  return { root: tree.path, written: files.map(([p]) => p), next };
}

export function renderInit(r: InitResult): string {
  return [
    `wrote into ${r.root}:`,
    ...r.written.map((p) => `  ${p}`),
    "next:",
    ...r.next.map((n) => `  - ${n}`),
  ].join("\n");
}
