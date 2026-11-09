import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { VERSION } from "../src/cli/main";

const json = (path: string) => JSON.parse(readFileSync(path, "utf8"));

test("the CLI, package, plugin and marketplace carry one version", () => {
  const market = json(".claude-plugin/marketplace.json");
  expect({
    package: json("package.json").version,
    plugin: json("plugin/.claude-plugin/plugin.json").version,
    marketplace: market.plugins.find(
      (p: { name: string }) => p.name === "crew-net",
    )?.version,
  }).toEqual({ package: VERSION, plugin: VERSION, marketplace: VERSION });
});
