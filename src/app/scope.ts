import type { RepoRef, SessionRecord } from "../ports/index";
import { readWatched, touchWatched } from "./files";
import type { AppPorts } from "./ports";
import { refFromKey, refFromSlug, repoKey, repoSlug } from "./repo";

/** A repo with a live session on this laptop: polled every minute, fetched for the radar. */
export interface ActiveRepo {
  ref: RepoRef;
  /** A working copy of the repo, for git. */
  dir: string;
  sessions: SessionRecord[];
}

export interface SyncScope {
  active: ActiveRepo[];
  /** Watched repos without a live session: polled every 15 minutes, never fetched. */
  watched: RepoRef[];
  hosts: string[];
}

/**
 * The repo a CLI command is about. With a working copy (`dir`) it is active
 * for that run even without a session; without one (`--repo` elsewhere) it
 * is watched.
 */
export interface Here {
  ref: RepoRef;
  dir?: string;
}

/**
 * Which repos this sync pass covers (design §6, §8.2). Active: a live
 * session's repo, plus the command's own. Watched: a session in the last 14
 * days, plus `watch` from config.json. Muted repos are left out.
 */
export async function syncScope(
  ports: AppPorts,
  here?: Here,
): Promise<SyncScope> {
  const { store, clock, settings } = ports;
  const muted = new Set(settings.mute);
  const isMuted = (ref: RepoRef) => muted.has(repoSlug(ref));
  const byKey = new Map<string, ActiveRepo>();
  const live = (await store.sessions.live()).sort(
    (a, b) =>
      Number(b.role === "lead") - Number(a.role === "lead") ||
      b.seenAtMs - a.seenAtMs,
  );
  for (const session of live) {
    const ref = session.repo ? refFromKey(session.repo) : undefined;
    if (!ref || isMuted(ref)) continue;
    const key = repoKey(ref);
    const repo = byKey.get(key);
    if (repo) repo.sessions.push(session);
    else byKey.set(key, { ref, dir: session.worktree, sessions: [session] });
  }
  if (here?.dir && !isMuted(here.ref) && !byKey.has(repoKey(here.ref))) {
    byKey.set(repoKey(here.ref), {
      ref: here.ref,
      dir: here.dir,
      sessions: [],
    });
  }
  const active = [...byKey.values()];
  await touchWatched(store, [...byKey.keys()], clock.now());

  const host = here?.ref.host ?? active[0]?.ref.host ?? "github.com";
  const watchedKeys = new Set(Object.keys(await readWatched(store)));
  if (here && !here.dir) watchedKeys.add(repoKey(here.ref));
  for (const slug of settings.watch) {
    const ref = refFromSlug(host, slug);
    if (ref) watchedKeys.add(repoKey(ref));
  }
  const watched: RepoRef[] = [];
  for (const key of watchedKeys) {
    const ref = refFromKey(key);
    if (!ref || byKey.has(key) || isMuted(ref)) continue;
    watched.push(ref);
  }
  const hosts = [
    ...new Set([...active.map((a) => a.ref), ...watched].map((r) => r.host)),
  ];
  return { active, watched, hosts };
}
