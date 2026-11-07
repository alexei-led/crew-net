import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EnvAdapter,
  EnvCommandError,
  type EnvRunner,
  parseRepoIdentity,
} from "./index";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "crew-net-env-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

test.each([
  ["https://github.com/alexei-led/crew-net.git", "alexei-led/crew-net"],
  ["https://github.com/alexei-led/crew-net", "alexei-led/crew-net"],
  ["git@github.com:alexei-led/crew-net.git", "alexei-led/crew-net"],
  ["ssh://git@github.example:2222/owner/repo.git", "owner/repo"],
  ["https://github.example/Owner/my.repo/", "Owner/my.repo"],
])("repo identity: %s", (remote, expected) => {
  expect(parseRepoIdentity(remote)).toBe(expected);
});

test.each([
  "/tmp/local.git",
  "file:///tmp/repo",
  "https://github.com/owner",
  "git@host:owner/repo/extra",
  "https://host/a/b/c",
])("rejects unsupported origin %s", (remote) => {
  expect(() => parseRepoIdentity(remote)).toThrow();
});

test("token and repository commands use argv, cwd, and no shell", async () => {
  const calls: unknown[] = [];
  const runner: EnvRunner = async (command, args, cwd) => {
    calls.push([command, args, cwd]);
    return {
      stdout:
        command === "gh" ? "test-secret\n" : "git@github.com:owner/repo.git\n",
      exitCode: 0,
    };
  };
  const env = new EnvAdapter({ repoDir: dir, runner });
  expect(await env.githubToken()).toBe("test-secret");
  expect(await env.repoIdentity()).toBe("owner/repo");
  expect(calls).toEqual([
    ["gh", ["auth", "token"], dir],
    ["git", ["remote", "get-url", "origin"], dir],
  ]);
});

test("command failures never propagate token-like stderr or causes", async () => {
  const env = new EnvAdapter({
    repoDir: dir,
    runner: async () => {
      throw new Error("ghp_secret should not escape");
    },
  });
  try {
    await env.githubToken();
    throw new Error("Expected error");
  } catch (error) {
    expect(error).toBeInstanceOf(EnvCommandError);
    expect(String(error)).not.toContain("ghp_secret");
    if (error instanceof Error) expect(error.cause).toBeUndefined();
  }
});

test.each([
  { stdout: "", exitCode: 0 },
  { stdout: "private-token", exitCode: 1 },
])("missing or failed token is rejected", async (result) => {
  const env = new EnvAdapter({ repoDir: dir, runner: async () => result });
  await expect(env.githubToken()).rejects.toBeInstanceOf(EnvCommandError);
});

function policy(
  paths: string[],
  outputs: Record<string, string>,
  failure = false,
) {
  const calls: string[][] = [];
  const env = new EnvAdapter({
    repoDir: dir,
    policyPaths: paths,
    runner: async (command, args) => {
      calls.push([command, ...args]);
      if (failure) throw new Error("unreadable");
      return { stdout: outputs[args.at(-1) ?? ""] ?? "{}", exitCode: 0 };
    },
  });
  return { env, calls };
}

test("missing user and device plists means a known false policy", async () => {
  const { env, calls } = policy([join(dir, "user"), join(dir, "device")], {});
  expect(await env.managedHooksOnly()).toEqual({
    status: "known",
    enabled: false,
  });
  expect(calls).toEqual([]);
});

test("user setting wins, using plutil with the exact path argument", async () => {
  const user = join(dir, "user policy.plist");
  const device = join(dir, "device.plist");
  writeFileSync(user, "fixture");
  writeFileSync(device, "fixture");
  const { env, calls } = policy([user, device], {
    [user]: '{"allowManagedHooksOnly":false}',
    [device]: '{"allowManagedHooksOnly":true}',
  });
  expect(await env.managedHooksOnly()).toEqual({
    status: "known",
    enabled: false,
  });
  expect(calls).toEqual([["plutil", "-convert", "json", "-o", "-", user]]);
});

test("missing user key falls through to device policy", async () => {
  const user = join(dir, "user");
  const device = join(dir, "device");
  writeFileSync(user, "fixture");
  writeFileSync(device, "fixture");
  const { env } = policy([user, device], {
    [user]: "{}",
    [device]: '{"allowManagedHooksOnly":true}',
  });
  expect(await env.managedHooksOnly()).toEqual({
    status: "known",
    enabled: true,
  });
});

test("missing user file falls through to device policy", async () => {
  const device = join(dir, "device");
  writeFileSync(device, "fixture");
  const { env } = policy([join(dir, "missing"), device], {
    [device]: '{"allowManagedHooksOnly":true}',
  });
  expect(await env.managedHooksOnly()).toEqual({
    status: "known",
    enabled: true,
  });
});

test.each(["not JSON", "[]", "null", '{"allowManagedHooksOnly":"false"}'])(
  "malformed policy returns unknown, never false: %s",
  async (output) => {
    const path = join(dir, "policy");
    writeFileSync(path, "fixture");
    const { env } = policy([path], { [path]: output });
    expect((await env.managedHooksOnly()).status).toBe("unknown");
  },
);

test("unreadable plist returns unknown even if device policy would be false", async () => {
  const user = join(dir, "user");
  writeFileSync(user, "fixture");
  const { env } = policy([user], {}, true);
  expect((await env.managedHooksOnly()).status).toBe("unknown");
});
