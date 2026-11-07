import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitAdapter, GitCommandError, type GitRunner } from "./index";

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

  test("lists linked worktrees but excludes detached HEADs", async () => {
    git("worktree", "add", "-b", "feature/one", join(root, "linked"));
    git("worktree", "add", "--detach", join(root, "detached"), "HEAD");
    expect(await adapter.worktreeBranches()).toEqual(["main", "feature/one"]);
  });

  test("diffs from the merge base, preserving unusual paths", async () => {
    git("branch", "feature");
    writeFileSync(join(repo, "base-only.txt"), "main\n");
    commit("main change");
    git("switch", "feature");
    const path = "line\nbreak.txt";
    writeFileSync(join(repo, path), "feature\n");
    commit("feature change");
    expect(await adapter.changedPaths("feature", "main")).toEqual([path]);
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
      "feature/a",
      "main",
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

  test("wraps process launch failures", async () => {
    const runner: GitRunner = async () => {
      throw new Error("spawn ENOENT");
    };
    expect(new GitAdapter(repo, runner).fetch()).rejects.toThrow(
      "spawn ENOENT",
    );
  });
});
