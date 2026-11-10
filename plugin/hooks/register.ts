// The crew-net mod: the band, the watcher child, delivery and wake turns for
// one Claude Code session (design: Delivery, Trust and autonomy, Harness adapters). Decisions are core's
// (delivery.decide, trust.gate); this file turns engine events into their
// inputs and their answers into engine calls. The essentials (digest, prompt
// context, merge gate) are command hooks and work without this mod.
// Bundled to hooks/dist/register.js. `$` is passed by that name everywhere:
// the engine reads it only as `$`.
import type { EngineInterface, On, PluginOptions } from "claude-code";
import {
  DEFAULT_DELIVERY_SETTINGS,
  type DeliverySettings,
  decide,
  type SessionSignals,
} from "../../src/core/delivery/index";
import { gate } from "../../src/core/trust/index";
import {
  type AckOutcome,
  decodeEvent,
  encodeEvent,
  type HelloEvent,
  type ItemEvent,
  type ModEvent,
} from "../../src/protocol/index";
import type {
  CrewNetBandEntry,
  CrewNetPending,
  CrewNetSession,
} from "../types/index";
import {
  backoffMs,
  bandText,
  frame,
  inRoot,
  LineSplitter,
  nextFailures,
  readItem,
  repoFromRemote,
  restartStatus,
  ticker,
  wakePrompt,
} from "./mod";
import {
  answerPrompt,
  PANE_ID,
  type PaneData,
  paneView,
  parseDigest,
  parseRequests,
  type Tone,
} from "./pane";

type Engine = EngineInterface;

/** The CLI shipped in the plugin. */
const CLI = "bin/crew-net";
const NODE = "node";
const BAND_KEEP = 20;
const SEEN_KEEP = 500;
const SEND_TIMEOUT_MS = 10_000;
/** Re-decide held requests and check for /clear this often. */
const TICK_MS = 30_000;
/** Columns the pane asks for when docked beside a fullscreen transcript. */
const PANE_COLUMNS = 60;
/** A manual refresh waits for one sync pass. */
const SYNC_TIMEOUT_MS = 120_000;
/** Missed `ifVersion` writes before `change` gives up. */
const CHANGE_ATTEMPTS = 20;

const INITIAL: CrewNetSession = {
  sessionId: "",
  band: [],
  pending: [],
  seen: [],
  wake: { token: null, turnId: null, ref: "", ownPr: false },
  lastWakeAtMs: 0,
  turnId: null,
  ownTurnId: null,
  status: "",
};

async function readSession($: Engine): Promise<CrewNetSession> {
  const { value } = await $.state.get({ plugin: "crew-net", key: "session" });
  // A value an older mod kept may lack newer fields.
  return { ...INITIAL, ...value };
}

/** Read, apply, write with `ifVersion`; again on a miss, so racing writes all land. */
async function change(
  $: Engine,
  fn: (s: CrewNetSession) => CrewNetSession,
): Promise<CrewNetSession> {
  for (let attempt = 0; attempt < CHANGE_ATTEMPTS; attempt++) {
    const held = await $.state.get({ plugin: "crew-net", key: "session" });
    const next = fn({ ...INITIAL, ...held.value });
    const written = await $.state.set(
      { plugin: "crew-net", key: "session" },
      next,
      { ifVersion: held.version },
    );
    if (written.isSet) return next;
  }
  throw new Error("crew-net: session state kept changing; write dropped");
}

/** The watcher connection of this module load; a hot reload starts over. */
interface Run {
  gen: number;
  cli: string;
  root: string;
  repo: string;
  hello: HelloEvent;
  settings: DeliverySettings;
  stop?: () => void;
}

let run: Run | undefined;
let generation = 0;
// Session signals in module variables: a reload loses them, and the load
// time counts as activity, so a reload never wakes a session at once.
let lastTypingMs: number | undefined;
let lastUserPromptMs: number | undefined;
/** The developer's last prompt, to tell their turn from an armed wake. */
let lastComposerText: string | undefined;
/** What the pane shows: the last refresh. A reload loses it and the pane loads it again. */
let paneData: PaneData | undefined;
let paneRefreshing = false;

function ignore(): void {}

function log($: Engine, text: string): void {
  $.ui.log(`crew-net: ${text}`, { to: "debug" });
}

