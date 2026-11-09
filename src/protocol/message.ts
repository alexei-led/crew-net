export const MESSAGE_KINDS = [
  "ask",
  "review",
  "fix",
  "bug",
  "info",
  "reply",
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** Kinds that ask for something and are tracked until closed. */
export const REQUEST_KINDS = ["ask", "review", "fix", "bug"] as const;

export const REPLY_STATUSES = [
  "answered",
  "accepted",
  "declined",
  "done",
] as const;
export type ReplyStatus = (typeof REPLY_STATUSES)[number];

/** GitHub login: alphanumerics and hyphens, at most 39 characters. */
export const LOGIN_PATTERN = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
const LOGIN = new RegExp(`^${LOGIN_PATTERN}$`);

/** Short random id, unique per sender. */
const ID = /^[a-z0-9]{4,12}$/;

/** The hidden marker of a crew-net message. */
export interface MessageMarker {
  kind: MessageKind;
  /** Set on requests so replies can point at it. */
  id?: string;
  /** The `id` being answered. Replies only. */
  re?: string;
  /** Replies only. */
  status?: ReplyStatus;
}

export type ParseMarkerResult =
  | { ok: true; marker: MessageMarker }
  | { ok: false; reason: "malformed"; detail: string };

export type RenderMarkerResult =
  | { ok: true; marker: string }
  | { ok: false; field: string; detail: string };

// Anchored to the start of the comment: a marker quoted further down in a
// person's reply is not a crew-net message.
const MARKER = /^\s*<!--[ \t]*crew-net:msg(?=\s|-->)([\s\S]*?)-->/;

const isKind = (value: string | undefined): value is MessageKind =>
  MESSAGE_KINDS.some((kind) => kind === value);
const isStatus = (value: string | undefined): value is ReplyStatus =>
  REPLY_STATUSES.some((status) => status === value);
const isRequestKind = (kind: MessageKind): boolean =>
  REQUEST_KINDS.some((request) => request === kind);

const malformed = (detail: string): ParseMarkerResult => ({
  ok: false,
  reason: "malformed",
  detail,
});

/**
 * Read the marker at the start of a comment body. Unknown keys are ignored.
 * Returns null when the comment has no marker (a person's comment). A marker
 * with an unknown kind, a bad id or a missing required key is `malformed`: it
 * is not a message this build understands, so it must not wake a session.
 */
export function parseMessageMarker(body: string): ParseMarkerResult | null {
  const match = MARKER.exec(body);
  if (!match) return null;
  const pairs = new Map<string, string>();
  for (const token of (match[1] ?? "").split(/\s+/)) {
    const eq = token.indexOf("=");
    if (eq <= 0) continue;
    const key = token.slice(0, eq);
    if (!pairs.has(key)) pairs.set(key, token.slice(eq + 1));
  }
  const kind = pairs.get("kind");
  if (!isKind(kind)) return malformed(`unknown kind ${kind ?? "(missing)"}`);
  const id = pairs.get("id");
  const re = pairs.get("re");
  const status = pairs.get("status");
  if (id !== undefined && !ID.test(id)) return malformed(`bad id ${id}`);
  if (re !== undefined && !ID.test(re)) return malformed(`bad re ${re}`);
  if (status !== undefined && !isStatus(status))
    return malformed(`unknown status ${status}`);
  if (isRequestKind(kind) && id === undefined)
    return malformed(`${kind} needs an id`);
  if (kind === "reply" && re === undefined) return malformed("reply needs re");
  return {
    ok: true,
    marker: {
      kind,
      ...(id === undefined ? {} : { id }),
      ...(re === undefined ? {} : { re }),
      ...(kind === "reply" && status !== undefined ? { status } : {}),
    },
  };
}

const refuse = (field: string, detail: string): RenderMarkerResult => ({
  ok: false,
  field,
  detail,
});

/** Write a marker. Refuses what `parseMessageMarker` would reject. */
export function renderMessageMarker(marker: MessageMarker): RenderMarkerResult {
  if (!isKind(marker.kind)) return refuse("kind", "unknown kind");
  if (marker.id !== undefined && !ID.test(marker.id))
    return refuse("id", "expected [a-z0-9]{4,12}");
  if (marker.re !== undefined && !ID.test(marker.re))
    return refuse("re", "expected [a-z0-9]{4,12}");
  if (marker.status !== undefined && !isStatus(marker.status))
    return refuse("status", "unknown status");
  if (marker.status !== undefined && marker.kind !== "reply")
    return refuse("status", "only replies carry a status");
  if (isRequestKind(marker.kind) && marker.id === undefined)
    return refuse("id", `${marker.kind} needs an id`);
  if (marker.kind === "reply" && marker.re === undefined)
    return refuse("re", "reply needs re");
  const parts = [`kind=${marker.kind}`];
  if (marker.id !== undefined) parts.push(`id=${marker.id}`);
  if (marker.re !== undefined) parts.push(`re=${marker.re}`);
  if (marker.status !== undefined) parts.push(`status=${marker.status}`);
  return { ok: true, marker: `<!-- crew-net:msg ${parts.join(" ")} -->` };
}

/** The visible first line: `@maria text`. GitHub notifies the mentioned login. Null for a bad login or empty text. */
export function mentionLine(login: string, text: string): string | null {
  const first = text.trim();
  if (!LOGIN.test(login) || first === "") return null;
  return `@${login} ${first}`;
}
