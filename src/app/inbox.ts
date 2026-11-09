import { DEFAULT_BOTS, isBot } from "../core/radar/index";
import type {
  CommentCursor,
  IssueComment,
  NotificationThread,
  OutboundRequest,
  PullReview,
  StorePort,
} from "../ports/index";
import {
  type ItemEvent,
  type MessageMarker,
  parseMessageMarker,
  REQUEST_KINDS,
} from "../protocol/index";
import { viewerOf } from "./files";
import { ITEM_TEXT_MAX, iso, putItem, sameLogin } from "./items";
import type { AppPorts } from "./ports";

/** The first poll on a laptop looks back one day, not at every old notification. */
export const FIRST_POLL_LOOKBACK_MS = 24 * 60 * 60 * 1000;

export const notificationsCursor = (host: string): string =>
  `notifications:${host}`;
const threadCursor = (host: string, repo: string, n: number): string =>
  `thread:${host}/${repo.toLowerCase()}#${n}`;
const reviewCursor = (host: string, repo: string, n: number): string =>
  `reviews:${host}/${repo.toLowerCase()}#${n}`;
export const pollIntervalKey = (host: string): string =>
  `inbox:interval:${host}`;
export const ssoPartialKey = (host: string): string => `sso:partial:${host}`;

const MARKER_PREFIX = /^\s*<!--[\s\S]*?-->/;

function parseCursor(value: string | undefined): CommentCursor | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as CommentCursor).updatedAt === "string" &&
      Number.isInteger((parsed as CommentCursor).id)
    )
      return parsed as CommentCursor;
  } catch {
    // An unreadable cursor re-reads from the notification cursor; ids dedupe.
  }
  return undefined;
}

/** True when the first line of the visible text mentions `login`. */
export function mentions(visible: string, login: string): boolean {
  const first = visible.trimStart().split("\n", 1)[0] ?? "";
  const m = /^@([A-Za-z0-9-]+)/.exec(first);
  return m !== null && sameLogin(m[1] ?? "", login);
}

/** GitHub Apps (`name[bot]`) and the known bots are never peers. */
export const isBotLogin = (login: string): boolean =>
  /\[bot\]$/i.test(login) || isBot(login, DEFAULT_BOTS);

/** Errors that stop the whole pass with the cursor unmoved (design §17-18). */
const STOP_ERRORS = new Set(["RateLimitError", "AuthError", "SsoError"]);
/** A thread that fails this many passes in a row is skipped. */
export const THREAD_GIVE_UP = 3;

const isRequest = (marker: MessageMarker): boolean =>
  REQUEST_KINDS.some((kind) => kind === marker.kind);

/**
 * One inbox pass for a host (design §8.2): notifications since the cursor,
 * then new comments and reviews of each kept thread. Items are written
 * before any cursor moves.
 */
export async function inboxJob(ports: AppPorts, host: string): Promise<void> {
  const { store, clock } = ports;
  const github = ports.github(host);
  const startedMs = clock.now();
  const me = await viewerOf(store, github, host, startedMs);
  const cursorName = notificationsCursor(host);
  const since =
    (await store.cursors.get(cursorName)) ??
    iso(startedMs - FIRST_POLL_LOOKBACK_MS);
  const page = await github.notifications(since);
  if (page.pollIntervalMs !== null)
    await store.kv.set(pollIntervalKey(host), page.pollIntervalMs);
  await store.kv.set(ssoPartialKey(host), page.ssoPartialOrgs);
  const muted = new Set(ports.settings.mute);
  const threads = [...page.threads].sort((a, b) =>
    a.updatedAt.localeCompare(b.updatedAt),
  );
  let holdAt: string | undefined;
  for (const thread of threads) {
    if (muted.has(thread.repo.toLowerCase())) continue;
    const failKey = `inbox:fail:${host}/${thread.repo.toLowerCase()}#${thread.number}`;
    try {
      await readThread(ports, host, me, since, thread);
      if ((await store.kv.get(failKey)) !== undefined)
        await store.kv.set(failKey, 0);
    } catch (error) {
      if (error instanceof Error && STOP_ERRORS.has(error.name)) throw error;
      const failed = await store.kv.update(failKey, (n) =>
        typeof n === "number" ? n + 1 : 1,
      );
      await store.events.append({
        type: "sync-error",
        job: `inbox:${host}`,
        thread: `${thread.repo}#${thread.number}`,
        message: error instanceof Error ? error.message : String(error),
        atMs: clock.now(),
      });
      // Hold the cursor before a thread that failed, so its comments are
      // read next pass; after THREAD_GIVE_UP failures in a row (a deleted
      // issue, lost access) let it go so the host's inbox does not stall.
      if (typeof failed === "number" && failed < THREAD_GIVE_UP) {
        holdAt ??= thread.updatedAt;
        // The retry runs with a later `since`; keep this pass's lower bound.
        const name = threadCursor(host, thread.repo, thread.number);
        if ((await store.cursors.get(name)) === undefined)
          await store.cursors.set(
            name,
            JSON.stringify({ updatedAt: since, id: 0 }),
          );
      }
    }
  }
  // GitHub's clock, not the laptop's: the newest thread time seen. A laptop
  // clock running ahead would otherwise skip threads updated meanwhile.
  const newest = threads.at(-1)?.updatedAt;
  const next = holdAt ? iso(Date.parse(holdAt) - 1000) : newest;
  if (next && next > since) await store.cursors.set(cursorName, next);
  else if ((await store.cursors.get(cursorName)) === undefined)
    await store.cursors.set(cursorName, since);
}

