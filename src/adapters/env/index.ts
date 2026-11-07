import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { userInfo } from "node:os";
import type { EnvPort, ManagedHooksPolicy } from "../../ports/index";

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

export interface EnvOptions {
  repoDir: string;
  runner?: EnvRunner;
  /** User-level path first, then the device-level path. */
  policyPaths?: readonly string[];
}

export class EnvCommandError extends Error {
  constructor(command: string) {
    super(`${command} failed`);
    this.name = "EnvCommandError";
  }
}

export function parseRepoIdentity(remote: string): string {
  let path: string;
  if (/^[^/@\s]+@[^/:\s]+:/.test(remote)) {
    path = remote.slice(remote.indexOf(":") + 1);
  } else {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      throw new Error("Unsupported origin remote URL");
    }
    if (!["https:", "http:", "ssh:"].includes(url.protocol))
      throw new Error("Unsupported origin remote URL");
    path = url.pathname.replace(/^\//, "");
  }
  path = path.replace(/\/$/, "").replace(/\.git$/, "");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(path))
    throw new Error("Origin remote must identify owner/repo");
  const [owner, repo] = path.split("/");
  if (owner === "." || owner === ".." || repo === "." || repo === "..")
    throw new Error("Invalid origin repository");
  return path;
}

export class EnvAdapter implements EnvPort {
  private readonly runner: EnvRunner;
  private readonly policyPaths: readonly string[];

  constructor(private readonly options: EnvOptions) {
    this.runner = options.runner ?? run;
    this.policyPaths = options.policyPaths ?? [
      `/Library/Managed Preferences/${userInfo().username}/com.anthropic.claudecode.plist`,
      "/Library/Managed Preferences/com.anthropic.claudecode.plist",
    ];
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

  async githubToken(): Promise<string> {
    const token = await this.command("gh", ["auth", "token"]);
    if (!token) throw new EnvCommandError("gh");
    return token;
  }

  async repoIdentity(): Promise<string> {
    return parseRepoIdentity(
      await this.command("git", ["remote", "get-url", "origin"]),
    );
  }

  async managedHooksOnly(): Promise<ManagedHooksPolicy> {
    for (const path of this.policyPaths) {
      try {
        await access(path);
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          continue;
        return { status: "unknown", reason: "Managed policy is inaccessible" };
      }
      try {
        const raw: unknown = JSON.parse(
          await this.command("plutil", ["-convert", "json", "-o", "-", path]),
        );
        if (typeof raw !== "object" || raw === null || Array.isArray(raw))
          return {
            status: "unknown",
            reason: "Managed policy is not an object",
          };
        if (!("allowManagedHooksOnly" in raw)) continue;
        if (typeof raw.allowManagedHooksOnly !== "boolean")
          return {
            status: "unknown",
            reason: "Managed hooks policy is not boolean",
          };
        return { status: "known", enabled: raw.allowManagedHooksOnly };
      } catch {
        return {
          status: "unknown",
          reason: "Managed policy could not be read",
        };
      }
    }
    return { status: "known", enabled: false };
  }
}
