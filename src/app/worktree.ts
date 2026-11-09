import type { GitPort } from "../ports/index";

const trim = (path: string): string => path.replace(/\/+$/, "") || "/";

/** The worktree that contains `dir` (the longest matching path) and its branch. */
export async function worktreeOf(
  git: GitPort,
  dir: string,
): Promise<{ root: string; branch: string } | undefined> {
  const here = trim(dir);
  let best: { root: string; branch: string } | undefined;
  for (const wt of await git.worktreeBranches().catch(() => [])) {
    const root = trim(wt.path);
    if (here !== root && !here.startsWith(`${root}/`)) continue;
    if (!best || root.length > best.root.length)
      best = { root, branch: wt.branch };
  }
  return best;
}
