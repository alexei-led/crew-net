import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

// The architecture gates (Biome noRestrictedImports, tsconfig.pure.json) must
// reject a planted violation. All violations are planted at once in a copy of
// the tree and checked with one lint run and one type-check run.

// Biome and tsc on a full tree copy: under a parallel suite 5 s is not enough.
setDefaultTimeout(60_000);

const root = process.cwd();
let fixture: string;

interface Run {
  status: number | null;
  stdout: string;
  output: string;
}

function run(...args: string[]): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn("bun", ["x", ...args], { cwd: fixture });
    let stdout = "";
    let output = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, output }));
  });
}

/** Writes a file into the fixture; the returned function puts back what was there. */
function plant(path: string, source: string): () => void {
  const file = join(fixture, path);
  mkdirSync(join(file, ".."), { recursive: true });
  const original = existsSync(file) ? readFileSync(file) : undefined;
  writeFileSync(file, source);
  return () =>
    original === undefined ? rmSync(file) : writeFileSync(file, original);
}

beforeAll(() => {
  fixture = mkdtempSync(join(root, ".fitness-"));
  for (const file of ["biome.json", "tsconfig.json", "tsconfig.pure.json"])
    cpSync(join(root, file), join(fixture, file));
  cpSync(join(root, "src"), join(fixture, "src"), { recursive: true });
  cpSync(join(root, "plugin"), join(fixture, "plugin"), { recursive: true });
  symlinkSync(join(root, "node_modules"), join(fixture, "node_modules"), "dir");
});

afterAll(() => rmSync(fixture, { recursive: true, force: true }));

// [planted file, source, rule named in the diagnostic]
const VIOLATIONS: [string, string, string][] = [
  ["src/protocol/app.ts", 'import "../app/index";', "protocol-is-independent"],
  [
    "src/protocol/core-type.ts",
    'import type * as core from "../core/index";',
    "protocol-is-independent",
  ],
  ["src/protocol/clock.ts", "new Date();", "noRestrictedGlobals"],
  [
    "src/core/delivery/app.ts",
    'import "../../app/index";',
    "core-only-depends-on-core-and-protocol",
  ],
  [
    "src/core/delivery/node.ts",
    'import "node:fs";',
    "core-only-depends-on-core-and-protocol",
  ],
  [
    "src/core/delivery/package.ts",
    'import "left-pad";',
    "core-only-depends-on-core-and-protocol",
  ],
  [
    "src/core/delivery/ports.ts",
    'import "../../ports/index";',
    "core-only-depends-on-core-and-protocol",
  ],
  [
    "src/core/delivery/reexport.ts",
    'export * from "../../app/index";',
    "core-only-depends-on-core-and-protocol",
  ],
  [
    "src/app/adapter.ts",
    'import "../adapters/git/index";',
    "app-only-depends-on-core-protocol-ports",
  ],
  [
    "src/app/cli.ts",
    'import "../cli/index";',
    "app-only-depends-on-core-protocol-ports",
  ],
  [
    "src/app/node.ts",
    'import "node:fs/promises";',
    "app-only-depends-on-core-protocol-ports",
  ],
  [
    "src/app/commands/dynamic.ts",
    'export async function f() { await import("../../watch/index"); }',
    "app-only-depends-on-core-protocol-ports",
  ],
  [
    "src/adapters/git/app.ts",
    'import "../../app/ports";',
    "adapters-only-depend-on-ports-protocol-and-self",
  ],
  [
    "src/adapters/git/sibling.ts",
    'import "../github/index";',
    "adapters-only-depend-on-ports-protocol-and-self",
  ],
  [
    "src/adapters/git/core.ts",
    'import "../../core/index";',
    "adapters-only-depend-on-ports-protocol-and-self",
  ],
  [
    "src/adapters/index.ts",
    'import "../app/index";',
    "adapters-only-depend-on-ports-protocol-and-self",
  ],
  [
    "plugin/hooks/ports.ts",
    'import "../../src/ports/index";',
    "plugin-only-depends-on-core-and-protocol",
  ],
  [
    "plugin/hooks/app.ts",
    'import "../../src/app/index";',
    "plugin-only-depends-on-core-and-protocol",
  ],
  [
    "plugin/hooks/store.ts",
    'import "../../src/adapters/store/index";',
    "plugin-only-depends-on-core-and-protocol",
  ],
  ["plugin/hooks/mod.ts", 'import "node:fs";', "mod-has-no-node"],
  [
    "plugin/hooks/register.ts",
    'import "../../src/adapters/store/index";',
    "plugin-only-depends-on-core-and-protocol",
  ],
];

interface Diagnostic {
  message: string;
  category: string;
  location: { path: string };
}

describe("planted violations", () => {
  let diagnostics: Diagnostic[];
  let lint: Run;
  let pure: Run;

  beforeAll(async () => {
    const restore = [
      ...VIOLATIONS.map(([path, source]) => plant(path, source)),
      plant("src/core/delivery/fetch.ts", 'fetch("https://example.com");'),
    ];
    try {
      [lint, pure] = await Promise.all([
        run(
          "biome",
          "lint",
          "--error-on-warnings",
          "--max-diagnostics=none",
          "--reporter=json",
          ...VIOLATIONS.map(([path]) => path),
        ),
        run("tsc", "--noEmit", "-p", "tsconfig.pure.json"),
      ]);
    } finally {
      for (const undo of restore) undo();
    }
    diagnostics = JSON.parse(lint.stdout).diagnostics;
  });

  test("fail the lint", () => {
    expect(lint.status).toBe(1);
  });

  test.each(VIOLATIONS)("%s: %p is rejected by %s", (path, _source, rule) => {
    const found = diagnostics.filter((d) => d.location.path === path);
    expect(
      found.some((d) => d.message.includes(rule) || d.category.endsWith(rule)),
    ).toBe(true);
  });

  test("core cannot reach fetch", () => {
    expect(pure.status).not.toBe(0);
    expect(pure.output).toContain(
      "src/core/delivery/fetch.ts(1,1): error TS2304: Cannot find name 'fetch'",
    );
  });
});

test("allowed imports pass the lint", async () => {
  const restore = [
    plant(
      "src/adapters/git/plant.ts",
      'import "node:fs"; import "node:fs/promises"; import "./index"; import "../../ports/index";',
    ),
    plant(
      "src/app/plant.ts",
      'import "./ports"; import "./watch"; import "../core/radar/index"; import "../protocol/index"; import "../ports/index";',
    ),
    plant(
      "plugin/hooks/plant.ts",
      'import "node:fs"; import "../../src/core/order/index"; import "../../src/core/trust/index"; import "../../src/protocol/index";',
    ),
  ];
  try {
    const result = await run(
      "biome",
      "lint",
      "--error-on-warnings",
      "src",
      "plugin",
    );
    expect(result.output).not.toContain("error");
    expect(result.status).toBe(0);
  } finally {
    for (const undo of restore) undo();
  }
});
