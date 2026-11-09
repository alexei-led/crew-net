import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMMAND_TIMEOUT_MS,
  FETCH_TIMEOUT_MS,
  GitAdapter,
  GitCommandError,
  type GitRunner,
  gitEnv,
  redact,
  runGit,
} from "./index";

// Real git spawns many processes; under full-suite load 5 s is not enough.
setDefaultTimeout(30_000);

let root: string;
let repo: string;
let adapter: GitAdapter;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commit(message: string): void {
  git("add", "-A");
  git("commit", "-m", message);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "crew-net-git-"));
  repo = join(root, "repo");
  execFileSync("git", ["init", "--initial-branch=main", repo], {
    stdio: "ignore",
  });
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repo, "shared.txt"), "base\n");
  writeFileSync(
    join(repo, "rename.txt"),
    "some content for rename detection\n",
  );
  commit("base");
  adapter = new GitAdapter(repo);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("real git", () => {
  test("merges clean branches and reports no conflicts", async () => {
    git("branch", "other");
    writeFileSync(join(repo, "new.txt"), "new\n");
    commit("new file");
    expect(await adapter.mergeTree("main", "other")).toEqual({
      clean: true,
      conflictedPaths: [],
    });
  });

  test("reports exact conflict paths including unusual names", async () => {
    const path = "conflict\nwith tab\t.txt";
    writeFileSync(join(repo, path), "base\n");
    commit("add unusual file");
    git("branch", "other");
    writeFileSync(join(repo, path), "ours\n");
    writeFileSync(join(repo, "shared.txt"), "ours\n");
    commit("ours");
    git("switch", "other");
    writeFileSync(join(repo, path), "theirs\n");
    writeFileSync(join(repo, "shared.txt"), "theirs\n");
    commit("theirs");
    expect(await adapter.mergeTree("main", "other")).toEqual({
      clean: false,
      conflictedPaths: [path, "shared.txt"],
    });
  });

  test("reports rename/delete conflicts", async () => {
    git("branch", "other");
    git("mv", "rename.txt", "renamed.txt");
    commit("rename");
    git("switch", "other");
    git("rm", "rename.txt");
    commit("delete");
    expect(await adapter.mergeTree("main", "other")).toEqual({
      clean: false,
      conflictedPaths: ["renamed.txt"],
    });
  });

  test("lists linked worktrees with paths but excludes detached HEADs", async () => {
    git("worktree", "add", "-b", "feature/one", join(root, "linked"));
    git("worktree", "add", "--detach", join(root, "detached"), "HEAD");
    const main = git("rev-parse", "--show-toplevel");
    const linked = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: join(root, "linked"),
      encoding: "utf8",
    }).trim();
    expect(await adapter.worktreeBranches()).toEqual([
      { path: main, branch: "main" },
      { path: linked, branch: "feature/one" },
    ]);
  });

  test("merge base of forked branches, undefined without shared history", async () => {
    const fork = git("rev-parse", "HEAD");
    git("branch", "feature");
    writeFileSync(join(repo, "main.txt"), "main\n");
    commit("main moves");
    expect(await adapter.mergeBase("main", "feature")).toBe(fork);
    git("switch", "--orphan", "lonely");
    writeFileSync(join(repo, "lonely.txt"), "x\n");
    commit("orphan");
    expect(await adapter.mergeBase("main", "lonely")).toBeUndefined();
    await expect(adapter.mergeBase("main", "missing")).rejects.toBeInstanceOf(
      GitCommandError,
    );
  });

  test("remote branches carry tip time, author email and a noreply login hint", async () => {
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("switch", "-c", "feat/maria");
    writeFileSync(join(repo, "m.txt"), "m\n");
    git("add", "-A");
    git(
      "-c",
      "user.email=12345+maria-dev@users.noreply.github.com",
      "commit",
      "-m",
      "maria",
    );
    git("update-ref", "refs/remotes/origin/feat/maria", "HEAD");
    writeFileSync(join(repo, "d.txt"), "d\n");
    git("add", "-A");
    git("-c", "user.email=dmitri@corp.example", "commit", "-m", "dmitri");
    git("update-ref", "refs/remotes/origin/dmitri", "HEAD");
    git("update-ref", "refs/remotes/upstream/other", "HEAD");
    git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
    const branches = await adapter.remoteBranches();
    expect(branches.map((b) => [b.name, b.authorEmail, b.loginHint])).toEqual([
      ["dmitri", "dmitri@corp.example", null],
      ["feat/maria", "12345+maria-dev@users.noreply.github.com", "maria-dev"],
      ["main", "test@example.test", null],
    ]);
    for (const branch of branches)
      expect(Number.isNaN(Date.parse(branch.lastCommitAt))).toBe(false);
  });

  test("changed files list both paths of a rename", async () => {
    git("switch", "-c", "feature");
    git("mv", "rename.txt", "renamed.txt");
    commit("rename");
    expect((await adapter.changedFiles("main", "feature")).sort()).toEqual([
      "rename.txt",
      "renamed.txt",
    ]);
  });

  test("changed files from the merge base, preserving unusual paths", async () => {
    git("branch", "feature");
    writeFileSync(join(repo, "base-only.txt"), "main\n");
    commit("main change");
    git("switch", "feature");
    const path = "line\nbreak.txt";
    writeFileSync(join(repo, path), "feature\n");
    commit("feature change");
    expect(await adapter.changedFiles("main", "feature")).toEqual([path]);
  });

  test("returns an actionable error for a bad ref", async () => {
    try {
      await adapter.mergeTree("main", "missing-ref");
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(GitCommandError);
      if (!(error instanceof GitCommandError)) throw error;
      expect(error.args).toContain("missing-ref");
      expect(error.exitCode).toBe(1);
      expect(error.stderr).toContain("missing-ref");
      expect(error.message).toContain("merge-tree");
    }
  });

  test("fetches and prunes from a local remote", async () => {
    const remote = join(root, "remote.git");
    execFileSync("git", ["init", "--bare", remote], { stdio: "ignore" });
    git("remote", "add", "origin", remote);
    git("push", "origin", "main:refs/heads/old");
    await adapter.fetch();
    expect(git("branch", "-r")).toContain("origin/old");
    git("push", "origin", ":refs/heads/old");
    await adapter.fetch();
    expect(git("branch", "-r")).not.toContain("origin/old");
  });
});

