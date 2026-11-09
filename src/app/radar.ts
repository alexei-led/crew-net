import {
  classify,
  type Finding,
  isBot,
  type LandedFacts,
  type MergeFacts,
  stale,
  type WorkFacts,
} from "../core/radar/index";
import type { GitPort, StorePort } from "../ports/index";
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
import { repoSlug } from "./repo";
import type { ActiveRepo } from "./scope";

/** Bare branches older than this are not someone's current work (design §10). */
export const BARE_BRANCH_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export const REPO_CONFIG_PATH = ".github/crew-net.yml";
const CONFIG_REFS = ["origin/HEAD", "origin/main", "origin/master"];

/** `.github/crew-net.yml` from the default branch; the defaults when absent or unreadable. */
export async function readRepoConfig(
  git: GitPort,
): Promise<{ config: RepoConfig; problem?: string }> {
  for (const ref of CONFIG_REFS) {
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
  const other = f.other.pr ? `#${f.other.pr}` : (f.other.branch ?? "");
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
 * Fetch and radar for one active repo (design §10): my work items against
 * everyone else's open PRs and recent bare branches with the same base. New
 * findings are written as inbox items before radar.json, which is the
 * record of what was already reported.
 */
export async function radarJob(
  ports: AppPorts,
  active: ActiveRepo,
): Promise<void> {
  const { store, clock } = ports;
  const git = ports.git(active.dir);
  await git.fetch();
  const snapshot = await readSnapshot(store, active.ref);
  const me = await cachedViewer(store, active.ref.host);
  if (!snapshot || !me) return;
  const slug = repoSlug(active.ref);
  const { config, problem } = await readRepoConfig(git);
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
  const defaultBase =
    config.deployBranches.find((b) => remoteNames.has(b)) ?? "main";
  // Fork PRs have no branch on origin; a same-named origin branch is other work.
  const sameRepoPulls = snapshot.pulls.filter((p) => !p.fork);
  const byHead = new Map(sameRepoPulls.map((p) => [p.headRef, p]));
  const bots = config.bots;

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
    const owner = branch.loginHint;
    if (!owner || sameLogin(owner, me) || isBot(owner, bots)) continue;
    if (byHead.has(branch.name) || deploy.has(branch.name)) continue;
    if (mineBranches.has(branch.name)) continue;
    if (branch.name === defaultBase) continue;
    const pushedAtMs = Date.parse(branch.lastCommitAt);
    if (!(nowMs - pushedAtMs <= BARE_BRANCH_MAX_AGE_MS)) continue;
    const ref = `refs/remotes/origin/${branch.name}`;
    const paths = await changed(git, `origin/${defaultBase}`, ref);
    if (!paths) continue;
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
    add(stale(m.facts, await landedOn(git, m.ref, m.facts), radarConfig));
  }

  await report(store, active, [...findings.values()], nowMs);
  await writeRadar(store, active.ref, {
    computedAtMs: nowMs,
    findings: [...findings.values()],
    work: [...mine, ...theirs].map((w) => w.facts),
  });
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
        owner: c.loginHint ?? "someone",
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
