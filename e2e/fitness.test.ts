import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
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

const root = process.cwd();

test("architecture gates reject planted violations", () => {
  const fixture = mkdtempSync(join(root, ".fitness-"));
  try {
    for (const file of [
      ".dependency-cruiser.cjs",
      "biome.json",
      "tsconfig.json",
      "tsconfig.pure.json",
    ]) {
      cpSync(join(root, file), join(fixture, file));
    }
    cpSync(join(root, "src"), join(fixture, "src"), { recursive: true });
    cpSync(join(root, "plugin"), join(fixture, "plugin"), { recursive: true });
    symlinkSync(
      join(root, "node_modules"),
      join(fixture, "node_modules"),
      "dir",
    );

    const run = (...args: string[]) => {
      const result = spawnSync("bun", ["x", ...args], {
        cwd: fixture,
        encoding: "utf8",
      });
      if (result.error) throw result.error;
      return { status: result.status, output: result.stdout + result.stderr };
    };
    const plant = (path: string, source: string) => {
      const file = join(fixture, path);
      mkdirSync(join(file, ".."), { recursive: true });
      // Planting over a real file (the mod) puts it back afterwards.
      const original = existsSync(file) ? readFileSync(file) : undefined;
      writeFileSync(file, source);
      return () =>
        original === undefined ? rmSync(file) : writeFileSync(file, original);
    };

    const cases = [
      [
        "src/protocol/plant.ts",
        'import "../app/index";',
        "protocol-is-independent",
      ],
      [
        "src/core/delivery/plant.ts",
        'import "../../app/index";',
        "core-only-depends-on-core-and-protocol",
      ],
      [
        "src/core/delivery/plant.ts",
        'import "node:fs";',
        "core-only-depends-on-core-and-protocol",
      ],
      [
        "src/app/plant.ts",
        'import "../adapters/git/index";',
        "app-only-depends-on-core-protocol-ports",
      ],
      [
        "src/adapters/git/plant.ts",
        'import "../github/index";',
        "adapters-only-depend-on-ports-protocol-and-self",
      ],
      [
        "plugin/hooks/plant.ts",
        'import "../../src/app/index";',
        "plugin-only-depends-on-core-and-protocol",
      ],
      [
        "plugin/hooks/plant.ts",
        'import "../../src/adapters/store/index";',
        "plugin-only-depends-on-core-and-protocol",
      ],
      ["plugin/hooks/mod.ts", 'import "node:fs";', "mod-has-no-node"],
    ];
    for (const [path, source, rule] of cases) {
      if (!path || !source || !rule) throw new Error("Invalid fixture");
      const cleanup = plant(path, source);
      const result = run("depcruise", "src", "plugin");
      expect(result.status).toBe(1);
      expect(result.output).toContain(rule);
      console.log(`planted ${path}: ${rule}, rc=${result.status}`);
      cleanup();
    }
    const allowed = [
      plant(
        "src/adapters/git/plant.ts",
        'import "node:fs"; import "./index"; import "../../ports/index";',
      ),
      plant(
        "plugin/hooks/plant.ts",
        'import "node:fs"; import "../../src/core/order/index"; import "../../src/core/trust/index"; import "../../src/protocol/index";',
      ),
    ];
    const allowedResult = run("depcruise", "src", "plugin");
    expect(allowedResult.status).toBe(0);
    for (const cleanup of allowed) cleanup();
    expect(run("depcruise", "src", "plugin").status).toBe(0);

    let cleanup = plant(
      "src/core/delivery/plant.ts",
      'fetch("https://example.com");',
    );
    let result = run("tsc", "--noEmit", "-p", "tsconfig.pure.json");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("Cannot find name 'fetch'");
    console.log(`planted fetch: ${result.output.trim()}, rc=${result.status}`);
    cleanup();

    cleanup = plant("src/protocol/plant.ts", "new Date();");
    result = run("biome", "lint", "src/protocol/plant.ts");
    expect(result.status).not.toBe(0);
    expect(result.output).toContain("noRestrictedGlobals");
    console.log(`planted Date: noRestrictedGlobals, rc=${result.status}`);
    cleanup();

    expect(run("tsc", "--noEmit", "-p", "tsconfig.pure.json").status).toBe(0);
    expect(run("biome", "lint", "src/protocol", "src/core").status).toBe(0);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}, 30_000);
