/** One side of a branch pair. */
export interface BranchFacts {
  /** GitHub login of the author. */
  developer: string;
  branch: string;
  /** Open PR number, if the branch has one. */
  pr?: number;
  changedPaths: string[];
}

/** Result of `git merge-tree --write-tree`. */
export type MergeFacts = { clean: true } | { clean: false; paths: string[] };

/** The lead's branch compared with another developer's open PR branch. */
export interface PairFacts {
  mine: BranchFacts;
  theirs: BranchFacts;
  merge: MergeFacts;
}

export interface RadarConfig {
  /** Globs for paths whose change by another PR needs an order decision. */
  contractPaths: string[];
  /** Logins whose PRs are ignored. */
  bots: string[];
}

export const DEFAULT_CONTRACT_PATHS = [
  "api/openapi/**",
  "**/*migration*",
  ".github/workflows/**",
];
export const DEFAULT_BOTS = ["renovate", "dependabot", "github-actions"];

export const DEFAULT_RADAR_CONFIG: RadarConfig = {
  contractPaths: DEFAULT_CONTRACT_PATHS,
  bots: DEFAULT_BOTS,
};

export type FindingKind = "conflict" | "overlap" | "contract-path";

export interface Finding {
  kind: FindingKind;
  /** The other developer's branch. */
  other: { developer: string; branch: string; pr?: number };
  paths: string[];
  /** The lead should judge order now; a wake candidate. */
  blocking: boolean;
}

const normalizeLogin = (login: string): string =>
  login
    .toLowerCase()
    .replace(/^app\//, "")
    .replace(/\[bot\]$/, "");

/** Bot logins match with or without `[bot]` or `app/`, case-insensitively. */
export function isBot(login: string, bots: readonly string[]): boolean {
  const name = normalizeLogin(login);
  return bots.some((b) => normalizeLogin(b) === name);
}

const escapeRegex = (s: string): string =>
  s.replace(/[.+^${}()|[\]\\?]/g, "\\$&");

/**
 * Compile a glob. `**` crosses `/`, `**` followed by `/` also matches zero
 * directories, `*` stays inside one path segment. Nothing else is special.
 */
function globToRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob.charAt(i);
    if (c === "*" && glob.charAt(i + 1) === "*") {
      if (glob.charAt(i + 2) === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (c === "*") {
      out += "[^/]*";
    } else {
      out += escapeRegex(c);
    }
  }
  return new RegExp(`^${out}$`);
}

/** A path also matches when the glob matches one of its parent directories, as in `.gitignore`. */
function matchesRegex(re: RegExp, path: string): boolean {
  const parts = path.split("/");
  return parts.some((_, i) => re.test(parts.slice(0, i + 1).join("/")));
}

export function matchGlob(glob: string, path: string): boolean {
  return matchesRegex(globToRegex(glob), path);
}

/** Classify one branch pair. Bot authors and same-developer pairs give nothing. */
export function classify(
  pair: PairFacts,
  config: Partial<RadarConfig> = {},
): Finding[] {
  const { contractPaths, bots } = { ...DEFAULT_RADAR_CONFIG, ...config };
  const { mine, theirs, merge } = pair;
  if (isBot(mine.developer, bots) || isBot(theirs.developer, bots)) return [];
  if (normalizeLogin(mine.developer) === normalizeLogin(theirs.developer))
    return [];

  const other = {
    developer: theirs.developer,
    branch: theirs.branch,
    ...(theirs.pr === undefined ? {} : { pr: theirs.pr }),
  };
  const findings: Finding[] = [];

  if (!merge.clean) {
    findings.push({
      kind: "conflict",
      other,
      paths: merge.paths,
      blocking: true,
    });
  }

  const mineSet = new Set(mine.changedPaths);
  const shared = theirs.changedPaths.filter((p) => mineSet.has(p));
  if (shared.length > 0) {
    findings.push({ kind: "overlap", other, paths: shared, blocking: false });
  }

  const matchers = contractPaths.map(globToRegex);
  const contract = theirs.changedPaths.filter((p) =>
    matchers.some((m) => matchesRegex(m, p)),
  );
  if (contract.length > 0) {
    findings.push({
      kind: "contract-path",
      other,
      paths: contract,
      blocking: true,
    });
  }
  return findings;
}
