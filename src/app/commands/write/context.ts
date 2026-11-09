import type {
  ClockPort,
  FilesPort,
  GitHubPort,
  GitPort,
  PullRequest,
  StorePort,
} from "../../../ports/index";
import { findClosingKeywords, LOGIN_PATTERN } from "../../../protocol/index";

/** What the write commands need. The CLI builds it per invocation. */
export interface WriteContext {
  github: GitHubPort;
  git: GitPort;
  store: StorePort;
  files: FilesPort;
  clock: ClockPort;
  /** GitHub host of the repo, for store keys: `github.com`. */
  host: string;
  /** `owner/name` from the cwd's origin, or `--repo`. */
  repo: string;
  /** Absolute cwd, spelled as git spells worktree paths. */
  cwd: string;
  /** A fresh random marker id, `[a-z0-9]{8}`. Never derived from content. */
  newId(): string;
}

/** Why a command refused. `usage`: bad arguments. The rest: the request was understood and refused. */
export type CommandErrorCode =
  | "usage"
  | "not-found"
  | "refused"
  | "closing-keyword";

/** An expected failure with a message safe to show to the developer and the model. */
export class CommandError extends Error {
  constructor(
    readonly code: CommandErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CommandError";
  }
}

export const same = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/** A thread named on the command line. `repo` is `owner/name`. */
export interface ThreadRef {
  repo: string;
  number: number;
}

const LOGIN = new RegExp(`^@(${LOGIN_PATTERN})$`);
const NUMBER = /^#?([1-9]\d{0,9})$/;
const QUALIFIED = /^([\w.-]+\/[\w.-]+)#([1-9]\d{0,9})$/;
const URL_REF =
  /^https:\/\/[^/\s]+\/([\w.-]+\/[\w.-]+)\/(?:pull|issues)\/([1-9]\d{0,9})\/?$/;

/** `#N`, `N`, `owner/name#N` or a PR/Issue URL. Null when `text` is none of them. */
export function parseThreadRef(
  text: string,
  defaultRepo: string,
): ThreadRef | null {
  const plain = NUMBER.exec(text);
  if (plain) return { repo: defaultRepo, number: Number(plain[1]) };
  const qualified = QUALIFIED.exec(text) ?? URL_REF.exec(text);
  if (qualified)
    return { repo: qualified[1] as string, number: Number(qualified[2]) };
  return null;
}

export type Target = { login: string } | { thread: ThreadRef };

/** `@login` or a thread ref. */
export function parseTarget(text: string, defaultRepo: string): Target {
  const login = LOGIN.exec(text);
  if (login) return { login: login[1] as string };
  const thread = parseThreadRef(text, defaultRepo);
  if (thread) return { thread };
  throw new CommandError(
    "usage",
    `expected @login, #N, owner/repo#N or a PR URL, got ${JSON.stringify(text)}`,
  );
}

/** `#N` in its own repo, `owner/name#N` elsewhere. */
export const label = (ref: ThreadRef, home: string): string =>
  same(ref.repo, home) ? `#${ref.number}` : `${ref.repo}#${ref.number}`;

/** Refuse text that holds a closing keyword (design §7.1). Names each match. */
export function guardKeywords(what: string, text: string): void {
  const matches = findClosingKeywords(text);
  if (matches.length === 0) return;
  const list = matches
    .map((m) => `"${m.keyword} ${m.reference}" (line ${m.line})`)
    .join(", ");
  throw new CommandError(
    "closing-keyword",
    `${what} holds a closing keyword: ${list}. Reword it; link with "Refs #N"`,
  );
}

/** The worktree that holds the cwd, or null when the cwd is not inside one with a branch. */
export async function currentWorktree(
  ctx: WriteContext,
): Promise<{ path: string; branch: string } | null> {
  const inside = (await ctx.git.worktreeBranches())
    .filter((t) => ctx.cwd === t.path || ctx.cwd.startsWith(`${t.path}/`))
    .sort((a, b) => b.path.length - a.path.length);
  return inside[0] ?? null;
}

/** My open PR for the branch checked out at the cwd, or null. */
export async function currentPr(
  ctx: WriteContext,
  me: string,
): Promise<PullRequest | null> {
  const tree = await currentWorktree(ctx);
  if (!tree) return null;
  const pulls = await ctx.github.listOpenPulls(ctx.repo);
  return (
    pulls.find((p) => p.headRef === tree.branch && same(p.author, me)) ?? null
  );
}

/** Read a PR; a 404 becomes a `not-found` CommandError. */
export async function readPull(
  ctx: WriteContext,
  ref: ThreadRef,
): Promise<PullRequest> {
  try {
    return await ctx.github.getPull(ref.repo, ref.number);
  } catch (error) {
    if ((error as { status?: unknown }).status === 404)
      throw new CommandError(
        "not-found",
        `${label(ref, ctx.repo)} is not a pull request in ${ref.repo}`,
      );
    throw error;
  }
}
