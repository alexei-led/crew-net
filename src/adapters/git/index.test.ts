import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

/** Runs git with stdin closed, as the adapter does; resolves stdout, rejects on a non-zero exit. */
function exec(
  file: string,
  args: string[],
  options: { cwd?: string; encoding?: "utf8" } = {},
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve({ stdout })
        : reject(new Error(`${file} ${args.join(" ")}: ${stderr}`)),
    );
  });
}

// Real git spawns many processes; under full-suite load 5 s is not enough.
setDefaultTimeout(30_000);

// One base repo is built once and copied for each test (cheaper than git init
// and a commit), and each test changes only its own copy.
let template: string;
const roots: string[] = [];

beforeAll(() => {
  template = mkdtempSync(join(tmpdir(), "crew-net-git-template-"));
  const run = (...args: string[]) =>
    execFileSync("git", args, { cwd: template, stdio: "ignore" });
  run("init", "--initial-branch=main", ".");
  run("config", "user.name", "Test");
  run("config", "user.email", "test@example.test");
  run("config", "commit.gpgsign", "false");
  writeFileSync(join(template, "shared.txt"), "base\n");
  writeFileSync(
    join(template, "rename.txt"),
    "some content for rename detection\n",
  );
  run("add", "-A");
  run("commit", "-m", "base");
});

afterAll(() => {
  for (const dir of [template, ...roots])
    rmSync(dir, { recursive: true, force: true });
});

function fresh() {
  const root = mkdtempSync(join(tmpdir(), "crew-net-git-"));
  roots.push(root);
  const repo = join(root, "repo");
  cpSync(template, repo, { recursive: true });
  const git = async (...args: string[]): Promise<string> =>
    (await exec("git", args, { cwd: repo, encoding: "utf8" })).stdout.trim();
  const commit = async (message: string): Promise<void> => {
    await git("add", "-A");
    await git("commit", "-m", message);
  };
  return { root, repo, git, commit, adapter: new GitAdapter(repo) };
}

