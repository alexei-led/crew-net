import type { Checkout, GitPort } from "../ports/index";

/** The worktree, clone and branch of the directory `git` runs in; undefined outside a repository. */
export const worktreeOf = (git: GitPort): Promise<Checkout | undefined> =>
  git.checkout().catch(() => undefined);
