import { type LiveSession, route } from "../core/routing/index";
import type { InboxEntry, SessionRecord } from "../ports/index";
import type {
  AckEvent,
  HelloEvent,
  HelperEvent,
  ItemEvent,
} from "../protocol/index";
import { readSnapshot } from "./files";
import type { AppPorts } from "./ports";
import { refFromKey, refFromSlug, repoSlug } from "./repo";
import { beat, end } from "./session";
import { runSync } from "./sync";

/** After a restart, items this session claimed within this window are sent again; the mod dedupes by id. */
export const REPLAY_WINDOW_MS = 60 * 60_000;

function liveSession(s: SessionRecord): LiveSession {
  const ref = s.repo ? refFromKey(s.repo) : undefined;
  return {
    id: s.sessionId,
    role: s.role,
    repo: ref ? repoSlug(ref) : "",
    worktree: s.worktree,
    branch: s.branch ?? "",
    // Heartbeats do not carry the clone root; each worktree stands alone,
    // so a worker's branch reaches its lead through the `repo` step.
    cloneRoot: s.worktree,
    lastActiveMs: s.lastPromptAtMs ?? 0,
  };
}

/**
 * The watcher of one session (design §16): heartbeat, sync tick, route
 * inbox items to this session and claim them, emit them to the mod. It
 * keeps no durable state: claims are in the store, and `emitted` only
 * avoids sending an item twice in one process.
 */
export class Watcher {
  private hello: HelloEvent | undefined;
  private readonly emitted = new Set<string>();
  private lastStatus = "";
  /** GitHub host of the session's repo, from the last heartbeat. */
  private host = "github.com";

  constructor(
    private readonly ports: AppPorts,
    readonly sessionId: string,
    private readonly emit: (event: HelperEvent) => void,
  ) {}

  get started(): boolean {
    return this.hello !== undefined;
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
    if (!hello) return;
    const { ports } = this;
    let notice: string | undefined;
    try {
      const heartbeat = await beat(ports, {
        sessionId: hello.session,
        harness: hello.harness,
        role: hello.role,
        pid: hello.pid,
        dir: hello.worktree,
      });
      const ref = heartbeat.repo ? refFromKey(heartbeat.repo) : undefined;
      if (ref) this.host = ref.host;
      notice = (
        await runSync(ports, ref ? { ref, dir: heartbeat.worktree } : undefined)
      ).notice;
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
    const status = notice ?? "crew-net: watching";
    if (status !== this.lastStatus) {
      this.lastStatus = status;
      this.emit({ type: "status", text: status });
    }
  }

  private async deliver(): Promise<void> {
    const { store, clock } = this.ports;
    const nowMs = clock.now();
    const sessions = (await store.sessions.live()).map(liveSession);
    const heads = new Map<string, Map<number, string>>();
    const branchOf = async (item: ItemEvent): Promise<string | undefined> => {
      if (!item.repo || item.thread === undefined) return undefined;
      const host = refFromKey(
        (await store.sessions.live()).find(
          (s) => s.sessionId === this.sessionId,
        )?.repo ?? "github.com/x/x",
      )?.host;
      const ref = refFromSlug(host ?? "github.com", item.repo);
      if (!ref) return undefined;
      let byNumber = heads.get(item.repo);
      if (!byNumber) {
        byNumber = new Map(
          ((await readSnapshot(store, ref))?.pulls ?? []).map((p) => [
            p.number,
            p.headRef,
          ]),
        );
        heads.set(item.repo, byNumber);
      }
      return byNumber.get(item.thread);
    };
    for (const entry of await store.inbox.list()) {
      const { item } = entry;
      if (this.emitted.has(item.id)) continue;
      if (!(await this.mine(entry, nowMs))) continue;
      const branch = await branchOf(item);
      const routed = route(
        {
          repo: item.repo ?? "",
          ...(item.thread !== undefined ? { thread: item.thread } : {}),
          ...(branch ? { branch } : {}),
        },
        sessions,
      );
      if (!entry.delivered) {
        if (routed.session !== this.sessionId) continue;
        if (!(await store.delivered.claim(item.id, this.sessionId))) continue;
        await store.events.append({
          type: "delivery",
          id: item.id,
          session: this.sessionId,
          step: routed.step,
          ...(item.repo ? { repo: item.repo } : {}),
          atMs: nowMs,
        });
      }
      this.emitted.add(item.id);
      this.emit({
        ...item,
        addressed: item.addressed && routed.wakeable,
        wakeable: routed.wakeable,
      });
    }
  }

  /** Unclaimed items may be mine; claimed ones are mine to replay only if this session claimed them recently. */
  private async mine(entry: InboxEntry, nowMs: number): Promise<boolean> {
    const claim = entry.delivered;
    if (!claim) return true;
    if (claim.sessionId !== this.sessionId) return false;
    if (nowMs - claim.atMs > REPLAY_WINDOW_MS) {
      this.emitted.add(entry.item.id);
      return false;
    }
    return true;
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
    await end(this.ports, this.sessionId);
  }
}
