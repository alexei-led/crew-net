import { DEFAULT_BOTS, type Finding, isBot } from "../radar";

export interface Me {
  /** GitHub login. */
  developer: string;
  /** Lead name, without the developer. */
  lead: string;
}

export interface OpenPr {
  number: number;
  title: string;
  author: string;
  draft: boolean;
  /** `lead` of the PR's state block, `developer/name`. */
  lead?: string;
  /** `state` of the PR's state block. */
  state?: string;
}

export interface MergedPr {
  number: number;
  title: string;
  author: string;
  mergedAtMs: number;
  changedPaths: string[];
}

export interface UnreadMessage {
  id: string;
  from: string;
  pr?: number;
  preview: string;
  atMs: number;
}

/** An addressed message that needs an answer, in either direction. */
export interface RequestFacts {
  id: string;
  from: string;
  to: string;
  pr?: number;
  atMs: number;
  answered: boolean;
}

/** A plain GitHub `@me` mention from a person; not a crew message. */
export interface MentionFacts {
  from: string;
  pr?: number;
  preview: string;
  atMs: number;
}

export interface Snapshot {
  openPrs: OpenPr[];
  /** Merged PRs the app considers new; the digest filters on `sinceMs`. */
  mergedPrs: MergedPr[];
  /** Epoch ms of the previous session's start. Null: no filter, list all given. */
  sinceMs: number | null;
  /** Paths changed on the branches this lead covers. */
  myPaths: string[];
  findings: Finding[];
  unread: UnreadMessage[];
  requests: RequestFacts[];
  mentions: MentionFacts[];
  /** Logins to leave out; defaults to the radar's bot list. */
  bots?: string[];
}

export interface DigestPr extends OpenPr {
  mine: boolean;
}

export interface DigestMerged {
  number: number;
  title: string;
  author: string;
  mergedAtMs: number;
  /** Merged paths that are also on my branches. */
  touchesMine: string[];
}

export interface DigestRequest {
  direction: "incoming" | "outgoing";
  /** The other party. */
  with: string;
  pr?: number;
  ageMs: number;
}

export interface Digest {
  openPrs: DigestPr[];
  merged: DigestMerged[];
  findings: Finding[];
  unread: UnreadMessage[];
  requests: DigestRequest[];
  mentions: MentionFacts[];
}

const sameLogin = (a: string, b: string): boolean =>
  a.toLowerCase() === b.toLowerCase();

/**
 * Compose the digest for `me`. Bot PRs are dropped. PRs merged before the
 * last session are dropped; the rest are flagged when they touch my files and
 * listed first. Requests are the unanswered ones, oldest first.
 */
export function compose(snapshot: Snapshot, me: Me, nowMs: number): Digest {
  const bots = snapshot.bots ?? DEFAULT_BOTS;
  const mine = new Set(snapshot.myPaths);
  const sinceMs = snapshot.sinceMs;

  const openPrs = snapshot.openPrs
    .filter((pr) => !isBot(pr.author, bots))
    .map((pr) => ({ ...pr, mine: sameLogin(pr.author, me.developer) }))
    .sort((a, b) => Number(b.mine) - Number(a.mine) || a.number - b.number);

  const merged = snapshot.mergedPrs
    .filter(
      (pr) =>
        !isBot(pr.author, bots) &&
        (sinceMs === null || pr.mergedAtMs > sinceMs),
    )
    .map((pr) => ({
      number: pr.number,
      title: pr.title,
      author: pr.author,
      mergedAtMs: pr.mergedAtMs,
      touchesMine: pr.changedPaths.filter((p) => mine.has(p)),
    }))
    .sort(
      (a, b) =>
        Number(b.touchesMine.length > 0) - Number(a.touchesMine.length > 0) ||
        b.mergedAtMs - a.mergedAtMs,
    );

  const requests = snapshot.requests
    .filter((r) => !r.answered)
    .map((r): DigestRequest => {
      const outgoing = sameLogin(r.from, me.developer);
      return {
        direction: outgoing ? "outgoing" : "incoming",
        with: outgoing ? r.to : r.from,
        ...(r.pr === undefined ? {} : { pr: r.pr }),
        ageMs: Math.max(0, nowMs - r.atMs),
      };
    })
    .sort((a, b) => b.ageMs - a.ageMs);

  return {
    openPrs,
    merged,
    findings: snapshot.findings,
    unread: [...snapshot.unread].sort((a, b) => a.atMs - b.atMs),
    requests,
    mentions: [...snapshot.mentions].sort((a, b) => a.atMs - b.atMs),
  };
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatAge(ageMs: number): string {
  if (ageMs < MINUTE) return "<1m";
  if (ageMs < HOUR) return `${Math.floor(ageMs / MINUTE)}m`;
  if (ageMs < DAY) return `${Math.floor(ageMs / HOUR)}h`;
  return `${Math.floor(ageMs / DAY)}d`;
}

const prRef = (pr: number | undefined): string =>
  pr === undefined ? "" : ` on #${pr}`;

function section(title: string, lines: string[]): string[] {
  return lines.length > 0 ? [title, ...lines.map((l) => `  ${l}`), ""] : [];
}

/** Plain text for the terminal and the model. Empty sections are omitted. */
export function renderText(digest: Digest): string {
  const sections = [
    ...section(
      "Open PRs",
      digest.openPrs.map((pr) => {
        const owner = pr.lead ?? pr.author;
        const tags = [pr.draft ? "draft" : null, pr.state ?? null]
          .filter(Boolean)
          .join(", ");
        return `#${pr.number} ${pr.title} (${owner}${pr.mine ? ", mine" : ""}${tags ? `, ${tags}` : ""})`;
      }),
    ),
    ...section(
      "Merged since your last session",
      digest.merged.map((pr) => {
        const flag =
          pr.touchesMine.length > 0
            ? ` TOUCHES YOUR FILES: ${pr.touchesMine.join(", ")}`
            : "";
        return `#${pr.number} ${pr.title} (${pr.author})${flag}`;
      }),
    ),
    ...section(
      "Radar",
      digest.findings.map(
        (f) =>
          `${f.kind} with ${f.other.developer}${f.other.pr === undefined ? "" : ` #${f.other.pr}`} (${f.other.branch}): ${f.paths.join(", ")}`,
      ),
    ),
    ...section(
      "Unread messages",
      digest.unread.map((m) => `${m.from}${prRef(m.pr)}: ${m.preview}`),
    ),
    ...section(
      "Unanswered requests",
      digest.requests.map(
        (r) =>
          `${r.direction === "incoming" ? "from" : "waiting on"} ${r.with}${prRef(r.pr)}, ${formatAge(r.ageMs)}`,
      ),
    ),
    ...section(
      "Mentions",
      digest.mentions.map((m) => `${m.from}${prRef(m.pr)}: ${m.preview}`),
    ),
  ];
  return sections.length > 0
    ? sections.join("\n").trimEnd()
    : "Nothing to report.";
}
