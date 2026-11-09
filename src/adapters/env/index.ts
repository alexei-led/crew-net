import { execFile } from "node:child_process";
import { access, readdir, readFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import type {
  EnvPort,
  ManagedHooksPolicy,
  RepoIdentity,
} from "../../ports/index";

export interface CommandResult {
  stdout: string;
  exitCode: number;
}

export type EnvRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<CommandResult>;

const run: EnvRunner = (command, args, cwd) =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        cwd,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        // Never retain stderr or the original error: gh failures may contain credentials.
        if (error && typeof error.code !== "number") {
          reject(new Error(`${command} could not be executed`));
        } else {
          resolve({
            stdout,
            exitCode: typeof error?.code === "number" ? error.code : 0,
          });
        }
      },
    );
  });

/**
 * Where Claude Code managed settings may live, highest precedence first.
 * `plist` is a macOS managed preference; `json` a managed-settings.json;
 * `json-dir` a managed-settings.d drop-in directory (later files win).
 */
export type PolicySource =
  | { kind: "plist"; path: string }
  | { kind: "json"; path: string }
  | { kind: "json-dir"; path: string };

export function defaultPolicySources(
  platform: NodeJS.Platform,
  user: string,
): PolicySource[] | undefined {
  if (platform === "darwin") {
    const dir = "/Library/Application Support/ClaudeCode";
    return [
      {
        kind: "plist",
        path: `/Library/Managed Preferences/${user}/com.anthropic.claudecode.plist`,
      },
      {
        kind: "plist",
        path: "/Library/Managed Preferences/com.anthropic.claudecode.plist",
      },
      { kind: "json-dir", path: `${dir}/managed-settings.d` },
      { kind: "json", path: `${dir}/managed-settings.json` },
    ];
  }
  if (platform === "linux")
    return [
      { kind: "json-dir", path: "/etc/claude-code/managed-settings.d" },
      { kind: "json", path: "/etc/claude-code/managed-settings.json" },
    ];
  return undefined;
}

export interface EnvOptions {
  repoDir: string;
  runner?: EnvRunner;
  /** Managed settings sources, highest precedence first. Defaults per platform. */
  policySources?: readonly PolicySource[];
  platform?: NodeJS.Platform;
  /** Process environment for XDG lookups. Defaults to process.env. */
  env?: Readonly<Record<string, string | undefined>>;
  home?: string;
}

export class EnvCommandError extends Error {
  constructor(command: string) {
    super(`${command} failed`);
    this.name = "EnvCommandError";
  }
}

/** Host and owner/repo of a git remote URL (HTTPS, ssh:// or SCP-style). */
export function parseRepoIdentity(remote: string): RepoIdentity {
  let host: string;
  let path: string;
  const scp = remote.match(/^[^/@\s]+@([^/:\s]+):(.*)$/);
  if (scp) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      throw new Error("Unsupported origin remote URL");
    }
    if (!["https:", "http:", "ssh:"].includes(url.protocol))
      throw new Error("Unsupported origin remote URL");
    host = url.hostname;
    path = url.pathname.replace(/^\//, "");
  }
  host = host.toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host))
    throw new Error("Origin remote has no valid host");
  path = path.replace(/\/$/, "").replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path))
    throw new Error("Origin remote must identify owner/repo");
  const [owner, repo] = path.split("/");
  if (owner === "." || owner === ".." || repo === "." || repo === "..")
    throw new Error("Invalid origin repository");
  return { host, repo: path };
}

type Lookup = { found: false } | { found: true; value: ManagedHooksPolicy };

const missing = (error: unknown): boolean =>
  error instanceof Error &&
  "code" in error &&
  (error.code === "ENOENT" || error.code === "ENOTDIR");

const unknown = (reason: string): Lookup => ({
  found: true,
  value: { status: "unknown", reason },
});

