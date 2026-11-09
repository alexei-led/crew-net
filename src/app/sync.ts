import type { JobOutcome, JsonObject } from "../ports/index";
import { anyBlocked, depsJob } from "./deps";
import { inboxJob, pollIntervalKey } from "./inbox";
import type { AppPorts } from "./ports";
import { radarJob } from "./radar";
import { repoKey } from "./repo";
import { type Here, syncScope } from "./scope";
import { snapshotJob } from "./snapshot";

/** Job intervals of design §8.2, in milliseconds. */
export const INTERVALS = {
  inbox: 60_000,
  repoActive: 60_000,
  repoWatched: 15 * 60_000,
  radar: 5 * 60_000,
  deps: 5 * 60_000,
  depsBlocked: 60_000,
} as const;

export interface JobReport {
  job: string;
  outcome: JobOutcome | "failed";
  error?: string;
}

export interface SyncReport {
  jobs: JobReport[];
  /** A line for the band and the digest: rate limit or broken auth. */
  notice?: string;
}

export const SYNC_STATUS_KEY = "sync:status";

const HHMM = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);

function notice(error: unknown, nowMs: number): string | undefined {
  if (!(error instanceof Error)) return undefined;
  if (error.name === "RateLimitError") {
    const wait = (error as Error & { retryAfterMs?: number }).retryAfterMs;
    return typeof wait === "number"
      ? `crew-net: rate-limited until ${HHMM(nowMs + wait)}`
      : "crew-net: rate-limited";
  }
  if (error.name === "AuthError" || error.name === "SsoError")
    return `crew-net: ${error.message}`;
  return undefined;
}

/**
 * One sync pass (design §8.2): every job that is due, each under its own
 * lock. A job that ran within its interval on this laptop, from any process,
 * is `fresh`; one another process runs is `busy`. A failing job is logged
 * and the rest still run; on a 401 or SSO error the host's other GitHub
 * jobs are skipped.
 */
export async function runSync(
  ports: AppPorts,
  here?: Here,
): Promise<SyncReport> {
  const { store, clock } = ports;
  const scope = await syncScope(ports, here);
  const jobs: JobReport[] = [];
  const brokenHosts = new Set<string>();
  let lastNotice: string | undefined;

  const run = async (
    job: string,
    host: string | undefined,
    intervalMs: number,
    fn: () => Promise<void>,
  ) => {
    if (host && brokenHosts.has(host)) {
      jobs.push({ job, outcome: "failed", error: "skipped: GitHub auth" });
      return;
    }
    try {
      jobs.push({ job, outcome: await store.jobs.run(job, intervalMs, fn) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      jobs.push({ job, outcome: "failed", error: message });
      const name = error instanceof Error ? error.name : "";
      if (host && (name === "AuthError" || name === "SsoError"))
        brokenHosts.add(host);
      lastNotice = notice(error, clock.now()) ?? lastNotice;
      await store.events.append({
        type: "sync-error",
        job,
        message,
        atMs: clock.now(),
      });
    }
  };

  for (const host of scope.hosts) {
    const polled = await store.kv.get(pollIntervalKey(host));
    const interval = Math.max(
      INTERVALS.inbox,
      typeof polled === "number" ? polled : 0,
    );
    await run(`inbox:${host}`, host, interval, () => inboxJob(ports, host));
  }
  for (const active of scope.active) {
    await run(
      `repo:${repoKey(active.ref)}`,
      active.ref.host,
      INTERVALS.repoActive,
      () => snapshotJob(ports, active.ref),
    );
  }
  for (const ref of scope.watched) {
    await run(`repo:${repoKey(ref)}`, ref.host, INTERVALS.repoWatched, () =>
      snapshotJob(ports, ref),
    );
  }
  const repos = [...scope.active.map((a) => a.ref), ...scope.watched];
  for (const active of scope.active) {
    await run(`radar:${repoKey(active.ref)}`, undefined, INTERVALS.radar, () =>
      radarJob(ports, active, repos),
    );
  }
  const depsInterval = (await anyBlocked(store))
    ? INTERVALS.depsBlocked
    : INTERVALS.deps;
  await run("deps", undefined, depsInterval, () => depsJob(ports, repos));

  const failed = jobs.filter((j) => j.outcome === "failed");
  const status: JsonObject = {
    atMs: clock.now(),
    failed: failed.map((j) => ({ job: j.job, error: j.error ?? "" })),
    ...(lastNotice ? { notice: lastNotice } : {}),
  };
  if (jobs.some((j) => j.outcome !== "fresh" && j.outcome !== "busy"))
    await store.kv.set(SYNC_STATUS_KEY, status);
  return lastNotice ? { jobs, notice: lastNotice } : { jobs };
}
