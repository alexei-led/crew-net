import {
  classify,
  DEFAULT_BOTS,
  type Finding,
  isBot,
  type LandedFacts,
  type MergeFacts,
  matchGlob,
  stale,
  type WorkFacts,
} from "../core/radar/index";
import type { GitPort, RepoRef, StorePort } from "../ports/index";
import {
  DEFAULT_REPO_CONFIG,
  parseRepoConfig,
  type RepoConfig,
} from "../protocol/index";
import {
  cachedViewer,
  type RadarWork,
  readRadar,
  readSnapshot,
  writeRadar,
} from "./files";
import { putItem, sameLogin } from "./items";
import type { AppPorts } from "./ports";
import { isRecord, repoKey, repoSlug, sameRepo } from "./repo";
import type { ActiveRepo } from "./scope";

/** Bare branches older than this are not someone's current work (design: Radar). */
export const BARE_BRANCH_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export const REPO_CONFIG_PATH = ".github/crew-net.yml";
const CONFIG_REFS = ["origin/HEAD", "origin/main", "origin/master"];

/**
 * `.github/crew-net.yml` from the default branch (GitHub's, when known, then
 * `origin/HEAD`, `main`, `master`); the defaults when absent or unreadable.
 */
export async function readRepoConfig(
  git: GitPort,
  defaultBranch?: string,
): Promise<{ config: RepoConfig; problem?: string }> {
  const refs = defaultBranch
    ? [`origin/${defaultBranch}`, ...CONFIG_REFS]
    : CONFIG_REFS;
  for (const ref of refs) {
    const text = await git
      .showFile(ref, REPO_CONFIG_PATH)
      .catch(() => undefined);
    if (text === undefined) continue;
    const parsed = parseRepoConfig(text);
    if (parsed.ok) return { config: parsed.config };
    return {
      config: DEFAULT_REPO_CONFIG,
      problem: `${REPO_CONFIG_PATH}${parsed.line ? `:${parsed.line}` : ""}: ${parsed.detail}`,
    };
  }
  return { config: DEFAULT_REPO_CONFIG };
}

const DEFAULT_BRANCH_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * The repo's default branch as GitHub names it, read once a day. When GitHub
 * cannot be read, the last known one; with none known the radar waits.
 */
export async function defaultBranchOf(
  ports: AppPorts,
  ref: RepoRef,
): Promise<string> {
  const { store, clock } = ports;
  const key = `default-branch:${repoKey(ref)}`;
  const cached = await store.kv.get(key);
  const known =
    isRecord(cached) && typeof cached.branch === "string"
      ? cached.branch
      : undefined;
  const nowMs = clock.now();
  if (
    known &&
    isRecord(cached) &&
    typeof cached.atMs === "number" &&
    nowMs - cached.atMs < DEFAULT_BRANCH_TTL_MS
  )
    return known;
  try {
    const branch = await ports.github(ref.host).defaultBranch(repoSlug(ref));
    await store.kv.set(key, { branch, atMs: nowMs });
    return branch;
  } catch (error) {
    if (known) return known;
    throw error;
  }
}

interface Work {
  facts: RadarWork;
  /** The git ref of the work's tip. */
  ref: string;
}

/** Squash merges end in `(#N)`; merge commits start with `Merge pull request #N`. */
export function prNumberOf(subject: string): number | undefined {
  const m =
    /\(#(\d+)\)\s*$/.exec(subject) ??
    /^Merge pull request #(\d+)/.exec(subject);
  return m ? Number(m[1]) : undefined;
}

const plural = (n: number, word: string): string =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

function pathsText(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).join(", ");
  return paths.length > 3 ? `${shown} +${paths.length - 3}` : shown;
}

