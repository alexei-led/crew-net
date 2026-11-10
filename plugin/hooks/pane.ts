// Pure model of the /crew pane (register.ts draws it): parse what `crew-net
// digest --json` and `crew-net inbox --json` print, and lay it out as rows.
// No engine, no I/O. Peer text reaches rows only through `clean`.
import {
  clean,
  type Digest,
  formatAge,
  TEXT_MAX,
} from "../../src/core/digest/index";

/** The pane's id: `$.ui.open`, the render hook and the tests name it. */
export const PANE_ID = "crew";
/** Answer keys 1-9; more requests than that wait in `crew-net inbox`. */
export const ANSWER_KEYS = 9;

/** An open request to me, as `crew-net inbox --json` prints it (`toMe`). */
export interface Request {
  /** What `crew-net reply` takes. */
  id: string;
  event: string;
  from: string;
  repo: string;
  thread?: number;
  text: string;
  ageMs: number;
}

/** What one refresh learned. Every field is read tolerantly: the CLI may be newer than the mod. */
export interface PaneData {
  digest?: Digest;
  /** The store has no snapshot or an old one; a sync runs in the background. */
  stale: boolean;
  /** Requests to me not yet answered, oldest first. */
  requests: Request[];
  atMs: number;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function json(stdout: string): unknown {
  try {
    return JSON.parse(stdout);
  } catch {
    return undefined;
  }
}

/** The digest model from `crew-net digest --json`, or undefined for anything else. */
export function parseDigest(
  stdout: string,
): Pick<PaneData, "digest" | "stale"> | undefined {
  const raw = json(stdout);
  if (!isObject(raw) || !isObject(raw.digest)) return undefined;
  const d = raw.digest;
  const sections = [
    "mine",
    "waitsOnMe",
    "others",
    "merged",
    "inbox",
    "waiting",
  ];
  const ok = sections.every((k) => {
    const s = d[k];
    return (
      isObject(s) && Array.isArray(s.shown) && typeof s.hidden === "number"
    );
  });
  if (!ok || typeof d.repo !== "string" || typeof d.branch !== "string")
    return undefined;
  return {
    digest: d as unknown as Digest,
    stale: raw.stale === true || raw.refreshing === true,
  };
}

const ID = /^[\w:.@#/-]{1,200}$/;

/** My open requests from `crew-net inbox --json`. Entries without a safe id are dropped: no answer key can name them. */
export function parseRequests(stdout: string): Request[] {
  const raw = json(stdout);
  if (!isObject(raw) || !Array.isArray(raw.toMe)) return [];
  const out: Request[] = [];
  for (const r of raw.toMe) {
    if (!isObject(r)) continue;
    if (typeof r.id !== "string" || !ID.test(r.id)) continue;
    if (typeof r.from !== "string" || typeof r.event !== "string") continue;
    out.push({
      id: r.id,
      event: r.event,
      from: clean(r.from, 39),
      repo: typeof r.repo === "string" ? r.repo : "",
      ...(typeof r.thread === "number" && Number.isInteger(r.thread)
        ? { thread: r.thread }
        : {}),
      text: typeof r.text === "string" ? r.text : "",
      ageMs: typeof r.ageMs === "number" ? r.ageMs : 0,
    });
  }
  return out;
}

const VERBS: Record<string, string> = {
  ask: "asks",
  review: "asks for a review",
  fix: "asks for a fix",
  bug: "reports a bug",
  info: "says",
  reply: "replies",
  comment: "comments",
  "pr-review": "reviews",
};

export type Tone = "normal" | "dim" | "warn" | "error" | "good";

/** One line of the pane. `answer` makes it a button: digit `key` fills the prompt for request `id`. */
export interface Line {
  text: string;
  tone: Tone;
  /** Peer text under the line, cleaned to one quoted line. */
  quote?: string;
  answer?: { id: string; key: string };
}

export interface Section {
  title: string;
  lines: Line[];
}

export interface PaneView {
  /** `owner/repo · branch`, or a hint when there is no digest. */
  heading: string;
  /** The state of the data: a problem to fix, stale, or fresh. */
  sync: Line;
  sections: Section[];
}

const where = (r: { repo: string; thread?: number }): string =>
  r.thread === undefined ? r.repo : `${r.repo}#${r.thread}`;

const clock = (ms: number): string => new Date(ms).toTimeString().slice(0, 5);

/** The sync line: a problem comes first, then staleness, then the time of the last check. */
function syncLine(problem: string, data: PaneData | undefined): Line {
  if (problem !== "") return { text: problem, tone: "warn" };
  if (data === undefined) return { text: "loading…", tone: "dim" };
  if (data.stale)
    return { text: "data may be stale · refreshing", tone: "warn" };
  return { text: `up to date · checked ${clock(data.atMs)}`, tone: "dim" };
}

function section(title: string, lines: Line[]): Section[] {
  return lines.length === 0 ? [] : [{ title, lines }];
}

const more = (n: number): Line[] =>
  n > 0 ? [{ text: `+${n} more`, tone: "dim" }] : [];

/** Lays the data out. `problem` is the watcher's status line text ("" when sync is healthy). */
export function paneView(
  data: PaneData | undefined,
  problem: string,
): PaneView {
  const d = data?.digest;
  const sync = syncLine(problem, data);
  if (d === undefined)
    return {
      heading: "crew-net",
      sync,
      sections: [],
    };

  const requests = (data?.requests ?? []).slice(0, ANSWER_KEYS);
  const asked = new Set(
    (data?.requests ?? []).map((r) => `${r.from}|${r.thread ?? ""}`),
  );
  const inbox: Line[] = [
    ...requests.map(
      (r, i): Line => ({
        text: `${r.from} ${VERBS[r.event] ?? r.event} on ${where(r)} · ${formatAge(r.ageMs)}`,
        tone: "normal",
        ...(r.text === "" ? {} : { quote: clean(r.text, TEXT_MAX) }),
        answer: { id: r.id, key: String(i + 1) },
      }),
    ),
    ...((data?.requests ?? []).length > ANSWER_KEYS
      ? [
          {
            text: `+${(data?.requests ?? []).length - ANSWER_KEYS} more: crew-net inbox`,
            tone: "dim" as const,
          },
        ]
      : []),
  ];
  const unread: Line[] = [
    // Unread items that are not open requests: replies, comments, reviews.
    ...d.inbox.shown
      .filter((i) => !asked.has(`${i.from}|${i.thread.split("#")[1] ?? ""}`))
      .map(
        (i): Line => ({
          text: `${i.from} ${VERBS[i.kind] ?? i.kind} on ${i.thread} · ${formatAge(i.ageMs)}`,
          tone: "normal",
        }),
      ),
    ...more(d.inbox.hidden),
  ];

  const risky = (marks: string[]): Tone =>
    marks.some((m) => m.includes("conflict")) ? "error" : "warn";
  const marked: Line[] = d.others.shown
    .filter((o) => o.marks.length > 0)
    .map((o) => ({
      text: `${o.owner} ${o.ref} · ${o.marks.join("; ")}`,
      tone: risky(o.marks),
    }));
  const quiet: Line[] = d.others.shown
    .filter((o) => o.marks.length === 0)
    .map((o) => ({
      text: `${o.owner} ${o.ref} · ${o.state}${o.scope ? ` · ${o.scope}` : ""}`,
      tone: "dim" as const,
    }));

  const mine: Line[] = [
    ...d.mine.shown.map(
      (m): Line => ({
        text: [
          `#${m.pr} ${m.state}`,
          m.scope,
          m.dependsOn.length > 0
            ? `depends on ${m.dependsOn.map((x) => `${x.ref} (${x.status})`).join(", ")}`
            : "",
        ]
          .filter((x) => x !== "")
          .join(" · "),
        tone: "normal",
      }),
    ),
    ...d.waitsOnMe.shown.map(
      (w): Line => ({
        text: `${w.ref} (${w.owner}) waits on your #${w.on}`,
        tone: "good",
      }),
    ),
    ...more(d.mine.hidden + d.waitsOnMe.hidden),
  ];

  const waiting: Line[] = [
    ...d.waiting.shown.map(
      (w): Line => ({
        text: `${w.to} on ${w.thread} · ${w.kind} sent ${formatAge(w.ageMs)} ago${w.status === "accepted" ? ", accepted" : ""}`,
        tone: "dim",
      }),
    ),
    ...more(d.waiting.hidden),
  ];

  const merged: Line[] = d.merged.shown.map((m) => ({
    text: `${m.ref} merged · touches your files`,
    tone: "warn" as const,
  }));

  return {
    heading: `${d.repo} · ${d.branch}`,
    sync,
    sections: [
      ...section("Needs your answer", inbox),
      ...section("New", unread),
      ...section("Radar", [...marked, ...merged]),
      ...section("You", mine),
      ...section("Others", [...quiet, ...more(d.others.hidden)]),
      ...section("Waiting on others", waiting),
    ],
  };
}

/**
 * What an answer key puts in the prompt. It names the request by id and sender
 * and carries none of the peer's text: the model reads that with `crew-net
 * inbox`, framed as information.
 */
export function answerPrompt(r: Request): string {
  const verb = VERBS[r.event] ?? r.event;
  return [
    `${r.from} ${verb} on ${where(r)}.`,
    "Read the request with `crew-net inbox`, check what it needs against this repo,",
    `then answer it with \`crew-net reply "${r.id}" "<answer>"\`.`,
  ].join(" ");
}
