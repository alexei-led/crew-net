export type ItemKind = "message" | "finding" | "digest";

/** One inbound item, as far as the delivery rules care. */
export interface DeliveryItem {
  kind: ItemKind;
  /** Addressed to this lead. */
  addressed: boolean;
  /** Needs an answer or a decision now, for example a contract-path finding. */
  blocking: boolean;
}

/** What the mod knows about the session. Timestamps are epoch ms. */
export interface SessionSignals {
  /** Text in the prompt box, from `$.prompt.read()`. */
  draft: string;
  /** Last `prompt.edit` event, if any. */
  lastEditMs?: number;
  /** Last user `prompt.submit`, if any. Plugin submits do not count. */
  lastUserPromptMs?: number;
}

export interface DeliverySettings {
  /** Minutes without typing or a user prompt before the session counts as idle. */
  idleMinutes: number;
  autoWake: boolean;
}

export const DEFAULT_DELIVERY_SETTINGS: DeliverySettings = {
  idleMinutes: 10,
  autoWake: true,
};

/**
 * hold: keep for later, band only. inject: attach as context to the next user
 * prompt. wake: submit a wake turn now. band: show only in the band.
 * Every action also shows the item in the band.
 */
export type Action = "hold" | "inject" | "wake" | "band";

const MS_PER_MINUTE = 60_000;

const isRecent = (
  at: number | undefined,
  nowMs: number,
  windowMs: number,
): boolean => at !== undefined && nowMs - at < windowMs;

/** Active means a human is driving: a non-empty draft, or recent typing or prompt. */
export function isActive(
  signals: SessionSignals,
  settings: DeliverySettings,
  nowMs: number,
): boolean {
  if (signals.draft.trim() !== "") return true;
  const windowMs = settings.idleMinutes * MS_PER_MINUTE;
  return (
    isRecent(signals.lastEditMs, nowMs, windowMs) ||
    isRecent(signals.lastUserPromptMs, nowMs, windowMs)
  );
}

/**
 * Decide what to do with one inbound item now.
 * - Active session, addressed or blocking item: inject on the next prompt.
 * - Active session, anything else: hold.
 * - Idle, addressed or blocking message or finding: wake if auto-wake is on,
 *   else inject on the next prompt.
 * - Idle, anything else (including digests): band.
 * A draft always makes the session active, so a wake never happens with one.
 */
export function decide(
  item: DeliveryItem,
  signals: SessionSignals,
  settings: Partial<DeliverySettings>,
  nowMs: number,
): Action {
  const resolved = { ...DEFAULT_DELIVERY_SETTINGS, ...settings };
  const wants = item.kind !== "digest" && (item.addressed || item.blocking);
  if (isActive(signals, resolved, nowMs)) return wants ? "inject" : "hold";
  if (!wants) return "band";
  return resolved.autoWake ? "wake" : "inject";
}