/** One line for the band and the inbox. The digest renders findings itself. */
export function findingText(f: Finding): string {
  const here = sameRepo(f.other.repo, f.mine.repo) ? "" : f.other.repo;
  const other = f.other.pr ? `${here}#${f.other.pr}` : (f.other.branch ?? "");
  const theirs = `${f.other.owner} ${other}`.trim();
  const mine = f.mine.pr ? `#${f.mine.pr}` : (f.mine.branch ?? "your branch");
  switch (f.kind) {
    case "conflict":
      return `⚠ ${mine} conflicts with ${theirs}: ${pathsText(f.paths)}`;
    case "overlap":
      return `${mine} overlaps ${theirs}: ${plural(f.paths.length, "file")}`;
    case "order": {
      const [producer, consumer] =
        f.producer === "mine" ? [mine, theirs] : [theirs, mine];
      return `order: ${producer} changes ${f.contract ?? "a contract"}, ${consumer} uses it. Add depends-on?`;
    }
    case "stale":
      return `rebase ${mine}: ${theirs} touched ${pathsText(f.paths)}`;
  }
}

async function changed(
  git: GitPort,
  base: string,
  head: string,
): Promise<string[] | undefined> {
  // A ref that is gone (fork PR, pruned branch) drops that work item, not the pass.
  return git.changedFiles(base, head).catch(() => undefined);
}

/**
 * Fetch and radar for one active repo (design: Radar): my work items against
 * everyone else's open PRs and recent bare branches with the same base, and
 * against others' PRs in the watched repos (`repos`) this repo's contracts
 * name as consumers ("Radar"). New findings are written as inbox items before
 * radar.json, which is the record of what was already reported.
 */
