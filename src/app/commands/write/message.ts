import type { PullRequest } from "../../../ports/index";
import {
  type MessageMarker,
  mentionLine,
  REQUEST_KINDS,
  type ReplyStatus,
  renderMessageMarker,
} from "../../../protocol/index";
import {
  CommandError,
  currentPr,
  guardKeywords,
  label,
  parseTarget,
  parseThreadRef,
  readPull,
  same,
  type ThreadRef,
  type WriteContext,
} from "./context";

export type RequestKind = "review" | "fix" | "bug";
export const REQUEST_WORK_KINDS: readonly RequestKind[] = [
  "review",
  "fix",
  "bug",
];

export interface SendArgs {
  /** `@login`, `#N`, `owner/repo#N` or a PR URL. */
  target: string;
  text: string;
  /** With `@login`: the PR or Issue to comment on, instead of picking one. */
  on?: string;
}

export interface SendResult {
  /** Marker id; replies point at it. */
  id: string;
  kind: "ask" | RequestKind;
  to: string;
  repo: string;
  number: number;
  /** True when this command opened the Issue it posted on. */
  openedIssue: boolean;
}

/** Store key that marks an inbox item as answered: `{ status, re, atMs }`. */
export const REPLIED_KEY_PREFIX = "replied:";

/** Outbox summary: the first line, capped. */
const SUMMARY_MAX = 200;
const TITLE_MAX = 80;
const ID_ATTEMPTS = 5;

