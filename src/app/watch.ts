import { type LiveSession, route } from "../core/routing/index";
import type { SessionRecord } from "../ports/index";
import type {
  AckEvent,
  HelloEvent,
  HelperEvent,
  ItemEvent,
} from "../protocol/index";
import { readSnapshot } from "./files";
import type { AppPorts } from "./ports";
import { isRecord, refFromKey, refFromSlug, repoSlug } from "./repo";
import { beat, end } from "./session";
import { runSync, SYNC_STATUS_KEY } from "./sync";

/** After a restart, items this session claimed within this window are sent again; the mod dedupes by id. */
export const REPLAY_WINDOW_MS = 60 * 60_000;

const NOTICE_PREFIX = /^crew-net: /;
/** A notice no sync has refreshed for this long is old news: the jobs since ran fresh. */
export const NOTICE_MAX_AGE_MS = 15 * 60_000;

function liveSession(s: SessionRecord): LiveSession {
  const ref = s.repo ? refFromKey(s.repo) : undefined;
  return {
    id: s.sessionId,
    role: s.role,
    repo: ref ? repoSlug(ref) : "",
    worktree: s.worktree,
    branch: s.branch ?? "",
    // A heartbeat from a build before clone roots stands alone.
    cloneRoot: s.clone ?? s.worktree,
    lastActiveMs: s.lastPromptAtMs ?? 0,
  };
}

export interface DeliverOptions {
  /** Ids this process already sent; skipped. */
  sent?: ReadonlySet<string>;
  /** Send again the items this session claimed within this many ms (0: never). */
  replayMs: number;
}

/**
 * Route each unclaimed item with `core/routing` (design: Delivery), claim the
 * ones that go to `sessionId` (first claim wins across sessions) and return
 * them, oldest first, with `wakeable` from the route and `ownPr` when the
 * session's branch has an open PR. `addressed` stays true only on a
 * wakeable route. Also returns this session's recent claims for replay.
 */
export async function deliverTo(
  ports: AppPorts,
  sessionId: string,
  options: DeliverOptions,
): Promise<ItemEvent[]> {
  const { store, clock } = ports;
  const nowMs = clock.now();
  const records = await store.sessions.live();
  const sessions = records.map(liveSession);
  const self = records.find((s) => s.sessionId === sessionId);
  const selfRef = self?.repo ? refFromKey(self.repo) : undefined;
  const host = selfRef?.host ?? "github.com";
  const heads = new Map<string, Map<number, string>>();
  const headsOf = async (slug: string): Promise<Map<number, string>> => {
    let byNumber = heads.get(slug);
    if (!byNumber) {
      const ref = refFromSlug(host, slug);
      const pulls = ref ? ((await readSnapshot(store, ref))?.pulls ?? []) : [];
      byNumber = new Map(pulls.map((p) => [p.number, p.headRef]));
      heads.set(slug, byNumber);
    }
    return byNumber;
  };
  const ownPr =
    selfRef !== undefined &&
    !!self?.branch &&
    [...(await headsOf(repoSlug(selfRef))).values()].includes(self.branch);

  const out: ItemEvent[] = [];
  for (const entry of await store.inbox.list()) {
    const { item } = entry;
    if (options.sent?.has(item.id)) continue;
    const claim = entry.delivered;
    if (claim) {
      if (claim.sessionId !== sessionId) continue;
      if (nowMs - claim.atMs >= options.replayMs) continue;
    }
    const branch =
      item.repo && item.thread !== undefined
        ? (await headsOf(item.repo.toLowerCase())).get(item.thread)
        : undefined;
    const routed = route(
      {
        repo: item.repo ?? "",
        ...(item.thread !== undefined ? { thread: item.thread } : {}),
        ...(branch ? { branch } : {}),
      },
      sessions,
    );
    if (!claim) {
      if (routed.session !== sessionId) continue;
      if (!(await store.delivered.claim(item.id, sessionId))) continue;
      // Prune may have removed the item and its old claim since the listing.
      if (!(await store.inbox.get(item.id))) continue;
      await store.events.append({
        type: "delivery",
        id: item.id,
        session: sessionId,
        step: routed.step,
        ...(item.repo ? { repo: item.repo } : {}),
        atMs: nowMs,
      });
    }
    out.push({
      ...item,
      addressed: item.addressed && routed.wakeable,
      wakeable: routed.wakeable,
      ownPr,
    });
  }
  return out;
}

/**
 * The watcher of one session (design: Harness adapters): heartbeat, sync tick, route
 * inbox items to this session and claim them, emit them to the mod. It
 * keeps no durable state: claims are in the store, and `emitted` only
 * avoids sending an item twice in one process.
 */
export class Watcher {
  private hello: HelloEvent | undefined;
  private readonly emitted = new Set<string>();
  private lastStatus = "";

  constructor(
    private readonly ports: AppPorts,
    readonly sessionId: string,
    private readonly emit: (event: HelperEvent) => void,
  ) {}

  private stopped = false;

  get started(): boolean {
    return this.hello !== undefined && !this.stopped;
  }

  /** No more heartbeats or claims: the session ended or the process is stopping. */
  stop(): void {
    this.stopped = true;
  }

  async start(hello: HelloEvent): Promise<void> {
    if (hello.session !== this.sessionId) {
      this.emit({
        type: "error",
        message: `hello for session ${hello.session}, this watcher serves ${this.sessionId}`,
      });
      return;
    }
    this.hello = hello;
    await this.tick();
  }

  /** One tick: heartbeat, sync what is due, deliver. Errors become `error` events. */
  async tick(): Promise<void> {
    const hello = this.hello;
    if (!hello || this.stopped) return;
    const { ports } = this;
    try {
      const heartbeat = await beat(ports, {
        sessionId: hello.session,
        harness: hello.harness,
        role: hello.role,
        pid: hello.pid,
        dir: hello.worktree,
      });
      const ref = heartbeat.repo ? refFromKey(heartbeat.repo) : undefined;
      await runSync(ports, ref ? { ref, dir: heartbeat.worktree } : undefined);
    } catch (error) {
      this.emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    try {
      await this.deliver();
    } catch (error) {
      this.emit({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    const status = await this.problem();
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.emit({ type: "status", text: status });
    }
  }

  /**
   * What is wrong with sync, for the status line: the notice the last sync
   * stored (rate limit, auth), without the `crew-net: ` prefix the host adds.
   * Empty when sync is healthy: the band says nothing then.
   */
  private async problem(): Promise<string> {
    try {
      const status = await this.ports.store.kv.get(SYNC_STATUS_KEY);
      if (!isRecord(status) || typeof status.notice !== "string") return "";
      const at = typeof status.atMs === "number" ? status.atMs : 0;
      if (this.ports.clock.now() - at > NOTICE_MAX_AGE_MS) return "";
      return status.notice.replace(NOTICE_PREFIX, "");
    } catch {
      return "";
    }
  }

  private async deliver(): Promise<void> {
    for (const item of await deliverTo(this.ports, this.sessionId, {
      sent: this.emitted,
      replayMs: REPLAY_WINDOW_MS,
    })) {
      this.emitted.add(item.id);
      this.emit(item);
    }
  }

  /** The mod reports what it did with an item; logged for `crew-net stats`. */
  async ack(event: AckEvent): Promise<void> {
    await this.ports.store.events.append({
      type: "ack",
      id: event.id,
      session: this.sessionId,
      outcome: event.outcome,
      atMs: this.ports.clock.now(),
    });
  }

  /** The session ends: it is no longer a routing target. */
  async bye(): Promise<void> {
    this.stop();
    await end(this.ports, this.sessionId);
  }
}