describe("real git", () => {
  test("merges clean branches and reports no conflicts", async () => {
    const { repo, git, commit, adapter } = fresh();
    await git("branch", "other");
    writeFileSync(join(repo, "new.txt"), "new\n");
    await commit("new file");
    expect(await adapter.mergeTree("main", "other")).toEqual({
      clean: true,
      conflictedPaths: [],
    });
  });

  test("reports exact conflict paths including unusual names", async () => {
    const { repo, git, commit, adapter } = fresh();
    const path = "conflict\nwith tab\t.txt";
    writeFileSync(join(repo, path), "base\n");
    await commit("add unusual file");
    await git("branch", "other");
    writeFileSync(join(repo, path), "ours\n");
    writeFileSync(join(repo, "shared.txt"), "ours\n");
    await commit("ours");
    await git("switch", "other");
    writeFileSync(join(repo, path), "theirs\n");
    writeFileSync(join(repo, "shared.txt"), "theirs\n");
    await commit("theirs");
    expect(await adapter.mergeTree("main", "other")).toEqual({
      clean: false,
      conflictedPaths: [path, "shared.txt"],
    });
  });

  test("reports rename/delete conflicts", async () => {
    const { git, commit, adapter } = fresh();
    await git("branch", "other");
    await git("mv", "rename.txt", "renamed.txt");
    await commit("rename");
    await git("switch", "other");
    await git("rm", "rename.txt");
    await commit("delete");
    expect(await adapter.mergeTree("main", "other")).toEqual({
      clean: false,
      conflictedPaths: ["renamed.txt"],
    });
  });

  test("lists linked worktrees with paths but excludes detached HEADs", async () => {
    const { root, git, adapter } = fresh();
    await git("worktree", "add", "-b", "feature/one", join(root, "linked"));
    await git("worktree", "add", "--detach", join(root, "detached"), "HEAD");
    const main = await git("rev-parse", "--show-toplevel");
    const linked = (
      await exec("git", ["rev-parse", "--show-toplevel"], {
        cwd: join(root, "linked"),
        encoding: "utf8",
      })
    ).stdout.trim();
    expect(await adapter.worktreeBranches()).toEqual([
      { path: main, branch: "main" },
      { path: linked, branch: "feature/one" },
    ]);
  });

  test("checkout resolves a symlinked subdirectory of a linked worktree to its root, clone and branch", async () => {
    const { root, repo, git, adapter } = fresh();
    const linked = join(root, "linked");
    await git("worktree", "add", "-b", "feature/one", linked);
    mkdirSync(join(linked, "sub", "deep"), { recursive: true });
    const alias = join(root, "alias");
    symlinkSync(join(linked, "sub"), alias);
    expect(await new GitAdapter(join(alias, "deep")).checkout()).toEqual({
      root: realpathSync(linked),
      clone: realpathSync(repo),
      branch: "feature/one",
    });
    expect(await adapter.checkout()).toEqual({
      root: realpathSync(repo),
      clone: realpathSync(repo),
      branch: "main",
    });
  });

  test("remotes list each url with gh's resolved default, as git remote -v lists them", async () => {
    const { git, adapter } = fresh();
    expect(await adapter.remotes()).toEqual([]);
    await git("remote", "add", "origin", "git@github.com:me/app.git");
    await git("remote", "add", "upstream", "https://github.com/acme/app.git");
    await git("config", "remote.upstream.gh-resolved", "base");
    await git(
      "config",
      "--add",
      "remote.origin.pushurl",
      "git@github.com:x/y.git",
    );
    await git(
      "config",
      "url.https://github.com/acme/.insteadOf",
      "https://mirror.example/",
    );
    await git("remote", "add", "mirror", "https://mirror.example/lib.git");
    expect(await adapter.remotes()).toEqual([
      { name: "mirror", url: "https://github.com/acme/lib.git" },
      { name: "origin", url: "git@github.com:me/app.git" },
      {
        name: "upstream",
        url: "https://github.com/acme/app.git",
        ghResolved: "base",
      },
    ]);
    expect(await adapter.configValue("remote.upstream.gh-resolved")).toBe(
      "base",
    );
    expect(await adapter.configValue("branch.main.merge")).toBeUndefined();
  });

  test("checkout of a worktree of a bare clone names the bare repo as its clone", async () => {
    const { root, repo } = fresh();
    const bare = join(root, "omni.git");
    await exec("git", ["clone", "--bare", "-q", repo, bare]);
    const tree = join(root, "omni-feature");
    await exec("git", ["-C", bare, "worktree", "add", "-q", "-b", "f", tree]);
    expect(await new GitAdapter(tree).checkout()).toEqual({
      root: realpathSync(tree),
      clone: realpathSync(bare),
      branch: "f",
    });
  });

  test("checkout has no branch on a detached HEAD and fails outside a repository", async () => {
    const { root, repo, git } = fresh();
    await git("worktree", "add", "--detach", join(root, "detached"), "HEAD");
    expect(await new GitAdapter(join(root, "detached")).checkout()).toEqual({
      root: realpathSync(join(root, "detached")),
      clone: realpathSync(repo),
    });
    await expect(new GitAdapter(root).checkout()).rejects.toBeInstanceOf(
      GitCommandError,
    );
  });

  test("merge base of forked branches, undefined without shared history", async () => {
    const { repo, git, commit, adapter } = fresh();
    const fork = await git("rev-parse", "HEAD");
    await git("branch", "feature");
    writeFileSync(join(repo, "main.txt"), "main\n");
    await commit("main moves");
    expect(await adapter.mergeBase("main", "feature")).toBe(fork);
    await git("switch", "--orphan", "lonely");
    writeFileSync(join(repo, "lonely.txt"), "x\n");
    await commit("orphan");
    expect(await adapter.mergeBase("main", "lonely")).toBeUndefined();
    await expect(adapter.mergeBase("main", "missing")).rejects.toBeInstanceOf(
      GitCommandError,
    );
  });

  test("remote branches carry their tip time; branch authors carry a noreply login hint", async () => {
    const { repo, git, adapter } = fresh();
    await git("update-ref", "refs/remotes/origin/main", "HEAD");
    await git("switch", "-c", "feat/maria");
    writeFileSync(join(repo, "m.txt"), "m\n");
    await git("add", "-A");
    await git(
      "-c",
      "user.email=12345+maria-dev@users.noreply.github.com",
      "commit",
      "-m",
      "maria",
    );
    await git("update-ref", "refs/remotes/origin/feat/maria", "HEAD");
    writeFileSync(join(repo, "d.txt"), "d\n");
    await git("add", "-A");
    await git("-c", "user.email=dmitri@corp.example", "commit", "-m", "dmitri");
    await git("update-ref", "refs/remotes/origin/dmitri", "HEAD");
    await git("update-ref", "refs/remotes/upstream/other", "HEAD");
    await git(
      "symbolic-ref",
      "refs/remotes/origin/HEAD",
      "refs/remotes/origin/main",
    );
    const branches = await adapter.remoteBranches();
    expect(branches.map((b) => b.name)).toEqual([
      "dmitri",
      "feat/maria",
      "main",
    ]);
    for (const branch of branches)
      expect(Number.isNaN(Date.parse(branch.lastCommitAt))).toBe(false);
    expect(
      await adapter.branchAuthor("origin/main", "origin/feat/maria"),
    ).toEqual({
      authorEmail: "12345+maria-dev@users.noreply.github.com",
      loginHint: "maria-dev",
    });
    expect(
      await adapter.branchAuthor("origin/feat/maria", "origin/dmitri"),
    ).toEqual({ authorEmail: "dmitri@corp.example", loginHint: null });
  });

  test("same content: a squash-merged branch matches the base on its paths, open work does not", async () => {
    const { repo, git, commit, adapter } = fresh();
    await git("switch", "-c", "squashed");
    writeFileSync(join(repo, "feature.txt"), "feature\n");
    await commit("feature");
    await git("switch", "-c", "open");
    writeFileSync(join(repo, "shared.txt"), "open work\n");
    await commit("open work");
    await git("switch", "main");
    await git("merge", "--squash", "squashed");
    await commit("squash merge");
    writeFileSync(join(repo, "later.txt"), "main moved on\n");
    await commit("later");
    const squashed = await adapter.changedFiles("main", "squashed");
    expect(await adapter.sameContent("main", "squashed", squashed)).toBe(true);
    const open = await adapter.changedFiles("main", "open");
    expect(await adapter.sameContent("main", "open", open)).toBe(false);
    expect(await adapter.sameContent("main", "open", [])).toBe(true);
    // Paths are literal: "*.txt" names no file, so it cannot match shared.txt.
    expect(await adapter.sameContent("main", "open", ["*.txt"])).toBe(true);
  });

  test("changed files list both paths of a rename", async () => {
    const { git, commit, adapter } = fresh();
    await git("switch", "-c", "feature");
    await git("mv", "rename.txt", "renamed.txt");
    await commit("rename");
    expect((await adapter.changedFiles("main", "feature")).sort()).toEqual([
      "rename.txt",
      "renamed.txt",
    ]);
  });

  test("changed files from the merge base, preserving unusual paths", async () => {
    const { repo, git, commit, adapter } = fresh();
    await git("branch", "feature");
    writeFileSync(join(repo, "base-only.txt"), "main\n");
    await commit("main change");
    await git("switch", "feature");
    const path = "line\nbreak.txt";
    writeFileSync(join(repo, path), "feature\n");
    await commit("feature change");
    expect(await adapter.changedFiles("main", "feature")).toEqual([path]);
  });

  test("returns an actionable error for a bad ref", async () => {
    const { adapter } = fresh();
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
    const { root, git, adapter } = fresh();
    const remote = join(root, "remote.git");
    await exec("git", ["init", "--bare", remote]);
    await git("remote", "add", "origin", remote);
    await git("push", "origin", "main:refs/heads/old");
    await adapter.fetch();
    expect(await git("branch", "-r")).toContain("origin/old");
    await git("push", "origin", ":refs/heads/old");
    await adapter.fetch();
    expect(await git("branch", "-r")).not.toContain("origin/old");
  });
});

