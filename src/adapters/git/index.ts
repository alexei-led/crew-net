import { execFile } from "node:child_process";
import type { GitPort, MergeTreeResult } from "../../ports/index";

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type GitRunner = (
  repoDir: string,
  args: string[],
) => Promise<GitCommandResult>;

const runGit: GitRunner = (repoDir, args) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd: repoDir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
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

export class GitCommandError extends Error {
  constructor(
    readonly args: string[],
    readonly stderr: string,
    readonly exitCode: number | undefined,
    options?: ErrorOptions,
  ) {
    super(
      `git ${args.map((arg) => JSON.stringify(arg)).join(" ")} failed${stderr ? `: ${stderr.trim()}` : ""}`,
      options,
    );
    this.name = "GitCommandError";
  }
}

export class GitAdapter implements GitPort {
  constructor(
    private readonly repoDir: string,
    private readonly runner: GitRunner = runGit,
  ) {}

  private async run(
    args: string[],
    allowedExitCodes: number[] = [0],
  ): Promise<GitCommandResult> {
    let result: GitCommandResult;
    try {
      result = await this.runner(this.repoDir, args);
    } catch (error) {
      const stderr = error instanceof Error ? error.message : String(error);
      throw new GitCommandError(args, stderr, undefined, { cause: error });
    }
    if (!allowedExitCodes.includes(result.exitCode)) {
      throw new GitCommandError(args, result.stderr, result.exitCode);
    }
    return result;
  }

  async fetch(): Promise<void> {
    await this.run(["fetch", "--prune", "origin"]);
  }

  async worktreeBranches(): Promise<string[]> {
    const { stdout } = await this.run([
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);
    const branches: string[] = [];
    for (const record of stdout.split("\0\0")) {
      const fields = record.split("\0");
      if (fields.includes("bare") || fields.includes("detached")) continue;
      const branch = fields.find((field) =>
        field.startsWith("branch refs/heads/"),
      );
      if (branch) branches.push(branch.slice("branch refs/heads/".length));
    }
    return branches;
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

  async changedPaths(a: string, base: string): Promise<string[]> {
    const { stdout } = await this.run([
      "diff",
      "--name-only",
      "-z",
      "--no-ext-diff",
      "--no-textconv",
      "--end-of-options",
      `${base}...${a}`,
      "--",
    ]);
    return stdout.split("\0").filter(Boolean);
  }
}
