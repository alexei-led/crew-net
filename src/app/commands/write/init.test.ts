import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FilesAdapter } from "../../../adapters/files/index";
import { DEFAULT_REPO_CONFIG, parseRepoConfig } from "../../../protocol/index";
import { FakeGit, harness, ROOT } from "./fixtures/fakes";
import { CONFIG_PATH, CommandError, type InitKit, init } from "./index";

const kitFile = (path: string) =>
  readFileSync(join(import.meta.dir, "../../../../repo-kit", path), "utf8");

const KIT: InitKit = {
  config: kitFile("templates/crew-net.yml"),
  crewDeps: kitFile("workflows/crew-deps.yml"),
  crewDepsRerun: kitFile("workflows/crew-deps-rerun.yml"),
  crewDepsScript: kitFile("scripts/crew-deps.mjs"),
};

const DEPS_FILES = [
  ".github/workflows/crew-deps.yml",
  ".github/workflows/crew-deps-rerun.yml",
  ".github/scripts/crew-deps.mjs",
];

describe("init (design: user guide)", () => {
  test("writes the repo config into the working tree, nothing else", async () => {
    const h = harness({ cwd: `${ROOT}/src/api` });
    const result = await init(h.ctx, { kit: KIT });
    expect(result.root).toBe(ROOT);
    expect(result.written).toEqual([CONFIG_PATH]);
    expect([...h.files.files.keys()]).toEqual([`${ROOT}/${CONFIG_PATH}`]);
    expect(result.next.join("\n")).toMatch(/never commits or pushes/);
    expect(h.github.reads).toEqual([]);
    expect(h.github.writes).toEqual([]);
  });

  test("--deps adds the crew-deps workflows and script", async () => {
    const h = harness();
    const result = await init(h.ctx, { kit: KIT, deps: true });
    expect(result.written).toEqual([CONFIG_PATH, ...DEPS_FILES]);
    expect(h.files.files.get(`${ROOT}/.github/scripts/crew-deps.mjs`)).toBe(
      KIT.crewDepsScript,
    );
    expect(result.next.at(-1)).toMatch(/required check/);
  });

  test("refuses to overwrite and then writes nothing at all", async () => {
    const h = harness();
    h.files.files.set(`${ROOT}/.github/workflows/crew-deps.yml`, "mine");
    let error: unknown;
    try {
      await init(h.ctx, { kit: KIT, deps: true });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CommandError);
    expect((error as CommandError).message).toMatch(
      /already present: \.github\/workflows\/crew-deps\.yml\. Nothing was written.*--force/,
    );
    expect([...h.files.files.keys()]).toEqual([
      `${ROOT}/.github/workflows/crew-deps.yml`,
    ]);
  });

  test("--force replaces existing files", async () => {
    const h = harness();
    h.files.files.set(`${ROOT}/${CONFIG_PATH}`, "old");
    await init(h.ctx, { kit: KIT, force: true });
    expect(h.files.files.get(`${ROOT}/${CONFIG_PATH}`)).toBe(KIT.config);
  });

  test("outside a working tree is a usage error", async () => {
    const h = harness({ git: new FakeGit([]) });
    await expect(init(h.ctx, { kit: KIT })).rejects.toMatchObject({
      code: "usage",
    });
  });
});

describe("repo-kit template", () => {
  test("crew-net.yml parses to the defaults", () => {
    expect(parseRepoConfig(KIT.config)).toEqual({
      ok: true,
      config: DEFAULT_REPO_CONFIG,
    });
  });

  test("the commented contracts example parses when uncommented", () => {
    const uncommented = KIT.config
      .slice(KIT.config.indexOf("# contracts:"))
      .replace(/^# ?/gm, "");
    const parsed = parseRepoConfig(uncommented);
    expect(parsed.ok && parsed.config.contracts.map((c) => c.name)).toEqual([
      "api",
      "db",
    ]);
  });

  const actionlint = spawnSync("actionlint", ["-version"]).status === 0;
  test.skipIf(!actionlint)("generated workflows pass actionlint", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crew-init-"));
    try {
      const h = harness({
        cwd: dir,
        git: new FakeGit([{ path: dir, branch: "main" }]),
        files: new FilesAdapter(),
      });
      await init(h.ctx, { kit: KIT, deps: true });
      const lint = spawnSync(
        "actionlint",
        DEPS_FILES.filter((p) => p.endsWith(".yml")).map((p) => join(dir, p)),
        { cwd: dir, encoding: "utf8" },
      );
      expect(lint.stdout + lint.stderr).toBe("");
      expect(lint.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
