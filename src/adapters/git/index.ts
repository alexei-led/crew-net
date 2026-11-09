import { execFile } from "node:child_process";
import type {
  GitPort,
  MergeTreeResult,
  RemoteBranch,
  WorktreeBranch,
} from "../../ports/index";

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitRunner = (
  repoDir: string,
  args: string[],
  timeoutMs: number,
) => Promise<GitCommandResult>;

export const FETCH_TIMEOUT_MS = 120_000;
export const COMMAND_TIMEOUT_MS = 30_000;

/** Never wait for a password prompt: sync runs with nobody at the keyboard. */
export function gitEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const { GIT_ASKPASS: _askpass, ...env } = base;
  return { ...env, GIT_TERMINAL_PROMPT: "0" };
}

export const runGit: GitRunner = (repoDir, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      {
        cwd: repoDir,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        timeout: timeoutMs,
        env: gitEnv(),
      },
      (error, stdout, stderr) => {
        if (error?.killed) {
          reject(new Error(`timed out after ${timeoutMs / 1000} s`));
          return;
        }
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({
          stdout,
          stderr,
          exitCode: typeof error?.code === "number" ? error.code : 0,
        });
      },
    );
  });

/** Strips userinfo from URLs and GitHub token shapes from git output. */
export function redact(text: string): string {
  return text
    .replace(/(\w+:\/\/)[^/\s@]+@/g, "$1***@")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,})/g, "***");
}

export class GitCommandError extends Error {
  readonly stderr: string;
  constructor(
    readonly args: string[],
    stderr: string,
    readonly exitCode: number | undefined,
  ) {
    const clean = redact(stderr);
    super(
      redact(
        `git ${args.map((arg) => JSON.stringify(arg)).join(" ")} failed${clean ? `: ${clean.trim()}` : ""}`,
      ),
    );
    this.name = "GitCommandError";
    this.stderr = clean;
  }
}

const NOREPLY =
  /^(?:\d+\+)?([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)@users\.noreply\./i;

export class GitAdapter implements GitPort {
  constructor(
    private readonly repoDir: string,
    private readonly runner: GitRunner = runGit,
  ) {}

  private async run(
    args: string[],
    allowedExitCodes: number[] = [0],
    timeoutMs = COMMAND_TIMEOUT_MS,
  ): Promise<GitCommandResult> {
    let result: GitCommandResult;
    try {
      result = await this.runner(this.repoDir, args, timeoutMs);
    } catch (error) {
      // The cause is dropped on purpose: it can hold an unredacted remote URL.
      throw new GitCommandError(
        args,
        error instanceof Error ? error.message : String(error),
        undefined,
      );
    }
    if (!allowedExitCodes.includes(result.exitCode)) {
      throw new GitCommandError(args, result.stderr, result.exitCode);
    }
    return result;
  }

  async fetch(): Promise<void> {
    await this.run(["fetch", "--prune", "origin"], [0], FETCH_TIMEOUT_MS);
  }

  async worktreeBranches(): Promise<WorktreeBranch[]> {
    const { stdout } = await this.run([
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    const result: WorktreeBranch[] = [];
    for (const record of stdout.split("\0\0")) {
      const fields = record.split("\0");
      if (fields.includes("bare") || fields.includes("detached")) continue;
      const path = fields.find((field) => field.startsWith("worktree "));
      const branch = fields.find((field) =>
        field.startsWith("branch refs/heads/"),
      );
      if (path && branch)
        result.push({
          path: path.slice("worktree ".length),
          branch: branch.slice("branch refs/heads/".length),
        });
    }
    return result;
  }

  async remoteBranches(): Promise<RemoteBranch[]> {
    const { stdout } = await this.run([
      "for-each-ref",
      "--format=%(refname:lstrip=3)%00%(symref)%00%(committerdate:iso-strict)%00%(authoremail)",
      "refs/remotes/origin/",
    ]);
    const result: RemoteBranch[] = [];
    // Ref names cannot contain newlines or NUL, so one record per line is safe.
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const [name, symref, lastCommitAt, email] = line.split("\0");
      if (!name || symref || !lastCommitAt) continue;
      const authorEmail = (email ?? "").replace(/^<|>$/g, "");
      result.push({
        name,
        lastCommitAt,
        authorEmail,
        loginHint: authorEmail.match(NOREPLY)?.[1] ?? null,
      });
    }
    return result;
  }

  async mergeBase(a: string, b: string): Promise<string | undefined> {
    const args = ["merge-base", "--end-of-options", a, b];
    const result = await this.run(args, [0, 1]);
    const base = result.stdout.trim();
    if (result.exitCode === 1 && !base && !result.stderr.trim())
      return undefined;
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(base))
      throw new GitCommandError(args, result.stderr, result.exitCode);
    return base;
  }

  async mergeTree(a: string, b: string): Promise<MergeTreeResult> {
    const args = [
      "merge-tree",
      "--write-tree",
      "--name-only",
      "--no-messages",
      "-z",
      "--",
      a,
      b,
    ];
    const result = await this.run(args, [0, 1]);
    const [tree, ...fields] = result.stdout.split("\0");
    // Git also exits 1 for invalid refs, before it writes a result tree.
    if (!tree || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree)) {
      throw new GitCommandError(args, result.stderr, result.exitCode);
    }
    const paths = fields.filter(Boolean);
    return { clean: result.exitCode === 0, conflictedPaths: paths };
  }

  async changedFiles(base: string, head: string): Promise<string[]> {
    const { stdout } = await this.run([
      "diff",
      "--name-only",
      "-z",
      "--no-ext-diff",
      "--no-textconv",
      "--end-of-options",
      `${base}...${head}`,
      "--",
    ]);
    return stdout.split("\0").filter(Boolean);
  }
}
