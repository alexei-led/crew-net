import { describe, expect, test } from "bun:test";
import { type Contract, parseRepoConfig } from "../../protocol";
import {
  classify,
  type Finding,
  type LandedFacts,
  type MergeFacts,
  matchGlob,
  type RadarConfig,
  stale,
  type WorkFacts,
} from "./index";

const REPO = "doiteng/reflex";
const OMNI = "doiteng/omni";

const work = (
  owner: string,
  changedPaths: string[] = [],
  over: Partial<WorkFacts> = {},
): WorkFacts => ({
  repo: REPO,
  owner,
  branch: `${owner}-feat`,
  base: "main",
  changedPaths,
  ...over,
});
const clean: MergeFacts = { clean: true };
const conflict = (...paths: string[]): MergeFacts => ({ clean: false, paths });

const kinds = (findings: Finding[]) => findings.map((f) => f.kind);
const run = (
  mine: WorkFacts,
  theirs: WorkFacts,
  merge: MergeFacts = clean,
  config: Partial<RadarConfig> = {},
) => classify({ mine, theirs, merge }, config);

describe("classify: conflict and overlap", () => {
  test("clean merge, disjoint paths: nothing", () => {
    expect(run(work("a", ["x.ts"]), work("b", ["y.ts"]))).toEqual([]);
  });

  test("conflict carries merge-tree paths, sorted, and a key", () => {
    const [f] = run(
      work("alexei", ["x.ts", "a.ts"]),
      work("maria", ["x.ts", "a.ts"], { pr: 2318 }),
      conflict("x.ts", "a.ts"),
    );
    expect(f).toEqual({
      kind: "conflict",
      mine: { repo: REPO, owner: "alexei", branch: "alexei-feat" },
      other: { repo: REPO, owner: "maria", branch: "maria-feat", pr: 2318 },
      paths: ["a.ts", "x.ts"],
      key: "conflict||doiteng/reflex:alexei-feat|doiteng/reflex#2318|a.ts,x.ts",
      mayWake: false,
    });
  });

  test("a conflicted file is not also an overlap", () => {
    const findings = run(
      work("a", ["x.ts", "y.ts"]),
      work("b", ["x.ts", "y.ts"]),
      conflict("x.ts"),
    );
    expect(findings.map((f) => [f.kind, f.paths])).toEqual([
      ["conflict", ["x.ts"]],
      ["overlap", ["y.ts"]],
    ]);
  });

  test("every shared file conflicted: conflict only", () => {
    expect(
      kinds(run(work("a", ["x.ts"]), work("b", ["x.ts"]), conflict("x.ts"))),
    ).toEqual(["conflict"]);
  });

  test("overlap lists only shared paths", () => {
    const findings = run(
      work("a", ["x.ts", "z.ts"]),
      work("b", ["y.ts", "x.ts"]),
    );
    expect(findings.map((f) => [f.kind, f.paths])).toEqual([
      ["overlap", ["x.ts"]],
    ]);
  });

  test("bare branch of another developer is compared", () => {
    const [f] = run(work("a", ["x.ts"]), work("b", ["x.ts"]));
    expect(f?.other).toEqual({ repo: REPO, owner: "b", branch: "b-feat" });
    expect(f?.key).toContain("doiteng/reflex:b-feat");
  });

  test("different base: nothing", () => {
    expect(
      run(
        work("a", ["x.ts"]),
        work("b", ["x.ts"], { base: "dev" }),
        conflict("x.ts"),
      ),
    ).toEqual([]);
  });

  test.each([
    ["alexei", "alexei"],
    ["Alexei", "alexei"],
  ])("same owner %s / %s: nothing", (mine, theirs) => {
    expect(
      run(work(mine, ["x.ts"]), work(theirs, ["x.ts"]), conflict("x.ts")),
    ).toEqual([]);
  });

  test.each([
    "renovate",
    "dependabot",
    "github-actions",
    "dependabot[bot]",
    "app/renovate",
    "Renovate",
  ])("bot %s: nothing", (bot) => {
    expect(
      run(work("a", ["x.ts"]), work(bot, ["x.ts"]), conflict("x.ts")),
    ).toEqual([]);
  });

  test("bot list is configurable", () => {
    const theirs = work("ci-bot", ["x"]);
    expect(run(work("a", ["x"]), theirs, clean, { bots: ["ci-bot"] })).toEqual(
      [],
    );
    expect(kinds(run(work("a", ["x"]), theirs))).toEqual(["overlap"]);
    expect(
      run(work("a", ["x"]), work("renovate", ["x"]), clean, {
        bots: ["ci-bot"],
      }),
    ).toEqual([]);
  });

  test("dedupe key changes with the file set, not with order of paths", () => {
    const key = (paths: string[]) =>
      run(work("a", paths), work("b", paths))[0]?.key;
    expect(key(["x", "y"])).toBe(key(["y", "x"]));
    expect(key(["x", "y"])).not.toBe(key(["x"]));
  });

  test("no finding ever may wake", () => {
    const all = run(
      work("a", ["db/migrations/1.sql", "x.ts", "y.ts"]),
      work("b", ["x.ts", "y.ts"]),
      conflict("x.ts"),
    );
    expect(kinds(all)).toEqual(["conflict", "overlap", "order"]);
    expect(all.every((f) => f.mayWake === false)).toBe(true);
  });
});

