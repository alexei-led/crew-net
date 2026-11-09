import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeGit,
  FakeGitHub,
  FakeStore,
  pull,
  REPO,
} from "../../app/commands/write/fixtures/fakes";
import type { AppPorts } from "../../app/ports";
import { DEFAULT_SETTINGS } from "../../app/settings";
import type { EnvPort } from "../../ports/index";
import type { Runtime } from "../command";
import { main } from "../main";
import { COMMANDS } from "./index";
import { KIT } from "./kit";
import { newId } from "./write-context";

const DIR = realpathSync(mkdtempSync(join(tmpdir(), "crew-cli-")));
afterAll(() => rmSync(DIR, { recursive: true, force: true }));

function world(
  repoIdentity: EnvPort["repoIdentity"] = async () => ({
    host: "github.com",
    repo: REPO,
  }),
) {
  const github = new FakeGitHub();
  github
    .add(REPO, pull(10, { headRef: "feat", body: "" }))
    .add(REPO, pull(20, { author: "maria" }))
    .add(REPO, pull(1));
  const store = new FakeStore();
  let built = false;
  const ports: AppPorts = {
    store,
    clock: { now: () => 5 },
    settings: DEFAULT_SETTINGS,
    settingsProblems: [],
    env: { repoIdentity } as EnvPort,
    github: () => github,
    git: () => new FakeGit([{ path: DIR, branch: "feat" }]),
  };
  const runtime: Runtime = {
    cwd: DIR,
    now: () => 5,
    detach: () => {
      throw new Error("nothing may detach");
    },
    ports: () => {
      built = true;
      return ports;
    },
  };
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    out: (t: string) => out.push(t),
    err: (t: string) => err.push(t),
  };
  return {
    github,
    store,
    built: () => built,
    run: (...argv: string[]) => main(argv, runtime, io, COMMANDS),
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

describe("crew-net write commands", () => {
  test("ask posts and prints one line; --json prints the result", async () => {
    const w = world();
    expect(await w.run("ask", "#20", "need", "the", "column?")).toBe(0);
    expect(w.github.comments[0]?.body).toMatch(/@maria need the column\?$/);
    expect(w.out()).toMatch(/^asked @maria on #20 \(id [a-z0-9]{8}\)/);
    expect(await w.run("ask", "@maria", "--on", "#7", "x", "--json")).toBe(0);
    expect(JSON.parse(w.out().split("\n")[1] ?? "")).toMatchObject({
      kind: "ask",
      to: "maria",
      number: 7,
    });
  });

  test("request bug opens an Issue", async () => {
    const w = world();
    expect(await w.run("request", "@maria", "bug", "500 on /login")).toBe(0);
    expect(w.github.issues).toHaveLength(1);
  });

  test("a refusal exits 1 with the reason on stderr; --json also prints it", async () => {
    const w = world();
    expect(await w.run("ask", "#20", "fixes #3", "--json")).toBe(1);
    expect(w.err()).toMatch(/closing keyword/);
    expect(JSON.parse(w.out())).toMatchObject({ error: "closing-keyword" });
  });

  test("a usage error exits 2", async () => {
    const w = world();
    expect(await w.run("request", "#20", "approve", "x")).toBe(2);
    expect(w.err()).toMatch(/review, fix or bug/);
  });

  test("reply takes one status flag", async () => {
    const w = world();
    w.store.addInbox({
      type: "item",
      id: "c-9",
      kind: "message",
      text: "?",
      addressed: true,
      from: "maria",
      repo: REPO,
      thread: 10,
      event: "review",
      msgId: "k3f9",
    });
    expect(await w.run("reply", "c-9", "--done", "merged")).toBe(0);
    expect(w.github.comments[0]?.body).toContain("status=done");
    expect(await w.run("reply", "c-9", "--done", "--decline", "x")).toBe(2);
  });

  test.each([
    [
      ["--scope", "api/", "web/"],
      ["api/", "web/"],
    ],
    [
      ["--scope", "api/,web/"],
      ["api/", "web/"],
    ],
    [
      ["--scope", "api/", "--scope", "web/"],
      ["api/", "web/"],
    ],
  ])("state %p sets scope %p", async (flags, scope) => {
    const w = world();
    expect(await w.run("state", "building", ...flags, "--json")).toBe(0);
    expect(JSON.parse(w.out())).toMatchObject({ state: "building", scope });
  });

  test("dep add writes depends-on", async () => {
    const w = world();
    expect(await w.run("dep", "add", "#1")).toBe(0);
    expect(w.github.body(REPO, 10)).toContain("depends-on: #1");
    expect(w.out()).toMatch(/^updated #10: .*depends-on: #1/);
  });

  test("init writes the bundled kit", async () => {
    const w = world();
    expect(await w.run("init", "--deps")).toBe(0);
    expect(readFileSync(join(DIR, ".github/crew-net.yml"), "utf8")).toBe(
      KIT.config,
    );
    expect(await w.run("init")).toBe(1);
    expect(w.err()).toMatch(/already present/);
    expect(await w.run("init", "--force")).toBe(0);
  });
});

describe("crew-net gate", () => {
  test("a command that merges nothing is allowed without building ports", async () => {
    const w = world();
    expect(await w.run("gate", "--json", "--", "gh", "pr", "view", "10")).toBe(
      0,
    );
    expect(JSON.parse(w.out())).toMatchObject({ decision: "allow" });
    expect(w.built()).toBe(false);
  });

  test("an open dependency denies with exit 0", async () => {
    const w = world();
    await w.run("dep", "add", "#1");
    expect(await w.run("gate", "--json", "--", "gh pr merge 10 --auto")).toBe(
      0,
    );
    expect(JSON.parse(w.out().split("\n")[1] ?? "")).toEqual({
      decision: "deny",
      reasons: ["acme/app#10: depends-on #1 is not merged"],
      checked: ["acme/app#10"],
      failed: false,
    });
  });

  test("no repo at the cwd denies with exit 1", async () => {
    const w = world(async () => {
      throw new Error("no origin remote");
    });
    expect(await w.run("gate", "--json", "--", "gh", "pr", "merge", "10")).toBe(
      1,
    );
    expect(JSON.parse(w.out())).toMatchObject({
      decision: "deny",
      failed: true,
      reasons: [
        expect.stringMatching(/no origin remote; denied \(fail closed\)/),
      ],
    });
  });

  test("a GitHub failure denies with exit 1", async () => {
    const w = world();
    w.github.failures.set("getPull", new Error("fetch failed"));
    expect(await w.run("gate", "--", "gh pr merge 10")).toBe(1);
    expect(w.out()).toMatch(/^deny:\n {2}crew-net gate: cannot read GitHub/);
  });
});

test("the bundled kit is the repo-kit files", () => {
  const kit = (p: string) =>
    readFileSync(join(import.meta.dir, "../../../repo-kit", p), "utf8");
  expect(KIT).toEqual({
    config: kit("templates/crew-net.yml"),
    crewDeps: kit("workflows/crew-deps.yml"),
    crewDepsRerun: kit("workflows/crew-deps-rerun.yml"),
    crewDepsScript: kit("scripts/crew-deps.mjs"),
  });
});

test("message ids are 8 random [a-z0-9] characters", () => {
  const ids = new Set(Array.from({ length: 50 }, newId));
  expect(ids.size).toBe(50);
  for (const id of ids) expect(id).toMatch(/^[a-z0-9]{8}$/);
});
