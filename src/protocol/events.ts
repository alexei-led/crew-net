export const EVENT_VERSION = 1;

export const ITEM_KINDS = ["message", "finding", "digest"] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** What the mod did with an item. The helper removes the item from its inbox on any outcome. */
export const ACK_OUTCOMES = ["context", "band", "wake", "ignored"] as const;
export type AckOutcome = (typeof ACK_OUTCOMES)[number];

interface Tagged<T extends string> {
  v: typeof EVENT_VERSION;
  type: T;
}

export interface ReadyEvent extends Tagged<"ready"> {}

/** An inbound message, finding or digest. `id` is stable across replays so the mod can dedupe. */
export interface ItemEvent extends Tagged<"item"> {
  id: string;
  kind: ItemKind;
  text: string;
  /** True when the item is addressed to this lead. */
  addressed: boolean;
  /** GitHub login of the sender, for messages. */
  from?: string;
}

export interface StatusEvent extends Tagged<"status"> {
  text: string;
}

export interface ErrorEvent extends Tagged<"error"> {
  message: string;
}

export type HelperEvent = ReadyEvent | ItemEvent | StatusEvent | ErrorEvent;

export interface HelloEvent extends Tagged<"hello"> {
  /** Lead name, without the developer. */
  lead: string;
  claudePid: number;
  cwd: string;
  settings: { autoWake: boolean };
}

export interface AckEvent extends Tagged<"ack"> {
  id: string;
  outcome: AckOutcome;
}

/** A reply to send. `id` lets the helper dedupe a resent post. */
export interface PostEvent extends Tagged<"post"> {
  id: string;
  /** Address line target, `developer` or `developer/name`. */
  to: string;
  body: string;
}

export interface ByeEvent extends Tagged<"bye"> {}

export type ModEvent = HelloEvent | AckEvent | PostEvent | ByeEvent;

export type CrewEvent = HelperEvent | ModEvent;

export type DecodeEventResult =
  | { ok: true; event: CrewEvent }
  | { ok: false; reason: "unknown-version"; version: number }
  | { ok: false; reason: "malformed"; detail: string };

/** One NDJSON line, without the trailing newline. */
export function encodeEvent(event: CrewEvent): string {
  return JSON.stringify(event);
}

type Fields = Record<string, unknown>;

const isString = (value: unknown): value is string => typeof value === "string";
const isBoolean = (value: unknown): value is boolean =>
  typeof value === "boolean";
const isInt = (value: unknown): value is number => Number.isInteger(value);
const oneOf =
  <T extends string>(options: readonly T[]) =>
  (value: unknown): value is T =>
    options.some((option) => option === value);

/** Required fields of each event type with their checks. Unknown fields are ignored. */
const SHAPES: Record<
  CrewEvent["type"],
  Record<string, (value: unknown) => boolean>
> = {
  ready: {},
  item: {
    id: isString,
    kind: oneOf(ITEM_KINDS),
    text: isString,
    addressed: isBoolean,
  },
  status: { text: isString },
  error: { message: isString },
  hello: { lead: isString, claudePid: isInt, cwd: isString },
  ack: { id: isString, outcome: oneOf(ACK_OUTCOMES) },
  post: { id: isString, to: isString, body: isString },
  bye: {},
};

const malformed = (detail: string): DecodeEventResult => ({
  ok: false,
  reason: "malformed",
  detail,
});

/** Parse one NDJSON line. Never throws. A line with another `v` is `unknown-version`. */
export function decodeEvent(line: string): DecodeEventResult {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return malformed("not JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return malformed("not an object");
  }
  const fields = raw as Fields;
  if (!isInt(fields.v)) return malformed("missing v");
  if (fields.v !== EVENT_VERSION)
    return { ok: false, reason: "unknown-version", version: fields.v };
  const type = fields.type;
  if (!isString(type) || !Object.hasOwn(SHAPES, type))
    return malformed("unknown type");
  const shape = SHAPES[type as CrewEvent["type"]];
  for (const [name, check] of Object.entries(shape)) {
    if (!check(fields[name])) return malformed(`bad ${name}`);
  }
  if (type === "item" && fields.from !== undefined && !isString(fields.from)) {
    return malformed("bad from");
  }
  if (type === "hello") {
    const settings = fields.settings as Fields | null | undefined;
    if (
      typeof settings !== "object" ||
      settings === null ||
      !isBoolean(settings.autoWake)
    ) {
      return malformed("bad settings");
    }
  }
  return { ok: true, event: fields as unknown as CrewEvent };
}