describe("classify: order with default contracts", () => {
  const order = (mine: WorkFacts, theirs: WorkFacts) =>
    run(mine, theirs)
      .filter((f) => f.kind === "order")
      .map((f) => [f.producer, f.contract, f.paths]);

  test.each([
    "db/migrations/001.sql",
    "src/add_migration_x.sql",
    "api/openapi/users.yaml",
    "proto/users.proto",
  ])("their producer %s, my other path", (path) => {
    expect(order(work("a", ["web/x.ts"]), work("b", [path]))).toEqual([
      ["other", "default", [path, "web/x.ts"].sort()],
    ]);
  });

  test("my producer, their consumer", () => {
    expect(
      order(work("a", ["db/migrations/1.sql"]), work("b", ["api/m.ts"])),
    ).toEqual([["mine", "default", ["api/m.ts", "db/migrations/1.sql"]]]);
  });

  test("producer paths on the other side are not consumer paths", () => {
    expect(
      order(
        work("a", ["db/migrations/1.sql"]),
        work("b", ["db/migrations/2.sql"]),
      ),
    ).toEqual([]);
  });

  test("workflows are not a default producer", () => {
    expect(
      order(work("a", ["src/x.ts"]), work("b", [".github/workflows/ci.yml"])),
    ).toEqual([]);
  });
});

describe("classify: order with declared contracts", () => {
  const api: Contract = {
    name: "api",
    producer: ["api/openapi/**"],
    consumers: [
      { pattern: "web/src/api/**" },
      { repo: OMNI, pattern: "clients/reflex/**" },
    ],
  };
  const config: Partial<RadarConfig> = { contracts: { [REPO]: [api] } };
  const order = (mine: WorkFacts, theirs: WorkFacts) =>
    run(mine, theirs, clean, config)
      .filter((f) => f.kind === "order")
      .map((f) => [f.producer, f.contract, f.paths]);

  test("local consumer", () => {
    expect(
      order(work("a", ["web/src/api/u.ts"]), work("b", ["api/openapi/u.yaml"])),
    ).toEqual([["other", "api", ["api/openapi/u.yaml", "web/src/api/u.ts"]]]);
  });

  test("declared contracts replace the defaults", () => {
    expect(
      order(work("a", ["src/x.ts"]), work("b", ["db/migrations/1.sql"])),
    ).toEqual([]);
  });

  test("path outside the consumer globs: nothing", () => {
    expect(
      order(work("a", ["web/src/app.ts"]), work("b", ["api/openapi/u.yaml"])),
    ).toEqual([]);
  });

  test("cross-repo consumer in the named repo", () => {
    const mine = work("a", ["clients/reflex/u.ts"], {
      repo: OMNI,
      base: "dev",
    });
    expect(order(mine, work("b", ["api/openapi/u.yaml"]))).toEqual([
      ["other", "api", ["api/openapi/u.yaml", "clients/reflex/u.ts"]],
    ]);
  });

  test("cross-repo producer is mine", () => {
    const theirs = work("b", ["clients/reflex/u.ts"], { repo: OMNI });
    expect(order(work("a", ["api/openapi/u.yaml"]), theirs)).toEqual([
      ["mine", "api", ["api/openapi/u.yaml", "clients/reflex/u.ts"]],
    ]);
  });

  test("cross-repo pair gives only order findings, never conflict or overlap", () => {
    const theirs = work("b", ["api/openapi/u.yaml"], { repo: "x/other" });
    expect(
      run(
        work("a", ["api/openapi/u.yaml"]),
        theirs,
        conflict("api/openapi/u.yaml"),
        config,
      ),
    ).toEqual([]);
  });

  test("local consumer globs do not apply in another repo", () => {
    const mine = work("a", ["web/src/api/u.ts"], { repo: OMNI });
    expect(order(mine, work("b", ["api/openapi/u.yaml"]))).toEqual([]);
  });

  test("contract repo keys match case-insensitively", () => {
    const findings = run(
      work("a", ["web/src/api/u.ts"]),
      work("b", ["api/openapi/u.yaml"]),
      clean,
      { contracts: { "DoitEng/Reflex": [api] } },
    );
    expect(findings.map((f) => f.contract)).toEqual(["api"]);
  });
});

