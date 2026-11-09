import type { Finding, WorkFacts } from "../core/radar/index";
import type {
  JsonValue,
  PullRequest,
  RepoRef,
  StorePort,
} from "../ports/index";
import { parseStateBlock } from "../protocol/index";
import { isRecord, toJson } from "./repo";

/** One open PR as sync last saw it (`repos/<host>/<owner>/<repo>/snapshot.json`). */
export interface SnapshotPull {
  number: number;
  author: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  draft: boolean;
  autoMerge: boolean;
  updatedAt: string;
  /** `state` of the state block, if the PR has one. */
  state?: string;
  scope: string[];
  /** Raw `depends-on` entries: `#N` or `owner/repo#N`. */
  dependsOn: string[];
}

export interface Snapshot {
  fetchedAtMs: number;
  pulls: SnapshotPull[];
}

/** A work item the radar compared, kept for `who` and the digest. */
export interface RadarWork extends WorkFacts {
  mine: boolean;
  /** Last push of a bare branch. */
  pushedAtMs?: number;
}

/** `repos/<host>/<owner>/<repo>/radar.json`. */
export interface RadarFile {
  computedAtMs: number;
  findings: Finding[];
  work: RadarWork[];
}

export type DependencyStatus = "open" | "merged" | "closed";

/** What the dependency job last saw for one of my PRs, keyed `owner/repo#N`. */
export interface TrackedPr {
  deps: Record<string, DependencyStatus>;
  blocked: boolean;
}

export interface DepsFile {
  prs: Record<string, TrackedPr>;
  /** `waits-on-you` items already announced, so a prune never repeats one. */
  announced: string[];
}

export function snapshotPull(pull: PullRequest): SnapshotPull {
  const parsed = parseStateBlock(pull.body);
  const block = parsed?.ok ? parsed.state : undefined;
  return {
    number: pull.number,
    author: pull.author,
    headRef: pull.headRef,
    headSha: pull.headSha,
    baseRef: pull.baseRef,
    draft: pull.draft,
    autoMerge: pull.autoMerge,
    updatedAt: pull.updatedAt,
    ...(block?.state ? { state: block.state } : {}),
    scope: block?.scope ?? [],
    dependsOn: block?.dependsOn ?? [],
  };
}

const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((v) => typeof v === "string");

function isSnapshotPull(value: unknown): value is SnapshotPull {
  return (
    isRecord(value) &&
    Number.isInteger(value.number) &&
    typeof value.author === "string" &&
    typeof value.headRef === "string" &&
    typeof value.headSha === "string" &&
    typeof value.baseRef === "string" &&
    typeof value.draft === "boolean" &&
    typeof value.autoMerge === "boolean" &&
    typeof value.updatedAt === "string" &&
    strings(value.scope) &&
    strings(value.dependsOn)
  );
}

/** A snapshot is a cache: one that does not parse is treated as absent and rewritten. */
export async function readSnapshot(
  store: StorePort,
  ref: RepoRef,
): Promise<Snapshot | undefined> {
  const value = await store.repos.read(ref, "snapshot");
  if (
    !isRecord(value) ||
    typeof value.fetchedAtMs !== "number" ||
    !Array.isArray(value.pulls) ||
    !value.pulls.every(isSnapshotPull)
  )
    return undefined;
  return {
    fetchedAtMs: value.fetchedAtMs,
    pulls: value.pulls as unknown as SnapshotPull[],
  };
}

export const writeSnapshot = (
  store: StorePort,
  ref: RepoRef,
  snapshot: Snapshot,
): Promise<void> => store.repos.write(ref, "snapshot", toJson(snapshot));

export async function readRadar(
  store: StorePort,
  ref: RepoRef,
): Promise<RadarFile | undefined> {
  const value = await store.repos.read(ref, "radar");
  if (
    !isRecord(value) ||
    typeof value.computedAtMs !== "number" ||
    !Array.isArray(value.findings) ||
    !Array.isArray(value.work) ||
    !value.findings.every(isRecord) ||
    !value.work.every(isRecord)
  )
    return undefined;
  return value as unknown as RadarFile;
}

export const writeRadar = (
  store: StorePort,
  ref: RepoRef,
  radar: RadarFile,
): Promise<void> => store.repos.write(ref, "radar", toJson(radar));

const DEPS_KEY = "deps:state";

export async function readDeps(store: StorePort): Promise<DepsFile> {
  const value = await store.kv.get(DEPS_KEY);
  if (!isRecord(value) || !isRecord(value.prs))
    return { prs: {}, announced: [] };
  return {
    prs: value.prs as unknown as Record<string, TrackedPr>,
    announced: strings(value.announced) ? value.announced : [],
  };
}

export const writeDeps = (store: StorePort, deps: DepsFile): Promise<void> =>
  store.kv.set(DEPS_KEY, toJson(deps));

const WATCHED_KEY = "watched";

/** Repos with a session in the last 14 days, `host/owner/name` → last seen. */
export async function readWatched(
  store: StorePort,
): Promise<Record<string, number>> {
  const value = await store.kv.get(WATCHED_KEY);
  if (!isRecord(value)) return {};
  const watched: Record<string, number> = {};
  for (const [key, seen] of Object.entries(value)) {
    if (typeof seen === "number") watched[key] = seen;
  }
  return watched;
}

export const WATCH_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

/** Record that a session ran in these repos; drop repos not seen for 14 days. */
export async function touchWatched(
  store: StorePort,
  keys: readonly string[],
  nowMs: number,
): Promise<void> {
  await store.kv.update(WATCHED_KEY, (current) => {
    const next: Record<string, JsonValue> = {};
    if (isRecord(current)) {
      for (const [key, seen] of Object.entries(current)) {
        if (typeof seen === "number" && nowMs - seen < WATCH_DAYS_MS)
          next[key] = seen;
      }
    }
    for (const key of keys) next[key] = nowMs;
    return next;
  });
}

const VIEWER_TTL_MS = 60 * 60 * 1000;

/** My login on `host`, as the last sync read it. Never calls GitHub. */
export async function cachedViewer(
  store: StorePort,
  host: string,
): Promise<string | undefined> {
  const value = await store.kv.get(`viewer:${host}`);
  return isRecord(value) && typeof value.login === "string"
    ? value.login
    : undefined;
}

/** My login on `host`: cached for an hour, then read again so a token swap shows. */
export async function viewerOf(
  store: StorePort,
  github: { viewer(): Promise<string> },
  host: string,
  nowMs: number,
): Promise<string> {
  const value = await store.kv.get(`viewer:${host}`);
  if (
    isRecord(value) &&
    typeof value.login === "string" &&
    typeof value.atMs === "number" &&
    nowMs - value.atMs < VIEWER_TTL_MS
  )
    return value.login;
  const login = await github.viewer();
  await store.kv.set(`viewer:${host}`, { login, atMs: nowMs });
  return login;
}
