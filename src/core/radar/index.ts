/** A work item: an open PR, or a pushed branch without one. */
export interface WorkFacts {
  /** `owner/repo`. */
  repo: string;
  /** PR author; for a bare branch, the login of its last commit. */
  owner: string;
  branch: string;
  /** Base branch the work targets. */
  base: string;
  /** Open PR number; absent for a bare branch. */
  pr?: number;
  /** Paths changed against the merge base. */
  changedPaths: string[];
}

/** Result of `git merge-tree --write-tree mine theirs`. */
export type MergeFacts = { clean: true } | { clean: false; paths: string[] };

/** My work item and someone else's. `merge` is only read for same-repo pairs. */
export interface PairFacts {
  mine: WorkFacts;
  theirs: WorkFacts;
  merge: MergeFacts;
}

/** A PR merged to `base` after the merge base of my branch (from `git log <merge-base>..origin/<base>`). */
export interface LandedFacts {
  repo: string;
  owner: string;
  number: number;
  base: string;
  changedPaths: string[];
}

/**
 * Paths whose change must merge before the paths that use it (design §10.1).
 * A consumer glob may name another repo as `owner/repo:glob`.
 */
export interface Contract {
  name: string;
  producer: string[];
  consumers: string[];
}

export interface RadarConfig {
  /** Contracts by declaring repo (`owner/repo`). A repo missing here uses `DEFAULT_CONTRACTS`. */
  contracts: Readonly<Record<string, readonly Contract[]>>;
  /** Logins whose work is ignored, in addition to `DEFAULT_BOTS`. */
  bots: string[];
}

export const DEFAULT_BOTS = ["renovate", "dependabot", "github-actions"];

/** Without a repo config: these producers, and any other path in the same repo consumes them. */
export const DEFAULT_CONTRACTS: readonly Contract[] = [
  {
    name: "default",
    producer: [
      "**/migrations/**",
      "**/*migration*",
      "api/openapi/**",
      "**/*.proto",
    ],
    consumers: ["**"],
  },
];

export const DEFAULT_RADAR_CONFIG: RadarConfig = {
  contracts: {},
  bots: [],
};

export type FindingKind = "conflict" | "overlap" | "order" | "stale";

/** A work item named in a finding. */
export interface WorkRef {
  repo: string;
  owner: string;
  branch?: string;
  pr?: number;
}