describe("runner boundary", () => {
  test("parses porcelain records and skips detached, bare and non-head refs", async () => {
    const output = [
      "worktree /a\0HEAD abc\0branch refs/heads/feature/a\0\0",
      "worktree /b\0HEAD def\0detached\0\0",
      "worktree /c\0bare\0\0",
      "worktree /d\0HEAD ghi\0branch refs/remotes/origin/main\0\0",
      "worktree /with\nnewline\0HEAD jkl\0branch refs/heads/main\0locked reason\0\0",
    ].join("");
    const calls: string[][] = [];
    const runner: GitRunner = async (dir, args) => {
      expect(dir).toBe(repo);
      calls.push(args);
      return { stdout: output, stderr: "", exitCode: 0 };
    };
    expect(await new GitAdapter(repo, runner).worktreeBranches()).toEqual([
      { path: "/a", branch: "feature/a" },
      { path: "/with\nnewline", branch: "main" },
    ]);
    expect(calls).toEqual([["worktree", "list", "--porcelain", "-z"]]);
  });

  test("preserves stderr and command on runner failure", async () => {
    const runner: GitRunner = async () => ({
      stdout: "",
      stderr: "fatal: failed",
      exitCode: 128,
    });
    try {
      await new GitAdapter(repo, runner).fetch();
      throw new Error("expected failure");
    } catch (error) {
      expect(error).toBeInstanceOf(GitCommandError);
      if (!(error instanceof GitCommandError)) throw error;
      expect(error.args).toEqual(["fetch", "--prune", "origin"]);
      expect(error.stderr).toBe("fatal: failed");
      expect(error.exitCode).toBe(128);
    }
  });

  test("fetch gets 120 s, every other command 30 s", async () => {
    const seen: [string | undefined, number][] = [];
    const runner: GitRunner = async (_dir, args, timeoutMs) => {
      seen.push([args[0], timeoutMs]);
      if (args[0] === "merge-tree")
        return { stdout: `${"a".repeat(40)}\0`, stderr: "", exitCode: 0 };
      if (args[0] === "merge-base")
        return { stdout: `${"b".repeat(40)}\n`, stderr: "", exitCode: 0 };
      return { stdout: "", stderr: "", exitCode: 0 };
    };
    const git = new GitAdapter(repo, runner);
    await git.fetch();
    await git.worktreeBranches();
    await git.remoteBranches();
    await git.mergeBase("a", "b");
    await git.mergeTree("a", "b");
    await git.changedFiles("a", "b");
    expect(seen).toEqual([
      ["fetch", FETCH_TIMEOUT_MS],
      ["worktree", COMMAND_TIMEOUT_MS],
      ["for-each-ref", COMMAND_TIMEOUT_MS],
      ["merge-base", COMMAND_TIMEOUT_MS],
      ["merge-tree", COMMAND_TIMEOUT_MS],
      ["diff", COMMAND_TIMEOUT_MS],
    ]);
    expect([FETCH_TIMEOUT_MS, COMMAND_TIMEOUT_MS]).toEqual([120_000, 30_000]);
  });

  test("the default runner kills a command at its timeout", async () => {
    const started = Date.now();
    await expect(
      runGit(repo, ["-c", "alias.slow=!sleep 5", "slow"], 200),
    ).rejects.toThrow("timed out");
    expect(Date.now() - started).toBeLessThan(4000);
  });

  test("git never prompts: terminal prompt off, askpass unset", () => {
    const env = gitEnv({
      PATH: "/bin",
      GIT_ASKPASS: "/usr/bin/gui-prompt",
      SSH_ASKPASS: "/usr/bin/ssh-prompt",
    });
    expect(env).toEqual({
      PATH: "/bin",
      GIT_ASKPASS: "",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  test.each([
    [
      "fatal: unable to access 'https://x-access-token:ghs_abcdefghijklmnopqrstuvwxyz0123@github.com/o/r.git/'",
      "fatal: unable to access 'https://***@github.com/o/r.git/'",
    ],
    [
      "remote: invalid token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
      "remote: invalid token ***",
    ],
    ["github_pat_11ABCDEFG0123456789_abcdefXYZ", "***"],
    [
      "fatal: 'origin' does not appear to be a git repository",
      "fatal: 'origin' does not appear to be a git repository",
    ],
  ])("redacts credentials: %s", (input, output) => {
    expect(redact(input)).toBe(output);
  });

  test("command errors carry no credentials from stderr or launch failures", async () => {
    const secret =
      "https://alexei:ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345@github.com/o/r";
    for (const runner of [
      async () => ({ stdout: "", stderr: `fatal: ${secret}`, exitCode: 128 }),
      async () => {
        throw new Error(`spawn failed for ${secret}`);
      },
    ] as GitRunner[]) {
      try {
        await new GitAdapter(repo, runner).fetch();
        throw new Error("expected failure");
      } catch (error) {
        expect(error).toBeInstanceOf(GitCommandError);
        if (!(error instanceof GitCommandError)) throw error;
        expect(error.message).not.toContain("ghp_");
        expect(error.message).not.toContain("alexei:");
        expect(error.stderr).not.toContain("ghp_");
        expect(error.cause).toBeUndefined();
      }
    }
  });

  test("wraps process launch failures", async () => {
    const runner: GitRunner = async () => {
      throw new Error("spawn ENOENT");
    };
    expect(new GitAdapter(repo, runner).fetch()).rejects.toThrow(
      "spawn ENOENT",
    );
  });
});