export async function radarJob(
  ports: AppPorts,
  active: ActiveRepo,
  repos: readonly RepoRef[],
): Promise<void> {
  const { store, clock } = ports;
  const git = ports.git(active.dir);
  await git.fetch();
  const snapshot = await readSnapshot(store, active.ref);
  const me = await cachedViewer(store, active.ref.host);
  if (!snapshot || !me) return;
  const slug = repoSlug(active.ref);
  const defaultBase = await defaultBranchOf(ports, active.ref);
  const { config, problem } = await readRepoConfig(git, defaultBase);
  if (problem) {
    await store.events.append({
      type: "config-error",
      repo: slug,
      detail: problem,
      atMs: clock.now(),
    });
  }
  const remotes = await git.remoteBranches();
  const remoteNames = new Set(remotes.map((r) => r.name));
  const deploy = new Set(config.deployBranches);
  // Fork PRs have no branch on origin; a same-named origin branch is other work.
  const sameRepoPulls = snapshot.pulls.filter((p) => !p.fork);
  const byHead = new Map(sameRepoPulls.map((p) => [p.headRef, p]));
  const bots = [...DEFAULT_BOTS, ...config.bots];

  const mine: Work[] = [];
  const mineBranches = new Set<string>();
  const addMine = async (
    branch: string,
    ref: string,
    base: string,
    pr: number | undefined,
  ) => {
    const paths = await changed(git, `origin/${base}`, ref);
    if (!paths) return;
    mineBranches.add(branch);
    mine.push({
      ref,
      facts: {
        repo: slug,
        owner: me,
        branch,
        base,
        ...(pr !== undefined ? { pr } : {}),
        changedPaths: paths,
        mine: true,
      },
    });
  };
  for (const wt of await git.worktreeBranches()) {
    if (deploy.has(wt.branch) || wt.branch === defaultBase) continue;
    if (mineBranches.has(wt.branch)) continue;
    const pr = byHead.get(wt.branch);
    // Someone else's PR checked out here (to review it) is not my work.
    if (pr && !sameLogin(pr.author, me)) continue;
    await addMine(
      wt.branch,
      `refs/heads/${wt.branch}`,
      pr?.baseRef ?? defaultBase,
      pr?.number,
    );
  }
  for (const pr of sameRepoPulls) {
    if (!sameLogin(pr.author, me) || mineBranches.has(pr.headRef)) continue;
    if (!remoteNames.has(pr.headRef)) continue;
    await addMine(
      pr.headRef,
      `refs/remotes/origin/${pr.headRef}`,
      pr.baseRef,
      pr.number,
    );
  }

  const theirs: Work[] = [];
  for (const pr of sameRepoPulls) {
    if (sameLogin(pr.author, me) || isBot(pr.author, bots)) continue;
    if (!remoteNames.has(pr.headRef)) continue;
    const ref = `refs/remotes/origin/${pr.headRef}`;
    const paths = await changed(git, `origin/${pr.baseRef}`, ref);
    if (!paths) continue;
    theirs.push({
      ref,
      facts: {
        repo: slug,
        owner: pr.author,
        branch: pr.headRef,
        base: pr.baseRef,
        pr: pr.number,
        changedPaths: paths,
        mine: false,
      },
    });
  }
  const nowMs = clock.now();
  for (const branch of remotes) {
    if (byHead.has(branch.name) || deploy.has(branch.name)) continue;
    if (mineBranches.has(branch.name)) continue;
    if (branch.name === defaultBase) continue;
    const pushedAtMs = Date.parse(branch.lastCommitAt);
    if (!(nowMs - pushedAtMs <= BARE_BRANCH_MAX_AGE_MS)) continue;
    const ref = `refs/remotes/origin/${branch.name}`;
    // The branch's own last author: a merge of main into it names the merger.
    const author = await git
      .branchAuthor(`origin/${defaultBase}`, ref)
      .catch(() => undefined);
    const owner = author?.loginHint;
    if (!owner || sameLogin(owner, me) || isBot(owner, bots)) continue;
    const paths = await changed(git, `origin/${defaultBase}`, ref);
    if (!paths) continue;
    // Squash- or rebase-merged and not deleted: its changes are on the base already.
    // A git failure here keeps the branch, as a failed diff drops it: one item, not the pass.
    const merged = await git
      .sameContent(`origin/${defaultBase}`, ref, paths)
      .catch(() => false);
    if (merged) continue;
    theirs.push({
      ref,
      facts: {
        repo: slug,
        owner,
        branch: branch.name,
        base: defaultBase,
        changedPaths: paths,
        mine: false,
        pushedAtMs,
      },
    });
  }

  const consumers = await consumerWork(
    ports,
    active.ref,
    repos,
    config,
    me,
    mine.flatMap((m) => m.facts.changedPaths),
  );

  const radarConfig = { contracts: { [slug]: config.contracts }, bots };
  const findings = new Map<string, Finding>();
  const add = (list: Finding[]) => {
    for (const f of list) findings.set(f.key, f);
  };
  for (const m of mine) {
    for (const t of theirs) {
      if (m.facts.base !== t.facts.base) continue;
      add(
        classify(
          {
            mine: m.facts,
            theirs: t.facts,
            merge: await mergeFacts(git, m, t),
          },
          radarConfig,
        ),
      );
    }
    // Deploy branches are per repo: a pair across repos compares no bases.
    for (const t of consumers)
      add(
        classify(
          { mine: m.facts, theirs: t, merge: { clean: true } },
          radarConfig,
        ),
      );
    add(stale(m.facts, await landedOn(git, m.ref, m.facts), radarConfig));
  }

  await report(store, active, [...findings.values()], nowMs);
  await writeRadar(store, active.ref, {
    computedAtMs: nowMs,
    findings: [...findings.values()],
    work: [...mine, ...theirs].map((w) => w.facts),
  });
}

/**
 * Others' open PRs in the watched repos that this repo's contracts name as
 * consumers (`owner/repo:glob`, design: Radar), read only for contracts whose
 * producer paths I change. There is no clone of those repos here, so their
 * files come from GitHub; they are kept by head sha in kv
 * `pull-files:<host/o/r>` (open PRs only), so an unchanged PR is read once.
 * A PR whose files cannot be read is left out this pass and logged.
 */
