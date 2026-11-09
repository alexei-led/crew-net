import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  changelogSection,
  checkVersions,
  datedChangelog,
  parseVersion,
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

test("datedChangelog dates the unreleased section and keeps a dated one", () => {
  const unreleased = "## 0.3.0 (unreleased)\n\nnotes\n";
  expect(datedChangelog(unreleased, "0.3.0", "2026-12-01")).toBe(
    "## 0.3.0 - 2026-12-01\n\nnotes\n",
  );
  expect(datedChangelog(changelog, "0.2.0", "2030-01-01")).toBe(changelog);
  expect(() => datedChangelog(changelog, "0.9.0", "2026-12-01")).toThrow(
    "write the release notes first",
  );
});

function repo(versions: {
  pkg: string;
  plugin: string;
  market: string;
  source: string;
}): string {
  const root = mkdtempSync(join(tmpdir(), "release-"));
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

test.each([
  [
    "marketplace",
    { pkg: "0.2.0", plugin: "0.2.0", market: "0.1.0", source: "0.2.0" },
    "marketplace.json: 0.1.0",
  ],
  [
    "plugin",
    { pkg: "0.2.0", plugin: "0.1.0", market: "0.2.0", source: "0.2.0" },
    "plugin.json: 0.1.0",
  ],
  [
    "source",
    { pkg: "0.2.0", plugin: "0.2.0", market: "0.2.0", source: "0.1.0" },
    "src/cli/main.ts: 0.1.0",
  ],
])(
  "checkVersions names the %s file that differs",
  (_name, versions, message) => {
    expect(() => checkVersions(repo(versions), "0.2.0")).toThrow(message);
  },
);

test("checkVersions rejects agreement on the wrong version", () => {
  const root = repo({
    pkg: "0.1.0",
    plugin: "0.1.0",
    market: "0.1.0",
    source: "0.1.0",
  });
  expect(() => checkVersions(root, "0.2.0")).toThrow("differ from 0.2.0");
});