function fromSettings(raw: unknown): Lookup {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    return unknown("Managed policy is not an object");
  if (!("allowManagedHooksOnly" in raw)) return { found: false };
  if (typeof raw.allowManagedHooksOnly !== "boolean")
    return unknown("Managed hooks policy is not boolean");
  return {
    found: true,
    value: { status: "known", enabled: raw.allowManagedHooksOnly },
  };
}

export class EnvAdapter implements EnvPort {
  private readonly runner: EnvRunner;
  private readonly policySources: readonly PolicySource[] | undefined;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly home: string;

  constructor(private readonly options: EnvOptions) {
    this.runner = options.runner ?? run;
    this.policySources =
      options.policySources ??
      defaultPolicySources(
        options.platform ?? process.platform,
        userInfo().username,
      );
    this.env = options.env ?? process.env;
    this.home = options.home ?? homedir();
  }

  private async command(command: string, args: string[]): Promise<string> {
    let result: CommandResult;
    try {
      result = await this.runner(command, args, this.options.repoDir);
    } catch {
      throw new EnvCommandError(command);
    }
    if (result.exitCode !== 0) throw new EnvCommandError(command);
    return result.stdout.trim();
  }

  async githubToken(host: string): Promise<string> {
    const token = await this.command("gh", [
      "auth",
      "token",
      "--hostname",
      host,
    ]);
    if (!token) throw new EnvCommandError("gh");
    return token;
  }

  async repoIdentity(): Promise<RepoIdentity> {
    return parseRepoIdentity(
      await this.command("git", ["remote", "get-url", "origin"]),
    );
  }

  /** XDG base directory: the variable when it is absolute, else the default under home. */
  private xdg(variable: string, fallback: string): string {
    const value = this.env[variable];
    return join(
      value && isAbsolute(value) ? value : join(this.home, fallback),
      "crew-net",
    );
  }

  stateDir(): string {
    return this.xdg("XDG_STATE_HOME", ".local/state");
  }

  configDir(): string {
    return this.xdg("XDG_CONFIG_HOME", ".config");
  }

  private async plist(path: string): Promise<Lookup> {
    try {
      await access(path);
    } catch (error) {
      if (missing(error)) return { found: false };
      return unknown("Managed policy is inaccessible");
    }
    try {
      return fromSettings(
        JSON.parse(
          await this.command("plutil", ["-convert", "json", "-o", "-", path]),
        ),
      );
    } catch {
      return unknown("Managed policy could not be read");
    }
  }

  private async json(path: string): Promise<Lookup> {
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch (error) {
      if (missing(error)) return { found: false };
      return unknown("Managed settings file is inaccessible");
    }
    try {
      return fromSettings(JSON.parse(text));
    } catch {
      return unknown("Managed settings file is not valid JSON");
    }
  }

  private async jsonDir(path: string): Promise<Lookup> {
    let names: string[];
    try {
      names = await readdir(path);
    } catch (error) {
      if (missing(error)) return { found: false };
      return unknown("Managed settings directory is inaccessible");
    }
    // Drop-ins merge in name order, so the last file that sets the key wins.
    const files = names
      .filter((name) => name.endsWith(".json") && !name.startsWith("."))
      .sort()
      .reverse();
    for (const name of files) {
      const lookup = await this.json(join(path, name));
      if (lookup.found) return lookup;
    }
    return { found: false };
  }

  /**
   * First source that sets the key wins; an unreadable source is unknown, never "off".
   * Limit: server-managed settings are not visible on disk and are not checked.
   */
  async managedHooksOnly(): Promise<ManagedHooksPolicy> {
    if (!this.policySources)
      return {
        status: "unknown",
        reason: "Managed policy locations are unknown on this platform",
      };
    for (const source of this.policySources) {
      const lookup =
        source.kind === "plist"
          ? await this.plist(source.path)
          : source.kind === "json"
            ? await this.json(source.path)
            : await this.jsonDir(source.path);
      if (lookup.found) return lookup.value;
    }
    return { status: "known", enabled: false };
  }
}