export interface Finding {
  kind: FindingKind;
  mine: WorkRef;
  other: WorkRef;
  /** Sorted, unique. */
  paths: string[];
  /** `order` only: the contract and which side produces it. */
  contract?: string;
  producer?: "mine" | "other";
  /** Report a finding once; again only when this key changes. */
  key: string;
  /** Findings go to the band and the next prompt, never to a wake turn. */
  mayWake: false;
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

const sameRepo = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

const escapeRegex = (s: string): string =>
  s.replace(/[.+^${}()|[\]\\?]/g, "\\$&");

/**
 * `**` crosses `/`, `**` followed by `/` also matches zero directories, `*`
 * stays inside one segment, `?` is one character other than `/`. Nothing else
 * is special.
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
    } else if (c === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(c);
    }
  }
  return new RegExp(`^${out}$`);
}

type Matcher = (path: string) => boolean;

/**
 * Compile a glob with `.gitignore` placement rules:
 * - a trailing `/` matches only a directory, so everything below it;
 * - a leading or middle `/` anchors at the repo root, else it matches at any depth;
 * - a glob that matches a directory matches everything below it.
 */
function compileGlob(glob: string): Matcher {
  const dirOnly = glob.endsWith("/");
  let body = glob.replace(/\/+$/, "");
  const anchored = body.includes("/");
  body = body.replace(/^\/+/, "");
  if (body === "") return () => false;
  const re = globToRegex(anchored ? body : `**/${body}`);
  return (path) => {
    const parts = path.split("/");
    const last = dirOnly ? parts.length - 1 : parts.length;
    for (let i = 1; i <= last; i++) {
      if (re.test(parts.slice(0, i).join("/"))) return true;
    }
    return false;
  };
}

export function matchGlob(glob: string, path: string): boolean {
  return compileGlob(glob)(path);
}

function matchesAny(globs: readonly string[]): Matcher {
  const matchers = globs.map(compileGlob);
  return (path) => matchers.some((m) => m(path));
}

const sortedUnique = (paths: Iterable<string>): string[] =>
  [...new Set(paths)].sort();

const refOf = (w: WorkFacts): WorkRef => ({
  repo: w.repo,
  owner: w.owner,
  branch: w.branch,
  ...(w.pr === undefined ? {} : { pr: w.pr }),
});

const refKey = (r: WorkRef): string =>
  r.pr === undefined
    ? `${r.repo.toLowerCase()}:${r.branch ?? ""}`
    : `${r.repo.toLowerCase()}#${r.pr}`;

function finding(
  kind: FindingKind,
  mine: WorkRef,
  other: WorkRef,
  paths: Iterable<string>,
  order?: { contract: string; producer: "mine" | "other" },
): Finding {
  const sorted = sortedUnique(paths);
  const tag = order ? `${order.contract}>${order.producer}` : "";
  return {
    kind,
    mine,
    other,
    paths: sorted,
    ...order,
    key: [kind, tag, refKey(mine), refKey(other), sorted.join(",")].join("|"),
    mayWake: false,
  };
}

const contractsOf = (
  config: RadarConfig,
  repo: string,
): readonly Contract[] => {
  const entry = Object.entries(config.contracts).find(([r]) =>
    sameRepo(r, repo),
  );
  return entry ? entry[1] : DEFAULT_CONTRACTS;
};

const CROSS_REPO = /^([\w.-]+\/[\w.-]+):(.+)$/;

/** Paths of `consumer` that use a contract declared in `declaring`. Producer paths are not consumers. */
function consumerPaths(
  contract: Contract,
  declaring: string,
  consumer: WorkFacts,
): string[] {
  const local = sameRepo(consumer.repo, declaring);
  const globs = contract.consumers.flatMap((glob) => {
    const cross = CROSS_REPO.exec(glob);
    if (!cross) return local ? [glob] : [];
    return sameRepo(cross[1] ?? "", consumer.repo) ? [cross[2] ?? ""] : [];
  });
  if (globs.length === 0) return [];
  const uses = matchesAny(globs);
  const produces = local ? matchesAny(contract.producer) : () => false;
  return consumer.changedPaths.filter((p) => uses(p) && !produces(p));
}

function orderFindings(
  mine: WorkFacts,
  theirs: WorkFacts,
  config: RadarConfig,
): Finding[] {
  const out: Finding[] = [];
  const sides = [
    { producer: mine, consumer: theirs, side: "mine" as const },
    { producer: theirs, consumer: mine, side: "other" as const },
  ];
  for (const { producer, consumer, side } of sides) {
    for (const contract of contractsOf(config, producer.repo)) {
      const produced = producer.changedPaths.filter(
        matchesAny(contract.producer),
      );
      if (produced.length === 0) continue;
      const used = consumerPaths(contract, producer.repo, consumer);
      if (used.length === 0) continue;
      out.push(
        finding("order", refOf(mine), refOf(theirs), [...produced, ...used], {
          contract: contract.name,
          producer: side,
        }),
      );
    }
  }
  return out;
}

/** Configured bots add to `DEFAULT_BOTS`; contracts default to none declared. */
const resolve = (config: Partial<RadarConfig>): RadarConfig => ({
  contracts: config.contracts ?? DEFAULT_RADAR_CONFIG.contracts,
  bots: [...DEFAULT_BOTS, ...(config.bots ?? [])],
});

/**
 * Classify my work item against someone else's.
 * - Same repo, same base: `conflict` (merge-tree paths), `overlap` (files both
 *   change that do not conflict), `order`.
 * - Different repos: `order` only, through `owner/repo:` consumer globs.
 * - Same repo, different base, same owner, or a bot on either side: nothing.
 */
export function classify(
  pair: PairFacts,
  config: Partial<RadarConfig> = {},
): Finding[] {
  const resolved = resolve(config);
  const { mine, theirs, merge } = pair;
  if (isBot(mine.owner, resolved.bots) || isBot(theirs.owner, resolved.bots))
    return [];
  if (normalizeLogin(mine.owner) === normalizeLogin(theirs.owner)) return [];
  if (!sameRepo(mine.repo, theirs.repo))
    return orderFindings(mine, theirs, resolved);
  if (mine.base !== theirs.base) return [];

  const findings: Finding[] = [];
  const conflicted = new Set(merge.clean ? [] : merge.paths);
  if (conflicted.size > 0) {
    findings.push(finding("conflict", refOf(mine), refOf(theirs), conflicted));
  }
  const theirSet = new Set(theirs.changedPaths);
  const shared = mine.changedPaths.filter(
    (p) => theirSet.has(p) && !conflicted.has(p),
  );
  if (shared.length > 0) {
    findings.push(finding("overlap", refOf(mine), refOf(theirs), shared));
  }
  return [...findings, ...orderFindings(mine, theirs, resolved)];
}

/**
 * `stale` findings: PRs merged to my base after my merge base that touch files
 * I change. `landed` is what the caller read from git; this keeps those in my
 * repo and base, by any author except bots.
 */
export function stale(
  mine: WorkFacts,
  landed: readonly LandedFacts[],
  config: Partial<RadarConfig> = {},
): Finding[] {
  const { bots } = resolve(config);
  const myPaths = new Set(mine.changedPaths);
  return landed.flatMap((pr) => {
    if (!sameRepo(pr.repo, mine.repo) || pr.base !== mine.base) return [];
    if (isBot(pr.owner, bots)) return [];
    const touched = pr.changedPaths.filter((p) => myPaths.has(p));
    if (touched.length === 0) return [];
    const other: WorkRef = { repo: pr.repo, owner: pr.owner, pr: pr.number };
    return [finding("stale", refOf(mine), other, touched)];
  });
}