test("a parsed crew-net.yml drives order findings across repos", () => {
  const parsed = parseRepoConfig(
    [
      "contracts:",
      "  - name: api",
      "    producer: [api/openapi/**]",
      `    consumers: [web/src/api/**, "${OMNI}:clients/reflex/**"]`,
    ].join("\n"),
  );
  if (!parsed.ok) throw new Error(parsed.detail);
  const findings = classify(
    {
      mine: work("a", ["clients/reflex/u.ts"], { repo: OMNI }),
      theirs: work("b", ["api/openapi/u.yaml"]),
      merge: clean,
    },
    { contracts: { [REPO]: parsed.config.contracts } },
  );
  expect(findings.map((f) => [f.kind, f.contract, f.producer])).toEqual([
    ["order", "api", "other"],
  ]);
});

describe("stale", () => {
  const landed = (
    number: number,
    changedPaths: string[],
    over: Partial<LandedFacts> = {},
  ): LandedFacts => ({
    repo: REPO,
    owner: "maria",
    number,
    base: "main",
    changedPaths,
    ...over,
  });
  const mine = work("alexei", ["api/server.ts", "web/a.ts"], { pr: 2310 });

  test("a merged PR touching my files", () => {
    expect(
      stale(mine, [landed(2305, ["web/a.ts", "api/server.ts", "z"])]),
    ).toEqual([
      {
        kind: "stale",
        mine: { repo: REPO, owner: "alexei", branch: "alexei-feat", pr: 2310 },
        other: { repo: REPO, owner: "maria", pr: 2305 },
        paths: ["api/server.ts", "web/a.ts"],
        key: "stale||doiteng/reflex#2310|doiteng/reflex#2305|api/server.ts,web/a.ts",
        mayWake: false,
      },
    ]);
  });

  test.each<[string, LandedFacts]>([
    ["disjoint files", landed(1, ["z.ts"])],
    ["another base", landed(1, ["web/a.ts"], { base: "dev" })],
    ["another repo", landed(1, ["web/a.ts"], { repo: OMNI })],
    ["a bot", landed(1, ["web/a.ts"], { owner: "renovate[bot]" })],
  ])("nothing for %s", (_name, pr) => {
    expect(stale(mine, [pr])).toEqual([]);
  });

  test("my own merged PR counts", () => {
    expect(
      kinds(stale(mine, [landed(1, ["web/a.ts"], { owner: "alexei" })])),
    ).toEqual(["stale"]);
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
    ["**/*.proto", "a/b/u.proto", true],
    ["src/*/a.ts", "src/x/a.ts", true],
    ["src/*/a.ts", "src/x/y/a.ts", false],
    ["src/**/a.ts", "src/a.ts", true],
    ["src/**/a.ts", "src/x/y/a.ts", true],
    ["db/migrations", "db/migrations/001.sql", true],
    ["src/*", "src/a/b.ts", true],
    ["a.b", "a.b", true],
    ["a.b", "aXb", false],
    ["a(b)+", "a(b)+", true],
    ["api/v?/**", "api/v2/x.yaml", true],
    ["api/v?/**", "api/v22/x.yaml", false],
    ["a?b", "a/b", false],
    ["**", "anything/at/all", true],
    ["", "a", false],
    // Trailing slash: a directory prefix.
    ["api/openapi/", "api/openapi/users.yaml", true],
    ["api/openapi/", "api/openapi/sub/u.yaml", true],
    ["api/openapi/", "api/openapi", false],
    ["api/openapi/", "api/openapix/u.yaml", false],
    ["api/openapi/", "x/api/openapi/u.yaml", false],
    ["migrations/", "db/migrations/1.sql", true],
    ["migrations/", "migrations", false],
    // Leading slash anchors at the root.
    ["/a.ts", "a.ts", true],
    ["/a.ts", "src/a.ts", false],
    ["/src/", "src/x.ts", true],
    ["/src/", "lib/src/x.ts", false],
    // No slash: any depth, as in .gitignore.
    ["*.ts", "a.ts", true],
    ["*.ts", "src/a.ts", true],
    ["*migration*", "src/migrations/y.sql", true],
    // A middle slash anchors.
    ["src/a.ts", "lib/src/a.ts", false],
  ];
  test.each(cases)("%s vs %s → %p", (glob, path, expected) => {
    expect(matchGlob(glob, path)).toBe(expected);
  });
});
