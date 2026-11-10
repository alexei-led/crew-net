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
  bandGlyph,
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
  type Decision,
  decisionArgs,
  detailView,
  FRAME,
  GLYPH,
  PANE_ID,
  type PaneData,
  paneView,
  parseDigest,
  parseRequests,
  type Request,
  replyArgs,
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
/** The pane's view: the request open in detail, a decision waiting to be confirmed, the last action's result. */
let paneSelected: string | undefined;
let paneConfirm: Decision | undefined;
let paneNote: { text: string; tone: Tone } | undefined;

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
  glyph?: string,
): (s: CrewNetSession) => CrewNetSession {
  return (s) => ({
    ...s,
    band: [
      ...s.band.filter((b) => !(b.id === id && b.kind === kind)),
      { id, kind, text, atMs, ...(glyph === undefined ? {} : { glyph }) },
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
    ...bandEntry(
      item.id,
      "item",
      bandText(item, outcome),
      nowMs,
      bandGlyph(item),
    )(x),
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

  // The band: one line for what is new, the rest is in the pane. It sits above
  // what the next renderer draws, so another plugin's band (pi-crew's) still
  // shows (design: Shared screen with pi-crew).
  on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e);
    const line = ticker((await readSession($)).band);
    const below = await next(e);
    if (line === undefined) return below;
    const { Box, Button, Text } = $.ui.resolve(e);
    // The text shrinks and is cut with an ellipsis; the counts and the
    // buttons keep their width.
    const fixed = { flexShrink: 0 };
    const rest = line.rest.map((r) => `${r.glyph} ${r.count}`).join(" · ");
    const color =
      line.error || line.glyph === GLYPH.problem
        ? { color: "error" as const }
        : line.glyph === GLYPH.needsYou
          ? { color: "warning" as const }
          : {};
    const band = Box({
      key: "crew-net-band",
      gap: 1,
      children: [
        Box({
          ...fixed,
          children: [Text({ dimColor: true, children: "team ·" })],
        }),
        Box({
          flexShrink: 1,
          children: [
            Text({
              wrap: "truncate-end",
              ...color,
              children: `${line.glyph} ${line.text}`,
            }),
          ],
        }),
        ...(rest === ""
          ? []
          : [
              Box({
                ...fixed,
                children: [Text({ dimColor: true, children: `· ${rest}` })],
              }),
            ]),
        Box({
          ...fixed,
          children: [
            Button({
              key: "team",
              label: "team",
              hotkey: "t",
              plain: true,
              onPress: () => openPane($).then(ignore),
            }),
          ],
        }),
        Box({
          ...fixed,
          children: [
            Button({
              key: "dismiss",
              label: "dismiss",
              hotkey: "d",
              plain: true,
              onPress: () =>
                change($, (x) => ({ ...x, band: [] })).then(ignore),
            }),
          ],
        }),
      ],
    });
    return below === undefined || below === null
      ? band
      : Box({ flexDirection: "column", children: [band, below] });
  });

  // `/team` opens the pane, and a second `/team` closes it. Without a mod, or
  // when no surface draws a pane, the command falls through to the digest text.
  for (const command of ["team", "crew-net:team"]) {
    on("command.run", { command }, async ($, e, next) => {
      if (e.args.trim() !== "" || run === undefined) return next(e);
      if ((await $.ui.panes()).some((p) => p.id === PANE_ID)) {
        await $.ui.close({ id: PANE_ID });
        return {};
      }
      return (await openPane($)) ? {} : next(e);
    });
  }

  on("ui.render", { component: "Pane" }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e);
    if (paneData === undefined) void refresh($);
    const { Box, Button, Input, Text } = $.ui.resolve(e);
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
    const redraw = () => $.ui.invalidate("ui.render");
    const note = paneNote
      ? [Text({ ...tone(paneNote.tone), children: paneNote.text })]
      : [];
    const keys = (...extra: ReturnType<typeof Button>[]) =>
      Box({
        key: "keys",
        marginTop: 1,
        gap: 2,
        children: [
          ...extra,
          Button({
            key: "refresh",
            label: "refresh",
            hotkey: "r",
            plain: true,
            onPress: () => refresh($, true),
          }),
          Button({
            key: "close",
            label: "close",
            hotkey: "q",
            plain: true,
            onPress: () => $.ui.close({ id: PANE_ID }).then(ignore),
          }),
        ],
      });

    const selected =
      paneSelected === undefined
        ? undefined
        : paneData?.requests.find((q) => q.id === paneSelected);
    if (selected !== undefined) {
      const v = detailView(selected);
      const decide = (d: Decision) =>
        Button({
          key: d,
          label: d,
          hotkey: d === "accept" ? "y" : "n",
          plain: true,
          onPress: () => {
            paneConfirm = d;
            redraw();
          },
        });
      return Box({
        flexDirection: "column",
        paddingX: 1,
        children: [
          Text({ bold: true, color: "warning", children: v.heading }),
          ...(v.url ? [Text({ dimColor: true, children: v.url })] : []),
          Box({
            key: "text",
            flexDirection: "column",
            marginTop: 1,
            children: [
              Text({ dimColor: true, children: FRAME }),
              Text({ children: `"${v.quote}"` }),
            ],
          }),
          Box({
            key: "actions",
            marginTop: 1,
            gap: 2,
            children: [
              Button({
                key: "answer",
                label: "answer with Claude",
                hotkey: "a",
                plain: true,
                onPress: async () => {
                  await $.prompt.fill({ text: answerPrompt(selected) });
                  await $.ui.close({ id: PANE_ID });
                },
              }),
              ...(v.canDecide ? [decide("accept"), decide("decline")] : []),
              ...(v.url
                ? [
                    Button({
                      key: "open",
                      label: "open on GitHub",
                      hotkey: "o",
                      plain: true,
                      onPress: () => openUrl($, v.url ?? "").then(ignore),
                    }),
                  ]
                : []),
            ],
          }),
          ...(paneConfirm === undefined
            ? []
            : [
                Box({
                  key: "confirm",
                  marginTop: 1,
                  gap: 2,
                  children: [
                    Text({
                      color: "warning",
                      children: `Post "${paneConfirm}" on GitHub as you?`,
                    }),
                    Button({
                      key: "confirm",
                      label: "confirm",
                      hotkey: "c",
                      plain: true,
                      onPress: () =>
                        post(
                          $,
                          selected,
                          decisionArgs(selected, paneConfirm ?? "accept"),
                        ),
                    }),
                    Button({
                      key: "cancel",
                      label: "cancel",
                      hotkey: "v",
                      plain: true,
                      onPress: () => {
                        paneConfirm = undefined;
                        redraw();
                      },
                    }),
                  ],
                }),
              ]),
          Box({
            key: "reply",
            marginTop: 1,
            children: [
              Input({
                key: `reply:${selected.id}`,
                placeholder: `reply to ${selected.from} on GitHub as you · Enter posts`,
                submitLabel: "post",
                rows: 2,
                onSubmit: (value) => {
                  const args = replyArgs(selected, value);
                  if (args !== undefined) void post($, selected, args);
                },
              }),
            ],
          }),
          ...note,
          keys(
            Button({
              key: "back",
              label: "back",
              hotkey: "b",
              plain: true,
              onPress: () => {
                showList();
                redraw();
              },
            }),
          ),
        ],
      });
    }

    const view = paneView(paneData, (await readSession($)).status);
    return Box({
      flexDirection: "column",
      paddingX: 1,
      children: [
        Text({ bold: true, children: view.heading }),
        Text({ ...tone(view.sync.tone), children: view.sync.text }),
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
              ...section.lines.map((l, i) =>
                Box({
                  key: `line:${section.title}:${i}`,
                  flexDirection: "column",
                  children: [
                    l.open
                      ? Button({
                          key: `open:${l.open.key}`,
                          label: l.text,
                          hotkey: l.open.key,
                          plain: true,
                          onPress: () => {
                            showList();
                            paneSelected = l.open?.id;
                            redraw();
                          },
                        })
                      : Text({ ...tone(l.tone), children: l.text }),
                    ...(l.quote
                      ? [
                          Text({
                            dimColor: true,
                            wrap: "truncate-end",
                            children: `  "${l.quote}"`,
                          }),
                        ]
                      : []),
                  ],
                }),
              ),
            ],
          }),
        ),
        ...note,
        keys(),
      ],
    });
  });
}