async function consumerWork(
  ports: AppPorts,
  home: RepoRef,
  repos: readonly RepoRef[],
  config: RepoConfig,
  me: string,
  minePaths: readonly string[],
): Promise<WorkFacts[]> {
  const { store, clock } = ports;
  const named = new Set(
    config.contracts
      .filter((c) =>
        minePaths.some((p) => c.producer.some((g) => matchGlob(g, p))),
      )
      .flatMap((c) =>
        c.consumers.flatMap((x) => (x.repo ? [x.repo.toLowerCase()] : [])),
      ),
  );
  const bots = [...DEFAULT_BOTS, ...config.bots];
  const work: WorkFacts[] = [];
  for (const ref of repos) {
    const slug = repoSlug(ref);
    if (ref.host !== home.host || slug === repoSlug(home) || !named.has(slug))
      continue;
    const github = ports.github(ref.host);
    const key = `pull-files:${repoKey(ref)}`;
    const before = await store.kv.get(key);
    const known = isRecord(before) ? before : {};
    const next: Record<string, { sha: string; paths: string[] }> = {};
    for (const pr of (await readSnapshot(store, ref))?.pulls ?? []) {
      if (sameLogin(pr.author, me) || isBot(pr.author, bots)) continue;
      const seen = known[String(pr.number)];
      let paths =
        isRecord(seen) &&
        seen.sha === pr.headSha &&
        Array.isArray(seen.paths) &&
        seen.paths.every((p) => typeof p === "string")
          ? (seen.paths as string[])
          : undefined;
      if (!paths) {
        try {
          paths = await github.listPullFiles(slug, pr.number);
        } catch (error) {
          await store.events.append({
            type: "sync-error",
            job: `radar:${repoKey(home)}`,
            pr: `${slug}#${pr.number}`,
            message: error instanceof Error ? error.message : String(error),
            atMs: clock.now(),
          });
          continue;
        }
      }
      next[String(pr.number)] = { sha: pr.headSha, paths };
      work.push({
        repo: slug,
        owner: pr.author,
        branch: pr.headRef,
        base: pr.baseRef,
        pr: pr.number,
        changedPaths: paths,
      });
    }
    await store.kv.set(key, next);
  }
  return work;
}

/** A conflict needs a file both sides change, so merge-tree runs only then. */
async function mergeFacts(git: GitPort, m: Work, t: Work): Promise<MergeFacts> {
  const theirPaths = new Set(t.facts.changedPaths);
  if (!m.facts.changedPaths.some((p) => theirPaths.has(p)))
    return { clean: true };
  const result = await git.mergeTree(m.ref, t.ref).catch(() => undefined);
  if (!result || result.clean) return { clean: true };
  return { clean: false, paths: result.conflictedPaths };
}

/** PRs merged to my base after my merge base, from first-parent history. */
async function landedOn(
  git: GitPort,
  ref: string,
  mine: WorkFacts,
): Promise<LandedFacts[]> {
  const base = `origin/${mine.base}`;
  const forkPoint = await git.mergeBase(ref, base).catch(() => undefined);
  if (!forkPoint) return [];
  const commits = await git.landed(forkPoint, base).catch(() => []);
  return commits.flatMap((c) => {
    const number = prNumberOf(c.subject);
    if (number === undefined) return [];
    return [
      {
        repo: mine.repo,
        // Never an email in findings; a merge commit names whoever merged.
        // Unknown stays empty: the text then names only the PR.
        owner: c.loginHint ?? "",
        number,
        base: mine.base,
        changedPaths: c.paths,
      },
    ];
  });
}

async function report(
  store: StorePort,
  active: ActiveRepo,
  findings: Finding[],
  nowMs: number,
): Promise<void> {
  const known = new Set(
    (await readRadar(store, active.ref))?.findings.map((f) => f.key) ?? [],
  );
  for (const f of findings) {
    if (known.has(f.key)) continue;
    const fresh = await putItem(
      store,
      {
        type: "item",
        id: `finding:${f.key}`,
        kind: "finding",
        text: findingText(f),
        addressed: false,
        from: f.other.owner,
        repo: f.mine.repo,
        ...(f.mine.pr !== undefined ? { thread: f.mine.pr } : {}),
        event: f.kind,
      },
      nowMs,
    );
    if (fresh) {
      await store.events.append({
        type: "finding",
        kind: f.kind,
        repo: f.mine.repo,
        key: f.key,
        ...(f.mine.pr !== undefined ? { pr: f.mine.pr } : {}),
        ...(f.other.pr !== undefined ? { otherPr: f.other.pr } : {}),
        atMs: nowMs,
      });
    }
  }
}
