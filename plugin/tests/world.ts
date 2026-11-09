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

const ran = (stdout: string, exitCode = 0): { value: ProcessRunResult } => ({
  value: {
    exitCode,
    stdout,
    stderr: "",
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
  draft: string;
  sessionId: string;
  /** What `$.session.root()` answers: `/cd` or a worktree move changes it. */
  root: string;
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
    draft: "",
    sessionId: "session-1",
    root: ROOT,
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
      remote: "git@github.com:doiteng/reflex.git",
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
  on("ui.log", () => ({ value: undefined }));
  on("ui.render", ($, e) => {
    const { Box } = $.ui.resolve(e);
    return Box({ children: [] });
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
    if (sub === "watch" && action === "send") {
      w.sendArgv.push(e.argv);
      for (const l of (e.init?.stdin ?? "").split("\n").filter(Boolean))
        w.sent.push(JSON.parse(l));
      return ran("");
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