describe("showFile and landed", () => {
  test("showFile reads a file at a ref and answers undefined for a missing path or ref", async () => {
    const { repo, commit, adapter } = fresh();
    mkdirSync(join(repo, ".github"));
    writeFileSync(join(repo, ".github", "crew-net.yml"), "bots: [x]\n");
    await commit("config");
    expect(await adapter.showFile("main", ".github/crew-net.yml")).toBe(
      "bots: [x]\n",
    );
    expect(await adapter.showFile("main", ".github/none.yml")).toBeUndefined();
    expect(
      await adapter.showFile("origin/nothing", ".github/crew-net.yml"),
    ).toBeUndefined();
  });

  test("showFile throws outside a repository", async () => {
    const { root } = fresh();
    const outside = new GitAdapter(root);
    await expect(outside.showFile("main", "x")).rejects.toBeInstanceOf(
      GitCommandError,
    );
  });

  test("landed lists first-parent commits with their paths, newest first", async () => {
    const { repo, git, commit, adapter } = fresh();
    await git("tag", "fork");
    mkdirSync(join(repo, "d"));
    writeFileSync(join(repo, "d", "b c.txt"), "x\n");
    writeFileSync(join(repo, "shared.txt"), "changed\n");
    await git("config", "user.email", "12+maria@users.noreply.github.com");
    await commit("feat: one (#12)");
    await git("rm", "-q", "d/b c.txt");
    writeFileSync(join(repo, "e.txt"), "y\n");
    await commit("two");
    const landed = await adapter.landed("fork", "main");
    expect(landed.map((c) => c.subject)).toEqual(["two", "feat: one (#12)"]);
    expect(landed[0]?.paths.sort()).toEqual(["d/b c.txt", "e.txt"]);
    expect(landed[1]).toMatchObject({
      paths: ["d/b c.txt", "shared.txt"],
      authorEmail: "12+maria@users.noreply.github.com",
      loginHint: "maria",
    });
    expect(await adapter.landed("main", "main")).toEqual([]);
  });

  test("branchAuthor names the branch's own last author, not whoever merged main into it", async () => {
    const { repo, git, commit, adapter } = fresh();
    await git("switch", "-c", "maria/x");
    await git("config", "user.email", "5+maria@users.noreply.github.com");
    writeFileSync(join(repo, "m.txt"), "m\n");
    await commit("maria's work");
    await git("switch", "main");
    await git("config", "user.email", "test@example.test");
    writeFileSync(join(repo, "main.txt"), "x\n");
    await commit("main moves");
    await git("switch", "maria/x");
    await git("config", "user.email", "9+me@users.noreply.github.com");
    await git("merge", "--no-ff", "-m", "merge main", "main");
    expect(await adapter.branchAuthor("main", "maria/x")).toEqual({
      authorEmail: "5+maria@users.noreply.github.com",
      loginHint: "maria",
    });
    expect(await adapter.branchAuthor("maria/x", "main")).toBeUndefined();
  });

  test("landed lists the files of a merge commit against its first parent", async () => {
    const { repo, git, commit, adapter } = fresh();
    await git("tag", "fork");
    await git("switch", "-c", "side");
    writeFileSync(join(repo, "side.txt"), "s\n");
    await commit("side work");
    await git("switch", "main");
    writeFileSync(join(repo, "main.txt"), "m\n");
    await commit("main work");
    await git(
      "merge",
      "--no-ff",
      "-m",
      "Merge pull request #7 from o/side",
      "side",
    );
    const landed = await adapter.landed("fork", "main");
    expect(landed.map((c) => c.subject)).toEqual([
      "Merge pull request #7 from o/side",
      "main work",
    ]);
    expect(landed[0]?.paths).toEqual(["side.txt"]);
  });
});

describe("runner boundary", () => {
  const REPO = "/work/repo";

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
      expect(dir).toBe(REPO);
      calls.push(args);
      return { stdout: output, stderr: "", exitCode: 0 };
    };
    expect(await new GitAdapter(REPO, runner).worktreeBranches()).toEqual([
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
      await new GitAdapter(REPO, runner).fetch();
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
    const git = new GitAdapter(REPO, runner);
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
      runGit(tmpdir(), ["-c", "alias.slow=!sleep 5", "slow"], 200),
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
        await new GitAdapter(REPO, runner).fetch();
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
    expect(new GitAdapter(REPO, runner).fetch()).rejects.toThrow(
      "spawn ENOENT",
    );
  });
});
