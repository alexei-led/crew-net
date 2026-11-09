import { homedir } from "node:os";
import { EnvAdapter } from "../adapters/env/index";
import { GitAdapter } from "../adapters/git/index";
import { GitHubAdapter } from "../adapters/github/index";
import { defaultStateDir, FileStoreAdapter } from "../adapters/store/index";
import type { AppPorts } from "../app/ports";
import type { Runtime } from "./command";

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
      built = {
        store,
        clock,
        env: envPort,
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
