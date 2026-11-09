import type {
  ClockPort,
  EnvPort,
  GitHubPort,
  GitPort,
  StorePort,
} from "../ports/index";
import type { Settings } from "./settings";

/**
 * Everything the application reads and writes. The composition root builds
 * it from adapters; tests build it from in-memory fakes.
 */
export interface AppPorts {
  store: StorePort;
  clock: ClockPort;
  env: EnvPort;
  /** The developer's `config.json`, already read. */
  settings: Settings;
  /** What was wrong with `config.json`, for `doctor`. */
  settingsProblems: string[];
  /** One GitHub client per host. */
  github(host: string): GitHubPort;
  /** Git for one working copy or clone directory. */
  git(dir: string): GitPort;
}
