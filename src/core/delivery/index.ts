/** Item kinds that may start a wake turn: crew requests addressed to me. */
export const WAKE_KINDS = ["ask", "review", "fix", "bug"] as const;

/** One inbound item, as far as delivery cares. */
export interface DeliveryItem {
  /** Message kind (`ask`, `reply`, …) or another inbound kind (`comment`, `finding`, …). */
  kind: string;
  /** From routing: false when the session was picked only because no session is in the item's repo. */
  wakeable: boolean;
}

/** What the adapter knows about the session. Timestamps are epoch ms. */
export interface SessionSignals {
  /** The session is starting: session start, `/clear` or resume. */
  starting: boolean;
  /** Text in the prompt box. */
  draft: string;
  /** Last keystroke in the prompt box. */
  lastTypingMs?: number;
  /** Last prompt the user submitted. Plugin-submitted turns do not count. */
  lastUserPromptMs?: number;
  /** A turn is running, user or plugin (a wake turn included). */
  turnRunning: boolean;
  /** Start of the last wake turn. */
  lastWakeAtMs?: number;
}

export interface DeliverySettings {
  /** Minutes without typing or a user prompt before the session counts as idle. */
  idleMinutes: number;
  autoWake: "reply" | "off";
}

export const DEFAULT_DELIVERY_SETTINGS: DeliverySettings = {
  idleMinutes: 10,
  autoWake: "reply",
};

/** At most one wake turn per this many minutes per session. */
export const WAKE_COOLDOWN_MINUTES = 10;

/**
 * `digest`: fold into the start digest (context and band).
 * `band`: show in the band now.
 * `inject-next-prompt`: attach as context to the next user prompt.
 * `wake`: start a wake turn now.
 */
export type Action = "digest" | "band" | "inject-next-prompt" | "wake";

const MS_PER_MINUTE = 60_000;

const within = (
  at: number | undefined,
  nowMs: number,
  minutes: number,
): boolean => at !== undefined && nowMs - at < minutes * MS_PER_MINUTE;

/** Active: a draft, typing or a user prompt within the idle window, or a running turn. */
export function isActive(
  signals: SessionSignals,
  settings: DeliverySettings,
  nowMs: number,
): boolean {
  return (
    signals.turnRunning ||
    signals.draft.trim() !== "" ||
    within(signals.lastTypingMs, nowMs, settings.idleMinutes) ||
    within(signals.lastUserPromptMs, nowMs, settings.idleMinutes)
  );
}

const isWakeKind = (kind: string): boolean =>
  (WAKE_KINDS as readonly string[]).includes(kind);

/**
 * Decide what to do with one inbound item now (design §9.4).
 * - Starting: `digest`.
 * - Wake: idle, a crew request (`ask review fix bug`), wakeable route,
 *   auto-wake `reply`, and no wake turn in the last 10 min: `band` + `wake`.
 * - Otherwise: `band` + `inject-next-prompt`.
 * A running turn (a wake turn included) makes the session active.
 * The decision holds only for `nowMs`: callers run it again on each tick for
 * every item not yet delivered, so an ask held back by a running turn or the
 * wake cooldown wakes the session once those clear.
 */
export function decide(
  item: DeliveryItem,
  signals: SessionSignals,
  settings: Partial<DeliverySettings>,
  nowMs: number,
): Action[] {
  const resolved: DeliverySettings = {
    idleMinutes: settings.idleMinutes ?? DEFAULT_DELIVERY_SETTINGS.idleMinutes,
    autoWake: settings.autoWake ?? DEFAULT_DELIVERY_SETTINGS.autoWake,
  };
  if (signals.starting) return ["digest"];
  const wake =
    resolved.autoWake === "reply" &&
    item.wakeable &&
    isWakeKind(item.kind) &&
    !isActive(signals, resolved, nowMs) &&
    !within(signals.lastWakeAtMs, nowMs, WAKE_COOLDOWN_MINUTES);
  return wake ? ["band", "wake"] : ["band", "inject-next-prompt"];
}
