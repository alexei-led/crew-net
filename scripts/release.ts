#!/usr/bin/env bun
// Release helper. `check` and `notes` run in CI and locally; `prepare` bumps a
// version in every place that carries it. See docs/releasing.md.
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MAIN_SOURCE = "src/cli/main.ts";
const JSON_VERSION = /"version"\s*:\s*"[^"]*"/;
const JSON_VERSION_ALL = /("version"\s*:\s*")[^"]*(")/g;
const VERSION_CONST = /(export const VERSION = ")[^"]*(")/;

const JSON_FILES = [
  "package.json",
  "plugin/.claude-plugin/plugin.json",
  ".claude-plugin/marketplace.json",
];

export function parseVersion(arg: string | undefined): string {
  const version = (arg ?? "").replace(/^v/, "");
  if (!SEMVER.test(version)) {
    throw new Error(`version must be MAJOR.MINOR.PATCH, got "${arg ?? ""}"`);
  }
  return version;
}

/** The body of the `## X.Y.Z - date` section, or an error when it is missing, undated or empty. */
export function changelogSection(changelog: string, version: string): string {
  const lines = changelog.split("\n");
  const heading = lines.findIndex((l) => l.startsWith(`## ${version}`));
  if (heading < 0)
    throw new Error(`CHANGELOG.md has no "## ${version}" section`);
  const date = lines[heading]
    ?.slice(`## ${version}`.length)
    .replace(/^ - /, "");
  if (!date || !DATE.test(date.trim())) {
    throw new Error(
      `CHANGELOG.md heading must read "## ${version} - YYYY-MM-DD", got "${lines[heading]}"`,
    );
  }
  const rest = lines.slice(heading + 1);
  const end = rest.findIndex((l) => l.startsWith("## "));
  const body = (end < 0 ? rest : rest.slice(0, end)).join("\n").trim();
  if (body === "") throw new Error(`CHANGELOG.md section ${version} is empty`);
  return body;
}

type Json = {
  version?: string;
  plugins?: { name: string; version?: string }[];
};

/** Every place a version lives, so a mismatch names the file. */
export function versionsIn(root: string): Record<string, string | undefined> {
  const read = (p: string): Json =>
    JSON.parse(readFileSync(join(root, p), "utf8"));
  const [pkg, plugin, market] = JSON_FILES.map(read) as [Json, Json, Json];
  const source = readFileSync(join(root, MAIN_SOURCE), "utf8");
  return {
    "package.json": pkg.version,
    "plugin.json": plugin.version,
    "marketplace.json": market.plugins?.find((p) => p.name === "crew-net")
      ?.version,
    [MAIN_SOURCE]: /export const VERSION = "([^"]*)"/.exec(source)?.[1],
  };
}

export function checkVersions(root: string, expected?: string): string {
  const found = versionsIn(root);
  const values = new Set(Object.values(found));
  const target = expected ?? Object.values(found)[0];
  if (values.size !== 1 || !target || !values.has(target)) {
    const detail = Object.entries(found)
      .map(([file, v]) => `  ${file}: ${v ?? "missing"}`)
      .join("\n");
    throw new Error(
      `versions differ${expected ? ` from ${expected}` : ""}:\n${detail}`,
    );
  }
  return target;
}

export function setVersion(root: string, version: string): void {
  // Replace the field in place so the diff of a release commit is only the version.
  for (const file of JSON_FILES) {
    const path = join(root, file);
    const text = readFileSync(path, "utf8");
    if (!JSON_VERSION.test(text))
      throw new Error(`${file} has no "version" field`);
    writeFileSync(path, text.replace(JSON_VERSION_ALL, `$1${version}$2`));
  }
  const src = join(root, MAIN_SOURCE);
  writeFileSync(
    src,
    readFileSync(src, "utf8").replace(VERSION_CONST, `$1${version}$2`),
  );
}

/** Turns `## X.Y.Z (unreleased)` into `## X.Y.Z - date`; a new version gets a fresh section to fill. */
export function datedChangelog(
  changelog: string,
  version: string,
  today: string,
): string {
  const unreleased = new RegExp(
    `^## ${version.replaceAll(".", "\\.")} \\(unreleased\\)$`,
    "m",
  );
  if (unreleased.test(changelog)) {
    return changelog.replace(unreleased, `## ${version} - ${today}`);
  }
  if (changelog.includes(`## ${version} - `)) return changelog;
  throw new Error(
    `CHANGELOG.md has no "## ${version} (unreleased)" section: write the release notes first`,
  );
}

const git = (...args: string[]) =>
  execFileSync("git", args, { encoding: "utf8" }).trim();

function prepare(version: string): void {
  if (git("branch", "--show-current") !== "main")
    throw new Error("run prepare on main");
  if (git("status", "--porcelain") !== "")
    throw new Error("the working tree is not clean");
  git("fetch", "origin", "main");
  if (git("rev-parse", "HEAD") !== git("rev-parse", "origin/main")) {
    throw new Error("local main is not at origin/main: pull first");
  }
  const tag = `v${version}`;
  if (
    git("tag", "--list", tag) !== "" ||
    git("ls-remote", "--tags", "origin", tag) !== ""
  ) {
    throw new Error(`tag ${tag} already exists: tags are never moved`);
  }
  const changelogPath = "CHANGELOG.md";
  const today = new Date().toISOString().slice(0, 10);
  writeFileSync(
    changelogPath,
    datedChangelog(readFileSync(changelogPath, "utf8"), version, today),
  );
  setVersion(".", version);
  execFileSync("make", ["plugin"], { stdio: "inherit" });
  check(version);
  git("switch", "-c", `release/${tag}`);
  git(
    "add",
    "package.json",
    "plugin",
    ".claude-plugin",
    MAIN_SOURCE,
    changelogPath,
  );
  git("commit", "-m", `release ${version}`);
  console.log(
    [
      `Prepared release ${version} on branch release/${tag}. Next:`,
      `  1. make check && make plugin-test`,
      `  2. git push -u origin release/${tag} && gh pr create --fill`,
      `  3. merge the PR once CI is green`,
      `  4. git switch main && git pull --ff-only`,
      `  5. git tag -a ${tag} -m "crew-net ${version}" && git push origin ${tag}`,
      `The tag starts the Release workflow. See docs/releasing.md.`,
    ].join("\n"),
  );
}

function check(version: string): void {
  checkVersions(".", version);
  const bundled = execFileSync("node", ["plugin/bin/crew-net", "--version"], {
    encoding: "utf8",
  }).trim();
  if (bundled !== version) {
    throw new Error(
      `plugin/bin/crew-net reports ${bundled}, expected ${version}: run make plugin`,
    );
  }
  changelogSection(readFileSync("CHANGELOG.md", "utf8"), version);
  console.log(`release ${version}: versions, bundle and CHANGELOG agree`);
}

function main(argv: string[]): void {
  const [command, arg] = argv;
  switch (command) {
    case "check":
      check(parseVersion(arg));
      return;
    case "notes":
      console.log(
        changelogSection(
          readFileSync("CHANGELOG.md", "utf8"),
          parseVersion(arg),
        ),
      );
      return;
    case "prepare":
      prepare(parseVersion(arg));
      return;
    default:
      throw new Error(
        "usage: release.ts check|notes|prepare MAJOR.MINOR.PATCH",
      );
  }
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
