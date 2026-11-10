// crew-net's state contract: what the mod keeps in $.state for the session.
// Self-contained (no imports), as the engine requires.

/** One line of the band above the prompt. Peer text is kept as a cleaned one-line preview. */
export type CrewNetBandEntry = {
  id: string;
  /** `item`: an inbound item; `wake`: a wake turn started; `error`: from the watcher. */
  kind: "item" | "wake" | "error";
  text: string;
  atMs: number;
  /** The shared glyph (design: Shared screen with pi-crew). Absent in entries an older mod kept. */
  glyph?: string;
};

/** An item already handled, with the ack outcome to send again on a replay. */
export type CrewNetSeen = {
  id: string;
  outcome: "context" | "band" | "wake" | "ignored";
};

/** Framed text waiting for the next user prompt, and what may still wake for it. */
export type CrewNetPending = {
  id: string;
  framed: string;
  /** A crew request routed here: re-decided on each tick until a prompt takes it. */
  request: string;
  wakeable: boolean;
  /** `crew-net reply` takes this; the wake gate allows replies to it only. */
  ref: string;
  ownPr: boolean;
};

/**
 * The wake turn. `token` is the nonce in the submitted wake prompt; `turnId` is
 * set when the turn carrying the token starts and cleared when it completes.
 * The wake gate applies during that turn and, while `token` is armed, to any
 * turn that is not the developer's own prompt.
 */
export type CrewNetWake = {
  token: string | null;
  turnId: string | null;
  /** The item the wake answers, as `crew-net reply` names it. */
  ref: string;
  ownPr: boolean;
};

export type CrewNetSession = {
  /** The session id the watcher runs for; a change means /clear. */
  sessionId: string;
  band: CrewNetBandEntry[];
  pending: CrewNetPending[];
  seen: CrewNetSeen[];
  wake: CrewNetWake;
  /** Start of the last wake turn, epoch ms; 0 for none. */
  lastWakeAtMs: number;
  /** The main loop's running turn; null when idle. */
  turnId: string | null;
  /** The running main turn when it is the developer's own prompt; null otherwise. */
  ownTurnId: string | null;
  /** What is wrong with sync, as the status line shows it; empty when sync is healthy. */
  status: string;
};

declare module "claude-code" {
  interface PluginState {
    "crew-net": {
      session: CrewNetSession;
    };
  }
}
