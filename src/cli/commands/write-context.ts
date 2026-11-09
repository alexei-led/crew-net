import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { FilesAdapter } from "../../adapters/files/index";
import {
  CommandError,
  type WriteContext,
} from "../../app/commands/write/index";
import { UsageError } from "../args";
import type { CommandContext } from "../command";

const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;

/** A marker id: 8 random characters from [a-z0-9]. */
export function newId(): string {
  return Array.from(
    randomBytes(8),
    (b) => ID_ALPHABET[b % ID_ALPHABET.length],
  ).join("");
}

/**
 * A worker session never posts; its lead speaks for it (design §9.3).
 * The role comes from CREW_NET_ROLE, as for heartbeats.
 */
export function leadOnly(): void {
  if (process.env.CREW_NET_ROLE === "worker")
    throw new Error(
      "a worker session does not post (CREW_NET_ROLE=worker); ask your lead session to send it",
    );
}

/** Build the write commands' context: repo from the cwd's origin or `--repo`. */
export async function writeContext(ctx: CommandContext): Promise<WriteContext> {
  if (ctx.repo !== undefined && !OWNER_REPO.test(ctx.repo))
    throw new UsageError("--repo expects owner/repo");
  const ports = ctx.runtime.ports();
  // git spells worktree paths with symlinks resolved (/private/tmp on macOS).
  const cwd = realpathSync(ctx.runtime.cwd);
  const identity = await ports.env.repoIdentity(cwd).catch((error: unknown) => {
    if (ctx.repo !== undefined) return undefined;
    throw error;
  });
  const host = identity?.host ?? "github.com";
  const ghHost = process.env.GH_HOST?.trim().toLowerCase();
  const ghRepo = process.env.GH_REPO?.trim();
  return {
    github: ports.github(host),
    githubFor: (other) => ports.github(other),
    ...(ghHost ? { ghHost } : {}),
    ...(ghRepo ? { ghRepo } : {}),
    git: ports.git(cwd),
    store: ports.store,
    files: new FilesAdapter(),
    clock: ports.clock,
    host,
    repo: ctx.repo ?? (identity?.repo as string),
    cwd,
    newId,
  };
}

/** Print a result, or turn a CommandError into an exit code. */
export async function runWrite<T>(
  ctx: CommandContext,
  action: (w: WriteContext) => Promise<T>,
  render: (result: T, repo: string) => string,
): Promise<number> {
  const w = await writeContext(ctx);
  try {
    const result = await action(w);
    ctx.io.out(
      ctx.json ? `${JSON.stringify(result)}\n` : `${render(result, w.repo)}\n`,
    );
    return 0;
  } catch (error) {
    if (!(error instanceof CommandError)) throw error;
    if (error.code === "usage") throw new UsageError(error.message);
    ctx.io.err(`crew-net: ${error.message}\n`);
    if (ctx.json)
      ctx.io.out(
        `${JSON.stringify({ error: error.code, message: error.message })}\n`,
      );
    return 1;
  }
}

/** The one positional text argument, joined if the shell split it. */
export function textArg(words: readonly string[], what: string): string {
  const text = words.join(" ").trim();
  if (text === "") throw new UsageError(`${what} is missing`);
  return text;
}
