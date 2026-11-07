import { describe, expect, test } from "bun:test";
import {
  type BranchFacts,
  classify,
  type MergeFacts,
  matchGlob,
} from "./index";

const branch = (
  developer: string,
  changedPaths: string[] = [],
  pr?: number,
): BranchFacts => ({
  developer,
  branch: `${developer}-feat`,
  changedPaths,
  ...(pr === undefined ? {} : { pr }),
});
const clean: MergeFacts = { clean: true };

const kinds = (
  mine: BranchFacts,
  theirs: BranchFacts,
  merge: MergeFacts = clean,
  config = {},
) => classify({ mine, theirs, merge }, config).map((f) => f.kind);

describe("classify", () => {
  test("clean merge, disjoint paths: nothing", () => {
    expect(kinds(branch("a", ["x.ts"]), branch("b", ["y.ts"]))).toEqual([]);
  });

  test("conflict carries the merge-tree paths", () => {
    const findings = classify({
      mine: branch("a", ["x.ts"]),
      theirs: branch("b", ["x.ts"], 7),
      merge: { clean: false, paths: ["x.ts"] },
    });
    expect(findings).toContainEqual({
      kind: "conflict",
      other: { developer: "b", branch: "b-feat", pr: 7 },
      paths: ["x.ts"],
      blocking: true,
    });
  });

  test("overlap lists only shared paths", () => {
    const findings = classify({
      mine: branch("a", ["x.ts", "z.ts"]),
      theirs: branch("b", ["x.ts", "y.ts"]),
      merge: clean,
    });
    expect(findings).toEqual([
      {
        kind: "overlap",
        other: { developer: "b", branch: "b-feat" },
        paths: ["x.ts"],
        blocking: false,
      },
    ]);
  });

  test.each([
    ["api/openapi/v1.yaml"],
    ["db/migrations/001.sql"],
    ["001_migration.sql"],
    [".github/workflows/ci.yml"],
  ])("contract path %s by the other PR", (path) => {
    const findings = classify({
      mine: branch("a"),
      theirs: branch("b", [path, "README.md"]),
      merge: clean,
    });
    expect(findings).toEqual([
      {
        kind: "contract-path",
        other: { developer: "b", branch: "b-feat" },
        paths: [path],
        blocking: true,
      },
    ]);
  });

  test("my own contract-path change is not a finding", () => {
    expect(kinds(branch("a", ["api/openapi/v1.yaml"]), branch("b"))).toEqual(
      [],
    );
  });

  test("contract path list is configurable", () => {
    const theirs = branch("b", ["infra/main.tf"]);
    expect(kinds(branch("a"), theirs)).toEqual([]);
    expect(
      kinds(branch("a"), theirs, clean, { contractPaths: ["infra/**"] }),
    ).toEqual(["contract-path"]);
  });

  test("conflict, overlap and contract hit can all fire on one pair", () => {
    expect(
      kinds(
        branch("a", ["api/openapi/v1.yaml"]),
        branch("b", ["api/openapi/v1.yaml"]),
        { clean: false, paths: ["api/openapi/v1.yaml"] },
      ),
    ).toEqual(["conflict", "overlap", "contract-path"]);
  });

  test("same developer pair is skipped, case-insensitively", () => {
    const merge: MergeFacts = { clean: false, paths: ["x.ts"] };
    expect(
      kinds(branch("alexei", ["x.ts"]), branch("alexei", ["x.ts"]), merge),
    ).toEqual([]);
    expect(
      kinds(branch("Alexei", ["x.ts"]), branch("alexei", ["x.ts"]), merge),
    ).toEqual([]);
  });

  test.each([
    "renovate",
    "dependabot",
    "github-actions",
    "dependabot[bot]",
    "app/renovate",
    "Renovate",
  ])("bot author %s is skipped", (bot) => {
    expect(
      kinds(branch("a", ["x.ts"]), branch(bot, ["x.ts", "api/openapi/a"]), {
        clean: false,
        paths: ["x.ts"],
      }),
    ).toEqual([]);
  });

  test("bot list is configurable", () => {
    expect(
      kinds(branch("a", ["x"]), branch("ci-bot", ["x"]), clean, {
        bots: ["ci-bot"],
      }),
    ).toEqual([]);
    expect(kinds(branch("a", ["x"]), branch("ci-bot", ["x"]))).toEqual([
      "overlap",
    ]);
  });
});

describe("matchGlob", () => {
  const cases: [string, string, boolean][] = [
    ["api/openapi/**", "api/openapi/v1.yaml", true],
    ["api/openapi/**", "api/openapi/sub/v1.yaml", true],
    ["api/openapi/**", "api/other/v1.yaml", false],
    ["api/openapi/**", "xapi/openapi/v1.yaml", false],
    ["**/*migration*", "migration.sql", true],
    ["**/*migration*", "db/migrations/001.sql", true],
    ["**/*migration*", "a/b/c/add_migration_x.sql", true],
    ["**/*migration*", "src/app.ts", false],
    ["*.ts", "a.ts", true],
    ["*.ts", "src/a.ts", false],
    ["src/*/a.ts", "src/x/a.ts", true],
    ["src/*/a.ts", "src/x/y/a.ts", false],
    ["src/**/a.ts", "src/a.ts", true],
    ["src/**/a.ts", "src/x/y/a.ts", true],
    [".github/workflows/**", ".github/workflows/ci.yml", true],
    [".github/workflows/**", "xgithub/workflows/ci.yml", false],
    ["db/migrations", "db/migrations/001.sql", true],
    ["*migration*", "migrations/x/y.sql", true],
    ["*migration*", "src/migrations/y.sql", false],
    ["src/*", "src/a/b.ts", true],
    ["a.b", "a.b", true],
    ["a.b", "aXb", false],
    ["a(b)+", "a(b)+", true],
  ];
  test.each(cases)("%s vs %s", (glob, path, expected) => {
    expect(matchGlob(glob, path)).toBe(expected);
  });
});