/** Back to the list, with no decision pending. */
function showList(): void {
  paneSelected = undefined;
  paneConfirm = undefined;
  paneNote = undefined;
}

/** Opens the pane on the list; false when no surface places it. */
async function openPane($: Engine): Promise<boolean> {
  if ((await $.ui.panes()).some((p) => p.id === PANE_ID)) return true;
  const opened = await $.ui.open({
    id: PANE_ID,
    title: "team",
    focus: true,
    closeOnEscape: true,
    columns: PANE_COLUMNS,
  });
  if (!opened.isPlaced) return false;
  showList();
  // Opening the pane is reading the band.
  await change($, (s) => ({ ...s, band: [] }));
  void refresh($);
  return true;
}

/**
 * Posts what the developer chose in the pane: `crew-net reply` with their
 * decision or their text. The CLI checks the text (no closing keyword) and
 * the write budget; its refusal is shown under the actions.
 */
async function post($: Engine, r: Request, args: string[]): Promise<void> {
  const cli = run;
  if (cli === undefined) return;
  paneConfirm = undefined;
  try {
    const ran = await $.process.run([NODE, cli.cli, ...args], {
      cwd: cli.root,
      timeoutMs: SEND_TIMEOUT_MS,
    });
    if (ran.exitCode === 0) {
      showList();
      paneNote = { text: `${GLYPH.done} posted to ${r.from}`, tone: "good" };
      await refresh($);
      return;
    }
    const why = (ran.stderr.trim().split("\n")[0] ?? "").slice(0, 160);
    paneNote = {
      text: `${GLYPH.problem} not posted: ${why || `exit ${ran.exitCode}`}`,
      tone: "error",
    };
  } catch (error) {
    paneNote = {
      text: `${GLYPH.problem} not posted: ${String(error)}`,
      tone: "error",
    };
  }
  $.ui.invalidate("ui.render");
}

/** Opens a GitHub URL in the browser: `open` on macOS, `xdg-open` elsewhere. */
async function openUrl($: Engine, url: string): Promise<void> {
  for (const opener of ["open", "xdg-open"]) {
    const ran = await $.process
      .run([opener, url], { timeoutMs: SEND_TIMEOUT_MS })
      .catch(() => undefined);
    if (ran?.exitCode === 0) return;
  }
  paneNote = { text: `open ${url} in a browser`, tone: "dim" };
  $.ui.invalidate("ui.render");
}
