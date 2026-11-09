import type { AppPorts } from "../../app/ports";
import { refFromSlug, repoKey } from "../../app/repo";
import type { Here } from "../../app/scope";
import { worktreeOf } from "../../app/worktree";
import { UsageError } from "../args";
import type { CommandContext } from "../command";

export interface Location {
  /** The repo the command is about; undefined outside a GitHub working copy without --repo. */
  here: Here | undefined;
  /** Root of the working copy of the cwd. */
  root: string | undefined;
  branch: string;
}

/** The repo from `--repo`, else the cwd's origin; a working copy only when they match. */
export async function locate(
  ctx: CommandContext,
  ports: AppPorts,
): Promise<Location> {
  const cwd = ctx.runtime.cwd;
  const identity = await ports.env.repoIdentity(cwd).catch(() => undefined);
  const cwdRef = identity
    ? refFromSlug(identity.host, identity.repo)
    : undefined;
  const wt = await worktreeOf(ports.git(cwd));
  const branch = wt?.branch ?? "";
  if (ctx.repo !== undefined) {
    const ref = refFromSlug(cwdRef?.host ?? "github.com", ctx.repo);
    if (!ref) throw new UsageError("--repo must be owner/repo");
    const same = cwdRef !== undefined && repoKey(cwdRef) === repoKey(ref);
    return {
      here: same ? { ref, dir: wt?.root ?? cwd } : { ref },
      root: same ? wt?.root : undefined,
      branch: same ? branch : "",
    };
  }
  return {
    here: cwdRef ? { ref: cwdRef, dir: wt?.root ?? cwd } : undefined,
    root: wt?.root,
    branch,
  };
}

/** Print `--json` output or text. */
export function print(ctx: CommandContext, json: unknown, text: string): void {
  ctx.io.out(ctx.json ? `${JSON.stringify(json)}\n` : text);
}