function settingsOf(options: PluginOptions): DeliverySettings {
  const { autoWake, idleMinutes } = options;
  return {
    autoWake:
      autoWake === "off" || autoWake === "reply"
        ? autoWake
        : DEFAULT_DELIVERY_SETTINGS.autoWake,
    idleMinutes:
      typeof idleMinutes === "number" && idleMinutes > 0
        ? idleMinutes
        : DEFAULT_DELIVERY_SETTINGS.idleMinutes,
  };
}

function nonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function bandEntry(
  id: string,
  kind: CrewNetBandEntry["kind"],
  text: string,
  atMs: number,
): (s: CrewNetSession) => CrewNetSession {
  return (s) => ({
    ...s,
    band: [
      ...s.band.filter((b) => !(b.id === id && b.kind === kind)),
      { id, kind, text, atMs },
    ].slice(-BAND_KEEP),
  });
}

/** Mod → watcher events go through a short-lived `crew-net watch send`: the watcher's stdin closes after hello. */
async function send($: Engine, r: Run, events: ModEvent[]): Promise<void> {
  try {
    const ran = await $.process.run(
      [NODE, r.cli, "watch", "send", "--session", r.hello.session],
      {
        cwd: r.root,
        stdin: events.map((e) => `${encodeEvent(e)}\n`).join(""),
        timeoutMs: SEND_TIMEOUT_MS,
      },
    );
    if (ran.exitCode !== 0) log($, `watch send exited ${ran.exitCode}`);
  } catch (error) {
    log($, `watch send failed: ${String(error)}`);
  }
}

async function signals($: Engine, s: CrewNetSession): Promise<SessionSignals> {
  const out: SessionSignals = {
    starting: false,
    draft: (await $.prompt.read()).text,
    turnRunning: s.turnId !== null || s.wake.token !== null,
  };
  if (lastTypingMs !== undefined) out.lastTypingMs = lastTypingMs;
  if (lastUserPromptMs !== undefined) out.lastUserPromptMs = lastUserPromptMs;
  if (s.lastWakeAtMs > 0) out.lastWakeAtMs = s.lastWakeAtMs;
  return out;
}

/** Arms and submits a wake turn for `p`. The submit is never awaited: it queues behind a running turn. */
async function wake($: Engine, p: CrewNetPending): Promise<boolean> {
  const token = nonce();
  const nowMs = await $.clock.now();
  let armed = false;
  await change($, (s) => {
    armed =
      s.wake.token === null && s.wake.turnId === null && s.turnId === null;
    if (!armed) return s;
    return {
      ...s,
      wake: { token, turnId: null, ref: p.ref, ownPr: p.ownPr },
      lastWakeAtMs: nowMs,
      pending: s.pending.filter((x) => x.id !== p.id),
    };
  });
  if (!armed) return false;
  await change(
    $,
    bandEntry(p.id, "wake", `woke this session for ${p.ref}`, nowMs),
  );
  // A wake that never starts gives the request back to the next prompt.
  const undo = async (why: string): Promise<void> => {
    log($, `wake for ${p.id} ${why}`);
    const at = await $.clock.now();
    await change($, (s) =>
      s.wake.token === token
        ? {
            ...s,
            wake: { ...INITIAL.wake },
            pending: [...s.pending, { ...p, wakeable: false }],
          }
        : s,
    );
    await change(
      $,
      bandEntry(p.id, "wake", `wake failed for ${p.ref} · next prompt`, at),
    );
  };
  void $.prompt
    .submit({ text: wakePrompt(p.framed, p.ref, token) })
    .then((result) =>
      result.drop === undefined ? undefined : undo(`dropped: ${result.drop}`),
    )
    .catch((error: unknown) => undo(`failed: ${String(error)}`))
    .catch(ignore);
  return true;
}

/** Re-decides held requests (design: Delivery: an ask held by a running turn or the cooldown wakes once those clear). */
async function recheck($: Engine, r: Run): Promise<void> {
  const s = await readSession($);
  const candidates = s.pending.filter((p) => p.wakeable);
  if (candidates.length === 0) return;
  const sig = await signals($, s);
  const nowMs = await $.clock.now();
  for (const p of candidates) {
    const actions = decide(
      { kind: p.request, wakeable: p.wakeable },
      sig,
      r.settings,
      nowMs,
    );
    if (actions.includes("wake")) {
      await wake($, p);
      return;
    }
  }
}