const firstLine = (text: string, max: number): string => {
  const line = text.split("\n")[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

function messageBody(marker: MessageMarker, to: string, text: string): string {
  const rendered = renderMessageMarker(marker);
  if (!rendered.ok)
    throw new CommandError(
      "usage",
      `bad ${rendered.field}: ${rendered.detail}`,
    );
  const mention = mentionLine(to, text);
  if (mention === null)
    throw new CommandError("usage", "a message needs a login and some text");
  return `${rendered.marker}\n\n${mention}`;
}

async function freshId(ctx: WriteContext): Promise<string> {
  const taken = new Set((await ctx.store.outbox.list()).map((r) => r.id));
  for (let i = 0; i < ID_ATTEMPTS; i++) {
    const id = ctx.newId();
    if (!taken.has(id)) return id;
  }
  throw new Error("could not pick an unused message id");
}

function openPull(pr: PullRequest, ref: ThreadRef, home: string): void {
  if (pr.state !== "open")
    throw new CommandError(
      "refused",
      `${label(ref, home)} is ${pr.merged ? "merged" : "closed"}; open an Issue with \`crew-net request @login bug\``,
    );
}

type Thread =
  | { kind: "existing"; ref: ThreadRef; to: string }
  | { kind: "new-issue"; repo: string; to: string };

/** Pick the thread for a message (design §7.2). */
async function pickThread(
  ctx: WriteContext,
  kind: SendResult["kind"],
  args: SendArgs,
  me: string,
): Promise<Thread> {
  const target = parseTarget(args.target, ctx);
  if ("thread" in target) {
    if (args.on !== undefined)
      throw new CommandError("usage", "--on goes with @login, not with a PR");
    // About the recipient's work: a comment on their PR.
    const pr = await readPull(ctx, target.thread);
    openPull(pr, target.thread, ctx.repo);
    if (same(pr.author, me))
      throw new CommandError(
        "usage",
        `${label(target.thread, ctx.repo)} is your PR; name the recipient: @login --on ${label(target.thread, ctx.repo)}`,
      );
    return { kind: "existing", ref: target.thread, to: pr.author };
  }
  const to = target.login;
  if (same(to, me))
    throw new CommandError("usage", "you cannot send a request to yourself");
  if (args.on !== undefined) {
    const ref = parseThreadRef(args.on, ctx);
    if (!ref)
      throw new CommandError(
        "usage",
        `--on expects #N, owner/repo#N or a URL, got ${JSON.stringify(args.on)}`,
      );
    return { kind: "existing", ref, to };
  }
  // About neither: a bug in their area gets its own Issue.
  if (kind === "bug") return { kind: "new-issue", repo: ctx.repo, to };
  // About my work: a comment on my PR.
  const mine = await currentPr(ctx, me);
  if (mine)
    return {
      kind: "existing",
      ref: { repo: ctx.repo, number: mine.number },
      to,
    };
  // About their work, when they have exactly one open PR here.
  const theirs = (await ctx.github.listOpenPulls(ctx.repo)).filter((p) =>
    same(p.author, to),
  );
  if (theirs.length === 1 && theirs[0])
    return {
      kind: "existing",
      ref: { repo: ctx.repo, number: theirs[0].number },
      to,
    };
  const options = theirs.map((p) => `#${p.number}`).join(", ");
  throw new CommandError(
    "usage",
    theirs.length === 0
      ? `no thread for @${to}: your branch has no open PR and @${to} has none in ${ctx.repo}; name one with --on #N`
      : `@${to} has several open PRs (${options}); name one: #N, or --on #N`,
  );
}

async function send(
  ctx: WriteContext,
  kind: SendResult["kind"],
  args: SendArgs,
): Promise<SendResult> {
  const text = args.text.trim();
  if (text === "") throw new CommandError("usage", "the message is empty");
  const me = await ctx.github.viewer();
  const thread = await pickThread(ctx, kind, args, me);
  const id = await freshId(ctx);
  const body = messageBody({ kind, id }, thread.to, text);
  guardKeywords("the message", body);

  let ref: ThreadRef;
  if (thread.kind === "new-issue") {
    const title = firstLine(text, TITLE_MAX);
    const issueBody =
      "Reported with `crew-net request … bug`. The report is in the first comment.";
    guardKeywords("the Issue title", title);
    ref = {
      repo: thread.repo,
      number: await ctx.github.createIssue(thread.repo, title, issueBody),
    };
    try {
      await ctx.github.postComment(ref.repo, ref.number, body);
    } catch (error) {
      throw new CommandError(
        "refused",
        `opened Issue ${label(ref, ctx.repo)} but could not post the report (${(error as Error).message}); retry with --on ${label(ref, ctx.repo)}`,
      );
    }
  } else {
    ref = thread.ref;
    await ctx.github.postComment(ref.repo, ref.number, body);
  }

  const atMs = ctx.clock.now();
  try {
    await ctx.store.outbox.put({
      id,
      repo: `${ctx.host}/${ref.repo}`,
      number: ref.number,
      to: thread.to,
      kind,
      text: firstLine(text, SUMMARY_MAX),
      createdAtMs: atMs,
      status: "open",
    });
  } catch (error) {
    throw new Error(
      `posted on ${label(ref, ctx.repo)} but could not track it locally: ${(error as Error).message}`,
    );
  }
  await logEvent(ctx, {
    type: "request.sent",
    kind,
    id,
    repo: ref.repo,
    number: ref.number,
    to: thread.to,
    atMs,
  });
  return {
    id,
    kind,
    to: thread.to,
    repo: ref.repo,
    number: ref.number,
    openedIssue: thread.kind === "new-issue",
  };
}

/** Stats are best effort: a failed append must not fail a posted message. */
async function logEvent(
  ctx: WriteContext,
  event: Record<string, string | number>,
): Promise<void> {
  await ctx.store.events.append(event).catch(() => undefined);
}

/** `crew-net ask <@login|PR> "<text>"`. */
export async function ask(
  ctx: WriteContext,
  args: SendArgs,
): Promise<SendResult> {
  return send(ctx, "ask", args);
}

/** `crew-net request <@login|PR> review|fix|bug "<text>"`. */
export async function request(
  ctx: WriteContext,
  args: SendArgs & { kind: string },
): Promise<SendResult> {
  const kind = REQUEST_WORK_KINDS.find((k) => k === args.kind);
  if (!kind)
    throw new CommandError(
      "usage",
      `request kind must be review, fix or bug, got ${JSON.stringify(args.kind)}`,
    );
  return send(ctx, kind, args);
}

export interface ReplyArgs {
  /** Inbox item id. */
  item: string;
  text: string;
  /** Default `answered`. */
  status?: ReplyStatus;
}

export interface ReplyResult {
  item: string;
  to: string;
  repo: string;
  number: number;
  re: string;
  status: ReplyStatus;
}

/** `crew-net reply <item> [--done|--decline|--accept] "<text>"`. */
export async function reply(
  ctx: WriteContext,
  args: ReplyArgs,
): Promise<ReplyResult> {
  const text = args.text.trim();
  if (text === "") throw new CommandError("usage", "the reply is empty");
  const entry = await ctx.store.inbox.get(args.item);
  if (!entry) throw new CommandError("not-found", `no inbox item ${args.item}`);
  const { from, repo, thread, event, msgId } = entry.item;
  if (
    from === undefined ||
    repo === undefined ||
    thread === undefined ||
    msgId === undefined ||
    !REQUEST_KINDS.some((k) => k === event)
  )
    throw new CommandError(
      "refused",
      `item ${args.item} is not a crew request; answer it on GitHub`,
    );
  const status = args.status ?? "answered";
  const body = messageBody({ kind: "reply", re: msgId, status }, from, text);
  guardKeywords("the reply", body);
  await ctx.github.postComment(repo, thread, body);
  const atMs = ctx.clock.now();
  await ctx.store.kv
    .set(`${REPLIED_KEY_PREFIX}${args.item}`, { status, re: msgId, atMs })
    .catch(() => undefined);
  await logEvent(ctx, {
    type: "request.replied",
    item: args.item,
    re: msgId,
    status,
    repo,
    number: thread,
    atMs,
  });
  return { item: args.item, to: from, repo, number: thread, re: msgId, status };
}

/** One line for the terminal. No peer text: only logins, refs and ids. */
export function renderSend(r: SendResult, home: string): string {
  const where = label({ repo: r.repo, number: r.number }, home);
  const verb = r.kind === "ask" ? "asked" : `requested ${r.kind} from`;
  return `${verb} @${r.to} on ${r.openedIssue ? "new Issue " : ""}${where} (id ${r.id}); tracked in crew-net inbox`;
}

export function renderReply(r: ReplyResult, home: string): string {
  return `replied ${r.status} to @${r.to} on ${label({ repo: r.repo, number: r.number }, home)} (re ${r.re})`;
}
