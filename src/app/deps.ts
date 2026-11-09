import type { RepoRef, StorePort } from "../ports/index";
import type { ItemEvent } from "../protocol/index";
import {
  cachedViewer,
  type DependencyStatus,
  type DepsFile,
  readDeps,
  readSnapshot,
  type Snapshot,
  writeDeps,
} from "./files";
import { putItem, resolveRef, sameLogin } from "./items";
import type { AppPorts } from "./ports";
import { repoSlug } from "./repo";

const label = (key: string, home: string): string =>
  key.startsWith(`${home.toLowerCase()}#`) ? key.slice(key.indexOf("#")) : key;

/** True while one of my PRs has an open dependency: the job then runs every minute. */
export async function anyBlocked(store: StorePort): Promise<boolean> {
  return Object.values((await readDeps(store)).prs).some((pr) => pr.blocked);
}

/**
 * The dependency job (design §11): read each dependency of my open PRs from
 * GitHub, and tell me when a PR is unblocked, a dependency closed unmerged,
 * or someone else's PR started waiting on mine. Auto-merge is turned off on
 * my PR while a dependency is open, or it would merge on the server where no
 * client gate can stop it. Items are written before deps state moves.
 */
export async function depsJob(
  ports: AppPorts,
  repos: readonly RepoRef[],
): Promise<void> {
  const { store, clock } = ports;
  const previous = await readDeps(store);
  const next: DepsFile = { prs: {}, announced: [] };
  const snapshots: { ref: RepoRef; snapshot: Snapshot; me: string }[] = [];
  for (const ref of repos) {
    const snapshot = await readSnapshot(store, ref);
    const me = await cachedViewer(store, ref.host);
    if (snapshot && me) snapshots.push({ ref, snapshot, me });
  }
  const put = (item: Omit<ItemEvent, "type" | "kind" | "addressed">) =>
    putItem(
      store,
      { type: "item", kind: "message", addressed: false, ...item },
      clock.now(),
    );

  const mine = new Set<string>();
  for (const { ref, snapshot, me } of snapshots) {
    const slug = repoSlug(ref);
    const github = ports.github(ref.host);
    for (const pr of snapshot.pulls) {
      if (!sameLogin(pr.author, me)) continue;
      const key = `${slug}#${pr.number}`;
      mine.add(key);
      const deps = pr.dependsOn.flatMap((d) => resolveRef(d, slug) ?? []);
      if (deps.length === 0) continue;
      const statuses: Record<string, DependencyStatus> = {};
      for (const dep of deps) {
        try {
          const read = await github.getPull(dep.repo, dep.number);
          statuses[dep.key] = read.merged
            ? "merged"
            : read.state === "open"
              ? "open"
              : "closed";
        } catch {
          // Unknown this pass; the gate reads it live and fails closed anyway.
        }
      }
      const before = previous.prs[key];
      const open = deps.filter((d) => statuses[d.key] === "open");
      const allKnown = deps.every((d) => statuses[d.key] !== undefined);
      const base = { repo: slug, thread: pr.number };
      if (pr.autoMerge && open.length > 0) {
        await github.disableAutoMerge(slug, pr.number);
        const names = open.map((d) => label(d.key, slug));
        await put({
          ...base,
          id: `automerge-off:${ref.host}/${key}:${open.map((d) => d.key).join(",")}`,
          text: `auto-merge turned off on #${pr.number}: it depends on open ${names.join(", ")}`,
          event: "auto-merge-off",
        });
      }
      for (const dep of deps) {
        if (
          statuses[dep.key] !== "closed" ||
          before?.deps[dep.key] === "closed"
        )
          continue;
        await put({
          ...base,
          id: `dep-closed:${ref.host}/${key}:${dep.key}`,
          text: `#${pr.number} depends on ${label(dep.key, slug)}, which was closed without merging`,
          event: "dependency-closed",
        });
      }
      const merged = deps.every((d) => statuses[d.key] === "merged");
      if (before?.blocked && allKnown && merged) {
        await put({
          ...base,
          id: `unblocked:${ref.host}/${key}:${deps.map((d) => d.key).join(",")}`,
          text: `#${pr.number} is unblocked: every dependency merged`,
          event: "unblocked",
        });
      }
      const kept: Record<string, DependencyStatus> = {
        ...(before?.deps ?? {}),
      };
      for (const dep of deps) {
        const status = statuses[dep.key];
        if (status) kept[dep.key] = status;
      }
      for (const known of Object.keys(kept)) {
        if (!deps.some((d) => d.key === known)) delete kept[known];
      }
      next.prs[key] = {
        deps: kept,
        blocked:
          !(allKnown && merged) && (open.length > 0 || !!before?.blocked),
      };
    }
  }

  for (const { ref, snapshot, me } of snapshots) {
    const slug = repoSlug(ref);
    for (const pr of snapshot.pulls) {
      if (sameLogin(pr.author, me)) continue;
      for (const dep of pr.dependsOn.flatMap(
        (d) => resolveRef(d, slug) ?? [],
      )) {
        if (!mine.has(dep.key)) continue;
        const id = `waits:${ref.host}/${slug}#${pr.number}:on:${dep.key}`;
        next.announced.push(id);
        if (previous.announced.includes(id)) continue;
        const [depRepo] = dep.key.split("#");
        await put({
          repo: depRepo ?? slug,
          thread: dep.number,
          id,
          from: pr.author,
          text: `${label(`${slug}#${pr.number}`, depRepo ?? slug)} (${pr.author}) waits on your ${label(dep.key, depRepo ?? slug)}`,
          event: "waits-on-you",
        });
      }
    }
  }
  await writeDeps(store, next);
}
