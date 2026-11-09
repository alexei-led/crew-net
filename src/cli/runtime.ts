import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { EnvAdapter } from "../adapters/env/index";
import { GitAdapter } from "../adapters/git/index";
import { GitHubAdapter } from "../adapters/github/index";
import { defaultStateDir, FileStoreAdapter } from "../adapters/store/index";
import type { AppPorts } from "../app/ports";
import { parseSettings } from "../app/settings";
import type { Runtime } from "./command";

function readConfigFile(dir: string): string | undefined {
  try {
    return readFileSync(join(dir, "config.json"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** The composition root: real adapters, built on first use. */
export function createRuntime(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Runtime {
  let built: AppPorts | undefined;
  return {
    cwd,
    now: () => Date.now(),
    ports(): AppPorts {
      if (built) return built;
      const clock = { now: () => Date.now() };
      const envPort = new EnvAdapter({ repoDir: cwd, env, home: homedir() });
      const store = new FileStoreAdapter(
        defaultStateDir(env, homedir()),
        clock,
      );
      const gitByDir = new Map<string, GitAdapter>();
      const githubByHost = new Map<string, GitHubAdapter>();
      const { settings, problems } = parseSettings(
        readConfigFile(envPort.configDir()),
      );
      built = {
        store,
        clock,
        env: envPort,
        settings,
        settingsProblems: problems,
        git(dir) {
          let git = gitByDir.get(dir);
          if (!git) {
            git = new GitAdapter(dir);
            gitByDir.set(dir, git);
          }
          return git;
        },
        github(host) {
          let github = githubByHost.get(host);
          if (!github) {
            github = new GitHubAdapter({
              host,
              tokenProvider: () => envPort.githubToken(host),
              kv: store.kv,
              now: clock.now,
            });
            githubByHost.set(host, github);
          }
          return github;
        },
      };
      return built;
    },
  };
}
