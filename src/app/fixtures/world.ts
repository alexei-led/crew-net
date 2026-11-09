import type { ClockPort, RepoRef, StorePort } from "../../ports/index";
import type { AppPorts } from "../ports";
import type { Here } from "../scope";
import { DEFAULT_SETTINGS } from "../settings";
import { runSync } from "../sync";
import { FakeEnv, FakeGit, FakeGitHub } from "./fakes";

export const REPO = "o/r";
export const REF: RepoRef = { host: "github.com", owner: "o", name: "r" };
export const START = Date.parse("2026-11-09T12:00:00Z");

/**
 * Ports for app tests: fake GitHub, git and env around a real store. The
 * store comes from the test (`makeStore`), so fixtures never import adapters.
 */
export function world(makeStore: (clock: ClockPort) => StorePort) {
  let now = START;
  const clock = { now: () => now };
  const store = makeStore(clock);
  const github = new FakeGitHub();
  const git = new FakeGit();
  const env = new FakeEnv();
  const ports: AppPorts = {
    store,
    clock,
    env,
    settings: DEFAULT_SETTINGS,
    settingsProblems: [],
    github: () => github,
    git: () => git,
  };
  const here: Here = { ref: REF, dir: "/work/r" };
  return {
    store,
    github,
    git,
    env,
    ports,
    here,
    clock,
    advance: (ms: number) => {
      now += ms;
    },
    sync: (p: AppPorts = ports) => runSync(p, here),
    items: async () => (await store.inbox.list()).map((e) => e.item),
    itemEvents: async () =>
      (await store.events.read()).filter((e) => e.type === "item"),
  };
}

export type World = ReturnType<typeof world>;
