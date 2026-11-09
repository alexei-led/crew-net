import { execFile } from "node:child_process";
import { basename, dirname } from "node:path";
import type {
  BranchAuthor,
  Checkout,
  GitPort,
  GitRemote,
  LandedCommit,
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

/**
 * Never wait for a password prompt: sync runs with nobody at the keyboard.
 * An empty GIT_ASKPASS stops git falling back to core.askPass and SSH_ASKPASS;
 * GIT_TERMINAL_PROMPT=0 then refuses the terminal prompt. SSH passphrase prompts
 * are bounded by the command timeout.
 */
export function gitEnv(
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const { SSH_ASKPASS: _ssh, ...env } = base;
  return { ...env, GIT_ASKPASS: "", GIT_TERMINAL_PROMPT: "0" };
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
        if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
          reject(new Error("output exceeded 64 MiB"));
          return;
        }
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

/** `git show` stderr when the ref or the path is absent, as opposed to a broken repo. */
const MISSING_OBJECT =
  /does not exist|exists on disk, but not in|unknown revision|bad revision|invalid object name|not a valid object name/i;

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

  async checkout(): Promise<Checkout> {
    const args = [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ];
    const { stdout } = await this.run(args);
    const [root, common] = stdout.split("\n");
    if (!root || !common) throw new GitCommandError(args, "", 0);
    // Exit 1 on a detached HEAD; symbolic-ref also works on an unborn branch.
    const head = await this.run(["symbolic-ref", "-q", "HEAD"], [0, 1]);
    const ref = head.stdout.trim();
    return {
      root,
      // `<clone>/.git` names its clone; a bare repo is the clone itself.
      clone: basename(common) === ".git" ? dirname(common) : common,
      ...(ref.startsWith("refs/heads/")
        ? { branch: ref.slice("refs/heads/".length) }
        : {}),
    };
  }

  async remotes(): Promise<GitRemote[]> {
    // Exit 1: no such keys. -z: `key\nvalue\0` records.
    const { stdout } = await this.run(
      ["config", "-z", "--get-regexp", "^remote\\..*\\.(url|gh-resolved)$"],
      [0, 1],
    );
    const byName = new Map<string, { url?: string; ghResolved?: string }>();
    for (const record of stdout.split("\0")) {
      const m = /^remote\.(.+)\.(url|gh-resolved)\n([\s\S]*)$/.exec(record);
      if (!m) continue;
      const name = m[1] as string;
      const value = m[3] as string;
      const entry = byName.get(name) ?? {};
      if (m[2] === "url") entry.url ??= value;
      else entry.ghResolved = value;
      byName.set(name, entry);
    }
    return [...byName].flatMap(([name, e]) =>
      e.url === undefined
        ? []
        : [
            {
              name,
              url: e.url,
              ...(e.ghResolved ? { ghResolved: e.ghResolved } : {}),
            },
          ],
    );
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
      "--format=%(refname:lstrip=3)%00%(symref)%00%(committerdate:iso-strict)",
      "refs/remotes/origin/",
    ]);
    const result: RemoteBranch[] = [];
    // Ref names cannot contain newlines or NUL, so one record per line is safe.
    for (const line of stdout.split("\n")) {
      if (!line) continue;
      const [name, symref, lastCommitAt] = line.split("\0");
      if (!name || symref || !lastCommitAt) continue;
      result.push({ name, lastCommitAt });
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
      // A rename must list its old path too, or an edit to that path elsewhere looks unrelated.
      "--no-renames",
      "--end-of-options",
      `${base}...${head}`,
      "--",
    ]);
    return stdout.split("\0").filter(Boolean);
  }

  async showFile(ref: string, path: string): Promise<string | undefined> {
    const result = await this.run(
      ["show", "--end-of-options", `${ref}:${path}`],
      [0, 128],
    );
    if (result.exitCode === 0) return result.stdout;
    if (MISSING_OBJECT.test(result.stderr)) return undefined;
    throw new GitCommandError(
      ["show", `${ref}:${path}`],
      result.stderr,
      result.exitCode,
    );
  }

  async branchAuthor(
    base: string,
    tip: string,
  ): Promise<BranchAuthor | undefined> {
    const { stdout } = await this.run([
      "log",
      "--first-parent",
      "--no-merges",
      "--max-count=1",
      "--format=%ae",
      "--end-of-options",
      `${base}..${tip}`,
      "--",
    ]);
    const authorEmail = stdout.trim();
    if (!authorEmail) return undefined;
    return {
      authorEmail,
      loginHint: authorEmail.match(NOREPLY)?.[1] ?? null,
    };
  }

  async landed(from: string, to: string): Promise<LandedCommit[]> {
    // \x01 starts a record and \x02 splits its fields; neither can appear in
    // an email or a one-line subject. A path holding \x01 would only add a
    // bogus record to the radar's input.
    const { stdout } = await this.run([
      "log",
      "--first-parent",
      "-m",
      "--no-renames",
      "--name-only",
      "-z",
      "--max-count=100",
      "--format=%x01%H%x02%ae%x02%s",
      "--end-of-options",
      `${from}..${to}`,
      "--",
    ]);
    const result: LandedCommit[] = [];
    for (const record of stdout.split("\x01").slice(1)) {
      const end = record.indexOf("\0");
      const head = end === -1 ? record : record.slice(0, end);
      const rest = end === -1 ? "" : record.slice(end + 1).replace(/^\n/, "");
      const [sha, authorEmail = "", subject = ""] = head.split("\x02");
      if (!sha) continue;
      result.push({
        sha,
        subject,
        authorEmail,
        loginHint: authorEmail.match(NOREPLY)?.[1] ?? null,
        paths: rest.split("\0").filter(Boolean),
      });
    }
    return result;
  }
}