async function onItem($: Engine, r: Run, event: ItemEvent): Promise<void> {
  const s = await readSession($);
  const prior = s.seen.find((x) => x.id === event.id);
  if (prior) {
    // A replay: the earlier ack did not reach the watcher.
    await send($, r, [{ type: "ack", id: event.id, outcome: prior.outcome }]);
    return;
  }
  const item = readItem(event);
  const nowMs = await $.clock.now();
  let outcome: AckOutcome = "band";
  if (item.kind !== "digest") {
    // The digest reached the model through the SessionStart hook; here it is band only.
    const pending: CrewNetPending = {
      id: item.id,
      framed: frame(item, nonce()),
      request: item.request,
      wakeable: item.wakeable,
      ref: item.ref,
      ownPr: item.ownPr,
    };
    const actions = decide(
      { kind: item.request, wakeable: item.wakeable },
      await signals($, s),
      r.settings,
      nowMs,
    );
    await change($, (x) => ({ ...x, pending: [...x.pending, pending] }));
    outcome =
      actions.includes("wake") && (await wake($, pending)) ? "wake" : "context";
  }
  await change($, (x) => ({
    ...bandEntry(item.id, "item", bandText(item, outcome), nowMs)(x),
    seen: [...x.seen, { id: item.id, outcome }].slice(-SEEN_KEEP),
  }));
  await send($, r, [{ type: "ack", id: item.id, outcome }]);
}

async function onLine($: Engine, r: Run, line: string): Promise<void> {
  const decoded = decodeEvent(line);
  if (!decoded.ok) {
    log($, `malformed watcher line (${decoded.detail})`);
    return;
  }
  const event = decoded.event;
  switch (event.type) {
    // Healthy is silent: the status line shows a problem and its fix, nothing else.
    case "ready":
      $.ui.status(undefined);
      await change($, (s) => ({ ...s, status: "" }));
      return;
    case "status":
      $.ui.status(event.text === "" ? undefined : event.text);
      await change($, (s) => ({ ...s, status: event.text }));
      refreshSoon($);
      return;
    case "error": {
      const nowMs = await $.clock.now();
      await change($, bandEntry("watcher", "error", event.message, nowMs));
      return;
    }
    case "item":
      await onItem($, r, event);
      refreshSoon($);
      return;
    default:
      log($, `unexpected ${event.type} event from the watcher`);
  }
}

/** Runs the watcher for `r`; restarts it with backoff until superseded. */
async function supervise($: Engine, r: Run): Promise<void> {
  const current = () => r.gen === generation;
  for (let failures = 0; current(); ) {
    const startedAt = await $.clock.now();
    if (!current()) return;
    const stream = $.process.spawn({
      argv: [NODE, r.cli, "watch", "--session", r.hello.session],
      cwd: r.root,
      // Written once, then stdin closes; the watcher keeps running.
      input: `${encodeEvent(r.hello)}\n`,
    });
    r.stop = () => {
      stream.return({ code: null, signal: "SIGTERM" }).catch(ignore);
    };
    const lines = new LineSplitter();
    try {
      for await (const chunk of stream) {
        if (!current()) break;
        if (chunk.stream === "stderr") {
          log($, `watch: ${chunk.text.trimEnd()}`);
          continue;
        }
        for (const line of lines.push(chunk.text)) {
          if (!current()) break;
          await onLine($, r, line);
        }
      }
    } catch (error) {
      log($, `watcher failed: ${String(error)}`);
    }
    if (!current()) return;
    failures = nextFailures(failures, (await $.clock.now()) - startedAt);
    const waitMs = backoffMs(failures - 1);
    const down = restartStatus(waitMs, failures);
    $.ui.status(down);
    await change($, (s) => ({ ...s, status: down })).catch(ignore);
    await $.clock.sleep(waitMs);
  }
}

/**
 * Reads the digest and my open requests for the pane (`crew-net digest --json`
 * and `inbox --json`, both from the local store) and redraws it. `sync` runs
 * one sync pass first, for the pane's refresh key.
 */
