// A fake engine and a fake `crew-net watch` beneath the mod, for
// `claude plugin test`. Every hook here stands for the engine: the mod sits above.
import type {
  On,
  ProcessRunResult,
  ProcessSpawnRequest,
  PromptSubmitInput,
  ToolCallResult,
} from "claude-code";
import type { Engine, Mock, MockClock } from "claude-code/testing";

export const ROOT = "/w/reflex";
export const PID = 4242;
export const MINUTE = 60_000;
export const START_MS = 1_000_000;

/** The band above the prompt, as a surface mounts it. */
export const BAND = {
  plugin: "crew-net",
  component: "AbovePrompt",
  requestId: "band",
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns: 200,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
} as const;

/** The pane, as a surface mounts it. */
export const PANE = {
  plugin: "crew-net",
  component: "Pane",
  requestId: "team",
  props: {
    title: "team",
    isFocused: true,
    bodyColumns: 60,
    placement: "dock",
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const;

export const SURFACES = ["terminal", "desktop"] as const;

/** One watcher NDJSON line. */
export const line = (event: Record<string, unknown>): string =>
  JSON.stringify(event);

/** A crew `ask` from maria on doiteng/reflex#2318, routed here and wakeable. */
export function ask(id = "c-1", extra: Record<string, unknown> = {}): string {
  return line({
    type: "item",
    id,
    kind: "message",
    event: "ask",
    from: "maria",
    repo: "doiteng/reflex",
    thread: 2318,
    text: "Does #2310 need the new users.tier column first?",
    addressed: true,
    wakeable: true,
    ...extra,
  });
}

const ran = (
  stdout: string,
  exitCode = 0,
  stderr = "",
): { value: ProcessRunResult } => ({
  value: {
    exitCode,
    stdout,
    stderr,
    isStdoutTruncated: false,
    isStderrTruncated: false,
  },
});

export interface World {
  clock: MockClock;
  /** Each watcher start: argv, cwd and the stdin it was given. */
  spawns: ProcessSpawnRequest[];
  /** Mod → watcher events sent through `crew-net watch send`. */
  sent: Record<string, unknown>[];
  /** argv of each `watch send`. */
  sendArgv: (readonly string[])[];
  /** Prompts that reached the bottom of the chain. */
  submits: PromptSubmitInput[];
  /** Tool calls that ran (the mod did not refuse them), with their input. */
  ran: Record<string, unknown>[];
  statuses: (string | undefined)[];
  /** Ids of the panes the mod has open. */
  panes: string[];
  /** The surface refuses to place the pane (no surface attached). */
  paneRefused: boolean;
  /** argv after the CLI of each `crew-net reply` the pane posted. */
  posts: string[][];
  /** How `crew-net reply` ends: its exit code and stderr. */
  postResult: { exitCode: number; stderr: string };
  /** argv of each URL opener the pane ran. */
  opened: string[][];
  /** Drafts the mod put in the prompt box. */
  fills: string[];
  /** argv of each `crew-net` call the mod made to read or refresh the pane. */
  reads: (readonly string[])[];
  /** What `crew-net digest --json` and `inbox --json` print. */
  digestJson: string;
  inboxJson: string;
  draft: string;
  sessionId: string;
  /** What `$.session.root()` answers: `/cd` or a worktree move changes it. */
  root: string;
  /** The origin remote `$.session.repo()` answers. */
  remote: string;
  /** Plugin submits stay unsettled until `releaseSubmits`, as one queued behind a running turn. */
  hangPluginSubmits: boolean;
  /** Plugin submits are dropped, as by a hook beneath or the engine. */
  dropPluginSubmits: boolean;
  releaseSubmits: () => void;
  /** Writes lines to the watcher's stdout; resolves once the mod has read them all. */
  emit: (...lines: string[]) => Promise<void>;
  /** Ends the running watcher process. */
  exit: () => Promise<void>;
  /** Resolves once watcher start number `start` (default 1) waits and the mod has read all it wrote. */
  idle: (start?: number) => Promise<void>;
}

/** `mock` is passed in: this file imports nothing from the engine at run time. */
export function world(on: On, mock: Mock): World {
  const clock = mock.clock(on, { now: START_MS });
  mock.env(on, {});
  const queue: string[] = [];
  let ended = false;
  const held: (() => void)[] = [];
  let wake: (() => void) | undefined;
  let waitingStart = 0;
  let waiters: { start: number; resolve: () => void }[] = [];
  const release = () => {
    const done = waiters.filter((x) => waitingStart >= x.start);
    waiters = waiters.filter((x) => waitingStart < x.start);
    for (const x of done) x.resolve();
  };
  const idle = (start = 1) =>
    new Promise<void>((resolve) => {
      waiters.push({ start, resolve });
      release();
    });
  const w: World = {
    clock,
    spawns: [],
    sent: [],
    sendArgv: [],
    submits: [],
    ran: [],
    statuses: [],
    panes: [],
    paneRefused: false,
    posts: [],
    postResult: { exitCode: 0, stderr: "" },
    opened: [],
    fills: [],
    reads: [],
    digestJson: digestJson(),
    inboxJson: JSON.stringify({ unread: [], toMe: [], fromMe: [] }),
    draft: "",
    sessionId: "session-1",
    root: ROOT,
    remote: "git@github.com:doiteng/reflex.git",
    hangPluginSubmits: false,
    dropPluginSubmits: false,
    releaseSubmits: () => {
      for (const r of held.splice(0)) r();
    },
    idle,
    emit: async (...lines) => {
      queue.push(...lines.map((l) => `${l}\n`));
      const start = w.spawns.length;
      waitingStart = 0;
      wake?.();
      await idle(start);
    },
    exit: async () => {
      ended = true;
      waitingStart = 0;
      wake?.();
      await clock.settle();
    },
  };

  on("session.start", (_$, e) => ({ cwd: e.cwd }));
  on("session.end", (_$, e) => ({ sessionId: e.sessionId }));
  on("session.id", () => ({ value: w.sessionId }));
  on("session.root", () => ({ value: w.root }));
  on("session.repo", () => ({
    value: {
      root: "/w/reflex-main",
      remote: w.remote,
      internal: false,
      name: null,
    },
  }));
  on("prompt.read", () => ({
    value: { text: w.draft, cursor: w.draft.length },
  }));
  on("prompt.edit", (_$, e) => ({
    text: e.inputText,
    cursor: e.inputText.length,
  }));
  on("ui.status", (_$, e) => {
    w.statuses.push(e.text);
    return { value: undefined };
  });
  on("ui.open", (_$, e) => {
    if (w.paneRefused)
      return { value: { isPlaced: false, reason: "no-surface" } } as never;
    if (!w.panes.includes(e.id)) w.panes.push(e.id);
    return { value: { isPlaced: true } };
  });
  on("ui.close", (_$, e) => {
    w.panes = w.panes.filter((id) => id !== e.id);
    return { value: undefined };
  });
  on("ui.panes", () => ({
    value: w.panes.map((id) => ({
      id,
      title: id,
      isShown: true,
      isFocused: true,
      isPlaced: true,
    })),
  }));
  on("command.list", () => ({
    value: [
      {
        name: "crew-net:team",
        description: "",
        source: "plugin",
        plugin: "crew-net",
      },
    ],
  }));
  // What runs when the mod lets `/team` through: the plugin's markdown command.
  on("command.run", () => ({ text: "DIGEST" }));
  on("prompt.fill", (_$, e) => {
    w.fills.push(e.text);
    return { isFilled: true } as never;
  });
  on("ui.log", () => ({ value: undefined }));
  // Beneath the mod: another plugin's band (pi-crew's) draws a line there.
  on("ui.render", ($, e) => {
    const { Box, Text } = $.ui.resolve(e);
    return e.component === "AbovePrompt"
      ? Box({ children: [Text({ children: "below the band" })] })
      : Box({ children: [] });
  });
  on("turn.start", (_$, e) => ({ turnId: e.turnId }));
  on("turn.complete", () => ({ text: "" }));
  on("tool.call", (_$, e) => {
    w.ran.push({ ...e });
    return { result: "ran" as never };
  });
  on("prompt.submit", (_$, e) => {
    w.submits.push(e);
    const entered =
      e.context === undefined
        ? { text: e.text, origin: e.origin }
        : { text: e.text, context: e.context, origin: e.origin };
    if (e.origin.kind === "plugin" && w.dropPluginSubmits)
      return { drop: "refused" };
    if (e.origin.kind === "plugin" && w.hangPluginSubmits)
      return new Promise<typeof entered>((resolve) => {
        held.push(() => resolve(entered));
      });
    return entered;
  });
  on("process.run", (_$, e) => {
    const [cmd, , sub, action] = e.argv;
    if (cmd === "sh") return ran(`${PID}\n`);
    if (cmd === "open" || cmd === "xdg-open") {
      w.opened.push([...e.argv]);
      return ran("");
    }
    if (sub === "reply") {
      w.posts.push(e.argv.slice(2));
      return ran("", w.postResult.exitCode, w.postResult.stderr);
    }
    if (sub === "watch" && action === "send") {
      w.sendArgv.push(e.argv);
      for (const l of (e.init?.stdin ?? "").split("\n").filter(Boolean))
        w.sent.push(JSON.parse(l));
      return ran("");
    }
    if (sub === "digest" || sub === "inbox" || sub === "sync") {
      w.reads.push(e.argv);
      return ran(
        sub === "digest" ? w.digestJson : sub === "inbox" ? w.inboxJson : "",
      );
    }
    throw new Error(`unexpected process.run ${e.argv.join(" ")}`);
  });
  // The fake watcher. The mod pulls the next piece only after it handled the
  // last, so a watcher waiting with nothing left means the mod is done.
  on("process.spawn", async function* (_$, e, next) {
    const start = w.spawns.push(e);
    ended = false;
    try {
      while (!next.signal.aborted) {
        const text = queue.shift();
        if (text !== undefined) {
          yield { stream: "stdout", text };
          continue;
        }
        if (ended) {
          ended = false;
          return { value: { code: 1, signal: null } };
        }
        waitingStart = start;
        release();
        await new Promise<void>((resolve) => {
          wake = resolve;
          next.signal.addEventListener("abort", () => resolve());
        });
      }
      return { value: { code: null, signal: "SIGTERM" } };
    } finally {
      queue.length = 0;
      for (const x of waiters.splice(0)) x.resolve();
    }
  });
  return w;
}

/** The mod's acks, by item id (the last one wins). */
export function acks(w: World): Record<string, unknown> {
  return Object.fromEntries(
    w.sent.filter((e) => e.type === "ack").map((e) => [e.id, e.outcome]),
  );
}

/** An interactive session starts and its watcher runs. */
export async function start($: Engine, w: World): Promise<void> {
  await $.session.start({
    cwd: ROOT,
    surface: "terminal",
    isInteractive: true,
  });
  await w.idle();
}

/**
 * Past the idle window. The fake watcher exits first: moving the clock under
 * its open stream can stall the kit. The supervisor restarts it after backoff.
 */
export async function goIdle(w: World, minutes = 11): Promise<void> {
  const starts = w.spawns.length;
  await w.exit();
  await w.clock.advance(minutes * MINUTE);
  await w.idle(starts + 1);
}

/** Mounts the band; the watcher exits first (a mount outlasts a piece's budget). */
export async function mountBand(
  $: Engine,
  w: World,
  surface: (typeof SURFACES)[number],
) {
  await w.exit();
  return $.ui.mount({ ...BAND, surface });
}

export function userPrompt($: Engine, text: string) {
  return $.prompt.submit({ text, origin: { kind: "composer" }, wait: false });
}

export function bash($: Engine, command: string) {
  return $.tool.call({ tool: "Bash", command });
}

/** The refusal a caller sees, or undefined when the tool ran. */
export function denied(result: ToolCallResult): string | undefined {
  return (
    result.deny ?? (result.isError === true ? (result.text ?? "") : undefined)
  );
}

const section = (shown: unknown[] = []) => ({ shown, hidden: 0 });

/** What `crew-net digest --json` prints: one PR of mine, one of maria's that conflicts. */
export function digestJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    digest: {
      repo: "doiteng/reflex",
      branch: "feat/users-tier",
      mine: section([
        { pr: 2310, state: "building", scope: "api/openapi/", dependsOn: [] },
      ]),
      waitsOnMe: section(),
      others: section([
        {
          owner: "maria",
          ref: "#2318",
          state: "review",
          scope: "users.yaml",
          marks: ["conflicts with #2310: users.yaml"],
        },
      ]),
      merged: section(),
      inbox: section(),
      waiting: section(),
      ...extra,
    },
    text: "",
    stale: false,
    refreshing: false,
  });
}

/** `crew-net inbox --json` with one open ask from maria. */
export function inboxJson(extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    unread: [],
    toMe: [
      {
        id: "comment:github.com/doiteng/reflex#2318:1",
        event: "ask",
        from: "maria",
        repo: "doiteng/reflex",
        thread: 2318,
        text: "Does #2310 need the new users.tier column first?",
        ageMs: 12 * 60_000,
        ...extra,
      },
    ],
    fromMe: [],
  });
}

/** Mounts the pane; the watcher exits first, as for the band. */
export async function mountPane(
  $: Engine,
  w: World,
  surface: (typeof SURFACES)[number],
) {
  await w.exit();
  return $.ui.mount({ ...PANE, surface });
}

/** The person types `/team` (with `args`). */
export function team($: Engine, args = "", command = "team") {
  return $.command.run({
    command,
    args,
    origin: { kind: "composer" },
    presentation: { isFullscreen: true, columns: 200 },
  });
}
