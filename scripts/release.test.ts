import { afterAll, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  changelogSection,
  checkVersions,
  datedChangelog,
  parseVersion,
  setVersion,
} from "./release";

const changelog = `# Changelog

## 0.2.0 - 2026-12-01

### Added

- A thing.

## 0.1.0 - 2026-11-09

First release.
`;

test.each([
  ["0.1.0", "0.1.0"],
  ["v1.20.3", "1.20.3"],
])("parseVersion accepts %s", (input, expected) => {
  expect(parseVersion(input)).toBe(expected);
});

test.each(["", undefined, "1.2", "1.2.3-rc.1", "01.2.3", "v1.2.3.4", "latest"])(
  "parseVersion rejects %p",
  (input) => {
    expect(() => parseVersion(input)).toThrow("MAJOR.MINOR.PATCH");
  },
);

test("changelogSection returns only the named section", () => {
  expect(changelogSection(changelog, "0.2.0")).toBe("### Added\n\n- A thing.");
  expect(changelogSection(changelog, "0.1.0")).toBe("First release.");
});

test.each([
  [
    "a missing section",
    "# Changelog\n\n## 0.1.0 - 2026-11-09\n\nx\n",
    "0.3.0",
    'no "## 0.3.0"',
  ],
  [
    "an unreleased heading",
    "## 0.3.0 (unreleased)\n\nx\n",
    "0.3.0",
    "YYYY-MM-DD",
  ],
  ["an impossible date", "## 0.3.0 - soon\n\nx\n", "0.3.0", "YYYY-MM-DD"],
  [
    "an empty section",
    "## 0.3.0 - 2026-12-01\n\n## 0.2.0 - 2026-11-01\n\nx\n",
    "0.3.0",
    "empty",
  ],
  [
    "a version that only shares a prefix",
    "## 0.10.0 - 2026-12-01\n\nx\n",
    "0.1.0",
    'no "## 0.1.0"',
  ],
])("changelogSection rejects %s", (_name, text, version, message) => {
  expect(() => changelogSection(text, version)).toThrow(message);
});

describe("datedChangelog", () => {
  test("dates the unreleased section", () => {
    expect(
      datedChangelog("## 0.3.0 (unreleased)\n\nnotes\n", "0.3.0", "2026-12-01"),
    ).toBe("## 0.3.0 - 2026-12-01\n\nnotes\n");
  });

  test("keeps an already dated section", () => {
    expect(datedChangelog(changelog, "0.2.0", "2030-01-01")).toBe(changelog);
  });

  test("refuses a version without notes", () => {
    expect(() => datedChangelog(changelog, "0.9.0", "2026-12-01")).toThrow(
      "write the release notes first",
    );
  });
});

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function repo(versions: {
  pkg: string;
  plugin: string;
  market: string;
  source: string;
}): string {
  const root = mkdtempSync(join(tmpdir(), "release-"));
  roots.push(root);
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  };
  put("package.json", JSON.stringify({ version: versions.pkg }));
  put(
    "plugin/.claude-plugin/plugin.json",
    JSON.stringify({ version: versions.plugin }),
  );
  put(
    ".claude-plugin/marketplace.json",
    JSON.stringify({
      plugins: [{ name: "crew-net", version: versions.market }],
    }),
  );
  put("src/cli/main.ts", `export const VERSION = "${versions.source}";\n`);
  return root;
}

test("checkVersions passes when every file agrees", () => {
  const root = repo({
    pkg: "0.2.0",
    plugin: "0.2.0",
    market: "0.2.0",
    source: "0.2.0",
  });
  expect(checkVersions(root, "0.2.0")).toBe("0.2.0");
  expect(checkVersions(root)).toBe("0.2.0");
});

const agreed = {
  pkg: "0.2.0",
  plugin: "0.2.0",
  market: "0.2.0",
  source: "0.2.0",
};
const old = { pkg: "0.1.0", plugin: "0.1.0", market: "0.1.0", source: "0.1.0" };

test.each([
  [
    "the marketplace file differs",
    { ...agreed, market: "0.1.0" },
    "marketplace.json: 0.1.0",
  ],
  [
    "the plugin file differs",
    { ...agreed, plugin: "0.1.0" },
    "plugin.json: 0.1.0",
  ],
  [
    "the source file differs",
    { ...agreed, source: "0.1.0" },
    "src/cli/main.ts: 0.1.0",
  ],
  ["every file agrees on the wrong version", old, "differ from 0.2.0"],
])("checkVersions rejects when %s", (_name, versions, message) => {
  expect(() => checkVersions(repo(versions), "0.2.0")).toThrow(message);
});

test("setVersion changes only the version and keeps each file's layout", () => {
  const root = repo({
    pkg: "0.1.0",
    plugin: "0.1.0",
    market: "0.1.0",
    source: "0.1.0",
  });
  const layout =
    '{\n  "name": "x",\n  "version": "0.1.0",\n  "keywords": ["a", "b"]\n}\n';
  writeFileSync(join(root, "plugin/.claude-plugin/plugin.json"), layout);
  setVersion(root, "0.2.0");
  expect(
    readFileSync(join(root, "plugin/.claude-plugin/plugin.json"), "utf8"),
  ).toBe(layout.replace("0.1.0", "0.2.0"));
  expect(checkVersions(root, "0.2.0")).toBe("0.2.0");
});