async function refresh($: Engine, sync = false): Promise<void> {
  const r = run;
  if (r === undefined || paneRefreshing) return;
  paneRefreshing = true;
  try {
    const opts = { cwd: r.root, timeoutMs: SEND_TIMEOUT_MS };
    if (sync)
      await $.process.run([NODE, r.cli, "sync", "--once"], {
        ...opts,
        timeoutMs: SYNC_TIMEOUT_MS,
      });
    const repo = r.repo === "" ? [] : ["--repo", r.repo];
    const [digest, inbox] = await Promise.all([
      $.process.run([NODE, r.cli, "digest", "--json"], opts),
      $.process.run([NODE, r.cli, "inbox", "--json", ...repo], opts),
    ]);
    const parsed = parseDigest(digest.stdout);
    if (parsed !== undefined)
      paneData = {
        ...parsed,
        requests: parseRequests(inbox.stdout),
        atMs: await $.clock.now(),
      };
    else log($, `digest --json exited ${digest.exitCode}: unreadable`);
  } catch (error) {
    log($, `pane refresh failed: ${String(error)}`);
  } finally {
    paneRefreshing = false;
  }
  $.ui.invalidate("ui.render");
}

/** True when a plugin other than crew-net defines a slash command named `crew`. */
async function otherOwnsCrew($: Engine): Promise<boolean> {
  const commands = await $.command.list();
  return commands.some((c) => c.name === "crew" && c.plugin !== "crew-net");
}

/** A watcher event may have changed what the pane shows; look again only while it is open. */
function refreshSoon($: Engine): void {
  $.ui
    .panes()
    .then((panes) =>
      panes.some((p) => p.id === PANE_ID) ? refresh($) : undefined,
    )
    .catch(ignore);
}

function stopWatcher(): void {
  generation += 1;
  run?.stop?.();
  run = undefined;
}

function startWatcher($: Engine, r: Run): void {
  stopWatcher();
  r.gen = generation;
  run = r;
  supervise($, r).catch((error: unknown) =>
    log($, `supervisor ended: ${String(error)}`),
  );
}

async function claudePid($: Engine): Promise<number | undefined> {
  // The parent of a $.process.run child is the Claude process.
  const ran = await $.process.run(["sh", "-c", "echo $PPID"]);
  const pid = Number.parseInt(ran.stdout.trim(), 10);
  return Number.isInteger(pid) && pid > 1 ? pid : undefined;
}

async function connect($: Engine, options: PluginOptions): Promise<void> {
  const settings = settingsOf(options);
  const session = await $.session.id();
  const root = await $.session.root();
  const repo = repoFromRemote((await $.session.repo())?.remote ?? null);
  const pid = await claudePid($);
  if (pid === undefined) {
    $.ui.status("watcher not started: cannot read the session pid");
    return;
  }
  const role =
    (await $.env.get("CREW_NET_ROLE")) === "worker" ? "worker" : "lead";
  const hello: HelloEvent = {
    type: "hello",
    session,
    role,
    harness: "claude-code",
    worktree: root,
    pid,
    settings: { autoWake: settings.autoWake === "reply" },
  };
  if (repo !== undefined) hello.repo = repo;
  await change($, (s) => ({ ...s, sessionId: session }));
  lastTypingMs ??= await $.clock.now();
  startWatcher($, {
    gen: 0,
    cli: `${$.plugin.root}/${CLI}`,
    root,
    repo: repo ?? "",
    hello,
    settings,
  });
}

/**
 * After /clear the id changes and no session.start fires; `/cd` or a
 * worktree move changes the root. Either way the watcher starts again for
 * the new id, in the new worktree.
 */
async function followSession($: Engine): Promise<void> {
  const r = run;
  if (r === undefined) return;
  const id = await $.session.id();
  const root = await $.session.root();
  if (id === r.hello.session && root === r.root) return;
  if (id !== r.hello.session) await change($, (s) => ({ ...s, sessionId: id }));
  const { stop: _old, repo: _repo, hello: _hello, ...rest } = r;
  const { repo: _helloRepo, ...base } = r.hello;
  // A new root may be another repo; the wake gate checks against it.
  const repo =
    root === r.root
      ? r.repo
      : (repoFromRemote((await $.session.repo())?.remote ?? null) ?? "");
  startWatcher($, {
    ...rest,
    root,
    repo,
    hello: {
      ...base,
      session: id,
      worktree: root,
      ...(repo ? { repo } : {}),
    },
  });
}

async function tick($: Engine): Promise<void> {
  await followSession($);
  if (run) await recheck($, run);
  refreshSoon($);
}

