import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultPolicySources,
  EnvAdapter,
  EnvCommandError,
  type EnvRunner,
  type PolicySource,
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
  [
    "https://github.com/alexei-led/crew-net.git",
    "github.com",
    "alexei-led/crew-net",
  ],
  [
    "https://github.com/alexei-led/crew-net",
    "github.com",
    "alexei-led/crew-net",
  ],
  [
    "git@github.com:alexei-led/crew-net.git",
    "github.com",
    "alexei-led/crew-net",
  ],
  [
    "ssh://git@github.example:2222/owner/repo.git",
    "github.example",
    "owner/repo",
  ],
  ["https://GitHub.Example/Owner/my.repo/", "github.example", "Owner/my.repo"],
  ["git@acme.ghe.com:acme/app.git", "acme.ghe.com", "acme/app"],
  ["ssh://git@ssh.github.com:443/owner/repo.git", "github.com", "owner/repo"],
])("repo identity: %s", (remote, host, repo) => {
  expect(parseRepoIdentity(remote)).toEqual({ host, repo });
});

test.each([
  "/tmp/local.git",
  "file:///tmp/repo",
  "https://github.com/owner",
  "git@host:owner/repo/extra",
  "https://host/a/b/c",
  "git@:owner/repo",
  "git@bad_host:owner/repo",
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
  expect(await env.githubToken("github.example")).toBe("test-secret");
  expect(await env.repoIdentity()).toEqual({
    host: "github.com",
    repo: "owner/repo",
  });
  expect(calls).toEqual([
    ["gh", ["auth", "token", "--hostname", "github.example"], dir],
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
    await env.githubToken("github.com");
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
  await expect(env.githubToken("github.com")).rejects.toBeInstanceOf(
    EnvCommandError,
  );
});

function policy(
  paths: (string | PolicySource)[],
  outputs: Record<string, string> = {},
  failure = false,
) {
  const calls: string[][] = [];
  const env = new EnvAdapter({
    repoDir: dir,
    policySources: paths.map((path) =>
      typeof path === "string" ? { kind: "plist", path } : path,
    ),
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

const json = (path: string): PolicySource => ({ kind: "json", path });
const drop = (path: string): PolicySource => ({ kind: "json-dir", path });

test("managed-settings.json sets the policy when no plist does", async () => {
  const file = join(dir, "managed-settings.json");
  writeFileSync(file, '{"allowManagedHooksOnly":true}');
  const { env, calls } = policy([join(dir, "missing.plist"), json(file)]);
  expect(await env.managedHooksOnly()).toEqual({
    status: "known",
    enabled: true,
  });
  expect(calls).toEqual([]);
});

test("the last drop-in that sets the key wins over managed-settings.json", async () => {
  const dropIns = join(dir, "managed-settings.d");
  mkdirSync(dropIns);
  writeFileSync(
    join(dropIns, "10-base.json"),
    '{"allowManagedHooksOnly":true}',
  );
  writeFileSync(
    join(dropIns, "20-team.json"),
    '{"allowManagedHooksOnly":false}',
  );
  writeFileSync(join(dropIns, "30-other.json"), '{"env":{}}');
  writeFileSync(join(dropIns, "40-notes.txt"), "not json");
  writeFileSync(
    join(dropIns, ".hidden.json"),
    '{"allowManagedHooksOnly":true}',
  );
  const file = join(dir, "managed-settings.json");
  writeFileSync(file, '{"allowManagedHooksOnly":true}');
  const { env } = policy([drop(dropIns), json(file)]);
  expect(await env.managedHooksOnly()).toEqual({
    status: "known",
    enabled: false,
  });
});

test.each([
  ["malformed settings file", (p: string) => writeFileSync(p, "{oops"), json],
  ["non-object settings file", (p: string) => writeFileSync(p, "[]"), json],
  [
    "malformed drop-in",
    (p: string) => {
      mkdirSync(p);
      writeFileSync(join(p, "a.json"), "{oops");
    },
    drop,
  ],
  ["unreadable settings file", (p: string) => mkdirSync(p), json],
] as const)("%s is unknown, never off", async (_name, plant, kind) => {
  const path = join(dir, "managed");
  plant(path);
  const fallback = join(dir, "fallback.json");
  writeFileSync(fallback, '{"allowManagedHooksOnly":false}');
  const { env } = policy([kind(path), json(fallback)]);
  expect((await env.managedHooksOnly()).status).toBe("unknown");
});

test("an unsupported platform reports unknown policy", async () => {
  expect(defaultPolicySources("win32", () => "u")).toBeUndefined();
  const env = new EnvAdapter({ repoDir: dir, platform: "win32" });
  expect(await env.managedHooksOnly()).toEqual({
    status: "unknown",
    reason: "Managed policy locations are unknown on this platform",
  });
});

test.each([
  [
    "darwin",
    [
      "plist:/Library/Managed Preferences/me/com.anthropic.claudecode.plist",
      "plist:/Library/Managed Preferences/com.anthropic.claudecode.plist",
      "json-dir:/Library/Application Support/ClaudeCode/managed-settings.d",
      "json:/Library/Application Support/ClaudeCode/managed-settings.json",
    ],
  ],
  [
    "linux",
    [
      "json-dir:/etc/claude-code/managed-settings.d",
      "json:/etc/claude-code/managed-settings.json",
    ],
  ],
] as const)("default policy sources on %s", (platform, expected) => {
  expect(
    defaultPolicySources(platform, () => "me")?.map(
      (s) => `${s.kind}:${s.path}`,
    ),
  ).toEqual([...expected]);
});

test.each([
  [{}, "/home/me/.local/state/crew-net", "/home/me/.config/crew-net"],
  [
    { XDG_STATE_HOME: "/x/state", XDG_CONFIG_HOME: "/x/config" },
    "/x/state/crew-net",
    "/x/config/crew-net",
  ],
  [
    { XDG_STATE_HOME: "relative", XDG_CONFIG_HOME: "" },
    "/home/me/.local/state/crew-net",
    "/home/me/.config/crew-net",
  ],
])("XDG dirs for %j", (vars, state, config) => {
  const env = new EnvAdapter({ repoDir: dir, env: vars, home: "/home/me" });
  expect(env.stateDir()).toBe(state);
  expect(env.configDir()).toBe(config);
});