async function readThread(
  ports: AppPorts,
  host: string,
  me: string,
  since: string,
  thread: NotificationThread,
): Promise<void> {
  const { store, clock } = ports;
  const github = ports.github(host);
  const { repo, number } = thread;
  const name = threadCursor(host, repo, number);
  const after = parseCursor(await store.cursors.get(name)) ?? {
    updatedAt: since,
    id: 0,
  };
  const comments = await github.listThreadComments(repo, number, after);
  for (const comment of comments) {
    const read = await commentItem(store, host, me, repo, comment);
    if (!read) continue;
    await putItem(store, read.item, clock.now());
    if (read.reply) await applyReply(store, read.reply, clock.now());
  }
  const last = comments.at(-1);
  if (last) {
    await store.cursors.set(
      name,
      JSON.stringify({ updatedAt: last.updatedAt, id: last.id }),
    );
  }
  if (thread.kind === "pull") {
    await readReviews(ports, host, me, since, repo, number);
  }
}

interface ReadComment {
  item: ItemEvent;
  /** A reply to one of my open requests, applied after the item is stored. */
  reply?: { request: OutboundRequest; status: string };
}

async function commentItem(
  store: StorePort,
  host: string,
  me: string,
  repo: string,
  comment: IssueComment,
): Promise<ReadComment | undefined> {
  if (sameLogin(comment.author, me) || isBotLogin(comment.author))
    return undefined;
  const parsed = parseMessageMarker(comment.body);
  const marker = parsed?.ok ? parsed.marker : undefined;
  const visible = (
    parsed === null ? comment.body : comment.body.replace(MARKER_PREFIX, "")
  ).trim();
  let event = "comment";
  let addressed = false;
  let reply: ReadComment["reply"];
  if (marker && isRequest(marker)) {
    event = marker.kind;
    addressed = mentions(visible, me);
  } else if (marker?.kind === "info") {
    event = "info";
    addressed = mentions(visible, me);
  } else if (marker?.kind === "reply") {
    const request = (await store.outbox.list()).find(
      (r) => r.id === marker.re && sameLogin(r.to, comment.author),
    );
    if (request) {
      event = "reply";
      reply = { request, status: marker.status ?? "answered" };
    }
  }
  const item: ItemEvent = {
    type: "item",
    id: `comment:${host}/${repo.toLowerCase()}#${comment.issueNumber}:${comment.id}`,
    kind: "message",
    text: visible.slice(0, ITEM_TEXT_MAX),
    addressed,
    from: comment.author,
    repo,
    thread: comment.issueNumber,
    event,
    ...(marker && isRequest(marker) && marker.id !== undefined
      ? { msgId: marker.id }
      : {}),
  };
  return reply ? { item, reply } : { item };
}

/**
 * A reply to one of my open requests moves it along its lifecycle (design
 * §7.3): `accepted` → in progress; `answered`, `declined`, `done` → closed.
 * Only the recipient of the request can move it. Idempotent on replay.
 */
async function applyReply(
  store: StorePort,
  { request, status }: NonNullable<ReadComment["reply"]>,
  nowMs: number,
): Promise<void> {
  const logged = {
    type: "request",
    id: request.id,
    repo: request.repo,
    kind: request.kind,
    outcome: status,
    openMs: nowMs - request.createdAtMs,
    atMs: nowMs,
  };
  if (status === "accepted") {
    if (request.status === "in-progress") return;
    await store.outbox.put({ ...request, status: "in-progress" });
  } else {
    await store.outbox.remove(request.id);
  }
  await store.events.append(logged);
}

const REVIEW_LABEL: Record<string, string> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes requested",
  COMMENTED: "commented",
  DISMISSED: "dismissed",
};

async function readReviews(
  ports: AppPorts,
  host: string,
  me: string,
  since: string,
  repo: string,
  number: number,
): Promise<void> {
  const { store, clock } = ports;
  const name = reviewCursor(host, repo, number);
  const after = (await store.cursors.get(name)) ?? since;
  const reviews = (await ports.github(host).listReviews(repo, number)).filter(
    (r): r is PullReview & { submittedAt: string } =>
      // Inclusive: second-granular times; putItem dedupes the review seen last time.
      r.submittedAt !== null && r.submittedAt >= after,
  );
  for (const review of reviews) {
    if (sameLogin(review.author, me) || isBotLogin(review.author)) continue;
    const body = review.body.trim();
    // Inline-only reviews arrive as COMMENTED with no body: nothing to read here.
    if (review.state === "COMMENTED" && body === "") continue;
    const label = REVIEW_LABEL[review.state] ?? review.state.toLowerCase();
    await putItem(
      store,
      {
        type: "item",
        id: `review:${host}/${repo.toLowerCase()}#${number}:${review.id}`,
        kind: "message",
        text: (body ? `${label}: ${body}` : label).slice(0, ITEM_TEXT_MAX),
        addressed: false,
        from: review.author,
        repo,
        thread: number,
        event: "pr-review",
      },
      clock.now(),
    );
  }
  const newest = reviews
    .map((r) => r.submittedAt)
    .sort()
    .at(-1);
  if (newest) await store.cursors.set(name, newest);
}