export function register(on: On, options: PluginOptions): void {
  on("session.start", async ($, e, next) => {
    const started = await next(e);
    if (e.isInteractive) {
      await connect($, options);
      $.clock.every(TICK_MS, () => {
        tick($).catch(ignore);
      });
    }
    return started;
  });

  on("session.end", (_$, e, next) => {
    // /clear keeps the process: the tick follows the new session id.
    if (e.reason !== "clear") stopWatcher();
    return next(e);
  });

  on("prompt.edit", ($, e, next) => {
    // Per keystroke: never delay the edit.
    $.clock
      .now()
      .then((t) => {
        lastTypingMs = t;
      })
      .catch(ignore);
    return next(e);
  });

  on("prompt.submit", async ($, e, next) => {
    if (e.origin.kind !== "composer") return next(e);
    lastUserPromptMs = await $.clock.now();
    lastComposerText = e.text;
    await followSession($);
    if (e.command !== undefined) return next(e);
    const queued = (await readSession($)).pending;
    if (queued.length === 0) return next(e);
    const result = await next({
      ...e,
      context: [...(e.context ?? []), ...queued.map((p) => p.framed)],
    });
    if (result.drop === undefined) {
      const ids = new Set(queued.map((p) => p.id));
      // The band announced these; the prompt has now carried them to Claude.
      await change($, (s) => ({
        ...s,
        pending: s.pending.filter((p) => !ids.has(p.id)),
        band: s.band.filter((b) => !(b.kind === "item" && ids.has(b.id))),
      }));
    }
    return result;
  });

  on("turn.start", async ($, e, next) => {
    if (e.agentId !== undefined) return next(e);
    const ownPrompt =
      lastComposerText !== undefined && e.text === lastComposerText;
    if (ownPrompt) lastComposerText = undefined;
    await change($, (s) => {
      const armed = s.wake.token;
      // Only the turn carrying the token is the wake turn. Any other turn
      // while a wake is armed stays gated (tool.call) unless it is plainly
      // the developer's own prompt; the token stays armed for the real one.
      const isWake = armed !== null && e.text.includes(armed);
      return {
        ...s,
        turnId: e.turnId,
        ownTurnId: ownPrompt ? e.turnId : null,
        wake: isWake ? { ...s.wake, token: null, turnId: e.turnId } : s.wake,
      };
    });
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const done = await next(e);
    if (e.agentId === undefined) {
      await change($, (s) => ({
        ...s,
        turnId: s.turnId === e.turnId ? null : s.turnId,
        ownTurnId: s.ownTurnId === e.turnId ? null : s.ownTurnId,
        wake: s.wake.turnId === e.turnId ? { ...INITIAL.wake } : s.wake,
      }));
      if (run) await recheck($, run);
    }
    return done;
  });

  // The wake tool gate (design: Trust and autonomy). Fails closed: a gate that throws denies.
  on("tool.call", async ($, e, next) => {
    const s = await readSession($);
    const ownTurn = s.turnId !== null && s.ownTurnId === s.turnId;
    // Fail closed: the wake turn, and while a wake is armed any turn that is
    // not plainly the developer's own.
    const gated = s.wake.turnId !== null || (s.wake.token !== null && !ownTurn);
    if (!gated) return next(e);
    const r = run;
    const input: Record<string, unknown> = { ...e };
    const verdict = gate(
      { tool: String(e.tool), input },
      {
        kind: "wake",
        root: r?.root ?? "",
        repo: r?.repo ?? "",
        item: s.wake.ref,
        hasOwnPr: s.wake.ownPr,
      },
    );
    if (verdict.decision === "deny")
      return { deny: `crew-net wake turn: ${verdict.reason}` };
    if (e.tool !== "Bash") return next(e);
    // The gate allowed this command for the worktree; run it there.
    const command = inRoot(r?.root ?? "", e.command);
    if (command === null)
      return { deny: "crew-net wake turn: the worktree path cannot be quoted" };
    return next({ ...e, command });
  }).catch((_$, e, next) =>
    next.called
      ? next(e)
      : { deny: "crew-net wake turn: the tool gate failed; refused" },
  );

  // The band: one line for what is new, the rest is in the pane.
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    const line = ticker((await readSession($)).band);
    if (line === undefined) return next(e);
    const { Box, Button, Text } = $.ui.resolve(e);
    // The text shrinks and is cut with an ellipsis; the way to the pane and
    // the button keep their width.
    const fixed = { flexShrink: 0 };
    return Box({
      gap: 1,
      children: [
        Box({
          flexShrink: 1,
          children: [
            Text({
              wrap: "truncate-end",
              ...(line.error ? { color: "error" as const } : {}),
              children: `crew-net · ${line.text}`,
            }),
          ],
        }),
        Box({
          ...fixed,
          children: [
            Text({
              dimColor: true,
              children: line.more > 0 ? `+${line.more} more · /crew` : "/crew",
            }),
          ],
        }),
        Box({
          ...fixed,
          children: [
            Button({
              key: "dismiss",
              label: "Dismiss",
              onPress: () =>
                change($, (x) => ({ ...x, band: [] })).then(ignore),
            }),
          ],
        }),
      ],
    });
  });

  // `/crew` opens the pane, and a second `/crew` closes it. Without a mod, or
  // when no surface draws a pane, the command falls through to the digest text.
  for (const command of ["crew", "crew-net:crew"]) {
    on("command.run", { command }, async ($, e, next) => {
      if (e.args.trim() !== "" || run === undefined) return next(e);
      // Another plugin may own the bare `/crew`: leave it alone.
      if (command === "crew" && (await otherOwnsCrew($))) return next(e);
      if ((await $.ui.panes()).some((p) => p.id === PANE_ID)) {
        await $.ui.close({ id: PANE_ID });
        return {};
      }
      const opened = await $.ui.open({
        id: PANE_ID,
        title: "crew-net",
        focus: true,
        closeOnEscape: true,
        columns: PANE_COLUMNS,
      });
      if (!opened.isPlaced) return next(e);
      // Opening the pane is reading the band.
      await change($, (s) => ({ ...s, band: [] }));
      void refresh($);
      return {};
    });
  }

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e);
    if (paneData === undefined) void refresh($);
    const view = paneView(paneData, (await readSession($)).status);
    const { Box, Button, Text } = $.ui.resolve(e);
    const tone = (t: Tone) =>
      t === "dim"
        ? { dimColor: true }
        : t === "warn"
          ? { color: "warning" as const }
          : t === "error"
            ? { color: "error" as const }
            : t === "good"
              ? { color: "success" as const }
              : {};
    const requests = new Map(
      (paneData?.requests ?? []).map((q) => [q.id, q] as const),
    );
    return Box({
      flexDirection: "column",
      paddingX: 1,
      children: [
        Text({ bold: true, children: view.heading }),
        Text({
          ...tone(view.sync.tone),
          children: view.sync.text,
        }),
        ...(view.sections.length === 0
          ? [
              Text({
                dimColor: true,
                children: paneData ? "Nothing to report." : "",
              }),
            ]
          : []),
        ...view.sections.map((section) =>
          Box({
            key: `section:${section.title}`,
            flexDirection: "column",
            marginTop: 1,
            children: [
              Text({ bold: true, children: section.title }),
              ...section.lines.map((l, i) => {
                const q = l.answer ? requests.get(l.answer.id) : undefined;
                const text = Text({
                  ...tone(l.tone),
                  children: l.text,
                });
                return Box({
                  key: `line:${section.title}:${i}`,
                  flexDirection: "column",
                  children: [
                    text,
                    ...(l.quote
                      ? [
                          Text({
                            dimColor: true,
                            wrap: "truncate-end",
                            children: `  "${l.quote}"`,
                          }),
                        ]
                      : []),
                    ...(l.answer && q
                      ? [
                          Button({
                            key: `answer:${l.answer.key}`,
                            label: "answer with Claude",
                            hotkey: l.answer.key,
                            plain: true,
                            onPress: async () => {
                              await $.prompt.fill({ text: answerPrompt(q) });
                              await $.ui.close({ id: PANE_ID });
                            },
                          }),
                        ]
                      : []),
                  ],
                });
              }),
            ],
          }),
        ),
        Box({
          marginTop: 1,
          gap: 2,
          children: [
            Button({
              key: "refresh",
              label: "refresh",
              hotkey: "r",
              plain: true,
              onPress: () => refresh($, true),
            }),
            Text({ dimColor: true, children: "esc closes" }),
          ],
        }),
      ],
    });
  });
}
