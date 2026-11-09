import {
  type ClosingKeywordMatch,
  findClosingKeywords,
} from "./closing-keywords";

export const PR_STATES = ["planning", "building", "review", "blocked"] as const;
export type PrState = (typeof PR_STATES)[number];

/** A field this reader models. Everything else is kept as an `extra` field. */
const KNOWN_FIELDS = new Set(["state", "scope", "depends-on", "lead"]);

/** One field the reader does not model. Written back unchanged. */
export interface ExtraField {
  /** Lowercase key, as read. */
  key: string;
  value: string;
}

/** The machine-readable block in a PR or Issue body. */
export interface StateBlock {
  /** Missing or unrecognised `state`. Then the work item's state comes from draft or ready. */
  state?: PrState;
  /** Paths the work expects to touch. */
  scope: string[];
  /** PR refs: `#N` or `owner/repo#N`. */
  dependsOn: string[];
  /** Fields this reader does not know, in document order. */
  extra: ExtraField[];
}

/** A value the reader skipped. The rest of the block is still usable. */
export interface StateBlockWarning {
  field: string;
  value: string;
  detail: string;
}

/** Result of reading a block. A missing block is `null`, not a result. */
export type ParseStateBlockResult =
  | { ok: true; state: StateBlock; warnings: StateBlockWarning[] }
  | { ok: false; reason: "malformed"; detail: string };

export type RenderStateBlockError =
  | { reason: "closing-keyword"; matches: ClosingKeywordMatch[] }
  | { reason: "invalid"; field: string; detail: string };

export type RenderStateBlockResult =
  | { ok: true; block: string }
  | { ok: false; error: RenderStateBlockError };

export type ReplaceStateBlockResult =
  | { ok: true; body: string }
  | {
      ok: false;
      error:
        | RenderStateBlockError
        | { reason: "unreadable-block"; detail: string };
    };

/** Opening tag. The tag must be followed by whitespace or the closing `-->`, so `<!-- crew-net:msg` does not match. */
const OPEN = /<!--\s*crew-net(?=\s|-->)/i;
const CLOSE = "-->";
const REF = /^(?:[\w.-]+\/[\w.-]+)?#\d+$/;
const KEY = /^[a-z][a-z0-9-]*$/;

/** Any spelling of the dependency key, to catch one that is not alone on its line. */
const DEPENDS_ON_MENTION = /depends[-_ ]?on[ \t]*:/gi;

/** Version tag of the old format: `v1`, `v1.3`. Read and dropped. */
const LEGACY_TAG = /^v\d+(?:\.\d+)*(?=\s|$)/;

function readFields(inner: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const line of inner.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    if (key && !fields.has(key)) fields.set(key, line.slice(colon + 1).trim());
  }
  return fields;
}

/** Fields this reader does not model, first occurrence of each key. Keys that could not be written back are dropped. */
function readExtras(fields: Map<string, string>): ExtraField[] {
  return [...fields]
    .filter(([key]) => KEY.test(key) && !KNOWN_FIELDS.has(key))
    .map(([key, value]) => ({ key, value }));
}

const list = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

/** Lines whose key is exactly `depends-on`. */
const dependsOnLines = (inner: string): number =>
  inner.split("\n").filter((line) => {
    const colon = line.indexOf(":");
    return (
      colon >= 0 && line.slice(0, colon).trim().toLowerCase() === "depends-on"
    );
  }).length;

function readBlock(inner: string): ParseStateBlockResult {
  const text = inner.trimStart().replace(LEGACY_TAG, "");
  const fields = readFields(text);
  const warnings: StateBlockWarning[] = [];

  // `state: review depends-on: #2` on one line, a bullet, `depends_on:` or a
  // repeated key would otherwise read as "no dependency".
  const lines = dependsOnLines(text);
  if ((text.match(DEPENDS_ON_MENTION)?.length ?? 0) !== lines || lines > 1) {
    warnings.push({
      field: "depends-on",
      value: "",
      detail: "must be one `depends-on:` line of its own",
    });
  }

  const rawState = fields.get("state");
  const state = PR_STATES.find((s) => s === rawState);
  if (rawState !== undefined && state === undefined) {
    warnings.push({
      field: "state",
      value: rawState,
      detail: "unknown state",
    });
  }

  // Bad refs are dropped here. The gate must still fail closed on them: see warnings.
  const dependsOn: string[] = [];
  for (const ref of list(fields.get("depends-on"))) {
    if (REF.test(ref)) dependsOn.push(ref);
    else warnings.push({ field: "depends-on", value: ref, detail: "bad ref" });
  }

  return {
    ok: true,
    state: {
      ...(state === undefined ? {} : { state }),
      scope: list(fields.get("scope")),
      dependsOn,
      extra: readExtras(fields),
    },
    warnings,
  };
}

type Located =
  | { start: number; end: number; inner: string }
  | { detail: string };

/**
 * Find the one block in `body`. A second opening, or a `<!--` inside the
 * block, means the span cannot be trusted: a prose mention of the format would
 * hide the real block or make a rewrite eat text.
 */
function locate(body: string): Located | null {
  const open = OPEN.exec(body);
  if (!open) return null;
  const innerStart = open.index + open[0].length;
  const end = body.indexOf(CLOSE, innerStart);
  if (end < 0) return { detail: "unterminated block" };
  const inner = body.slice(innerStart, end);
  if (inner.includes("<!--")) return { detail: "comment inside the block" };
  if (OPEN.test(body.slice(end + CLOSE.length)))
    return { detail: "more than one state block" };
  return { start: open.index, end: end + CLOSE.length, inner };
}

/**
 * Read the crew-net state block. Accepts the unversioned form and the old
 * `<!-- crew-net v1 ... -->` form. `lead` is accepted and ignored. Unknown
 * fields are kept. A bad value is skipped and reported in `warnings`, so the
 * rest of the block still reads. Returns null only when no block opens: an
 * unterminated, nested or repeated block is `malformed`. Never throws.
 */
export function parseStateBlock(body: string): ParseStateBlockResult | null {
  const found = locate(body);
  if (!found) return null;
  if ("detail" in found)
    return { ok: false, reason: "malformed", detail: found.detail };
  return readBlock(found.inner);
}

const breaksComment = (value: string): boolean => /[\r\n]|-->/.test(value);

function invalid(field: string, detail: string): RenderStateBlockResult {
  return { ok: false, error: { reason: "invalid", field, detail } };
}

function validExtra(field: ExtraField): string | null {
  if (!KEY.test(field.key) || KNOWN_FIELDS.has(field.key)) return "bad key";
  if (breaksComment(field.value) || field.value !== field.value.trim())
    return "bad value";
  return null;
}

/**
 * Write a block. Refuses a block that holds a closing keyword (the repo's
 * `pr-body-keywords` check scans HTML comments) or a value that would break
 * the comment or the field syntax.
 */
export function renderStateBlock(state: StateBlock): RenderStateBlockResult {
  if (state.state !== undefined && !PR_STATES.includes(state.state))
    return invalid("state", "unknown state");
  for (const path of state.scope) {
    if (!path || path.includes(",") || breaksComment(path))
      return invalid("scope", path);
  }
  for (const ref of state.dependsOn) {
    if (!REF.test(ref)) return invalid("depends-on", ref);
  }
  for (const field of state.extra) {
    const detail = validExtra(field);
    if (detail) return invalid(`extra:${field.key}`, detail);
  }
  const lines = ["<!-- crew-net"];
  if (state.state !== undefined) lines.push(`state: ${state.state}`);
  if (state.scope.length) lines.push(`scope: ${state.scope.join(", ")}`);
  if (state.dependsOn.length)
    lines.push(`depends-on: ${state.dependsOn.join(", ")}`);
  for (const { key, value } of state.extra) lines.push(`${key}: ${value}`);
  lines.push("-->");
  const block = lines.join("\n");
  const matches = findClosingKeywords(block);
  if (matches.length)
    return { ok: false, error: { reason: "closing-keyword", matches } };
  return { ok: true, block };
}

/**
 * Put a state into a PR body: replace the existing block in place, or append
 * one when there is none. Other text is untouched. Unknown fields of the
 * existing block are kept. `lead` is dropped. Refuses to write over a block
 * it cannot delimit (unterminated, nested or repeated), because it would eat text.
 */
export function replaceStateBlock(
  body: string,
  state: Omit<StateBlock, "extra">,
): ReplaceStateBlockResult {
  const found = locate(body);
  if (!found) {
    const rendered = renderStateBlock({ ...state, extra: [] });
    if (!rendered.ok) return rendered;
    const separator = body === "" ? "" : body.endsWith("\n") ? "\n" : "\n\n";
    return { ok: true, body: `${body}${separator}${rendered.block}\n` };
  }
  if ("detail" in found)
    return {
      ok: false,
      error: { reason: "unreadable-block", detail: found.detail },
    };
  const existing = readBlock(found.inner);
  if (!existing.ok)
    return {
      ok: false,
      error: { reason: "unreadable-block", detail: existing.detail },
    };
  const rendered = renderStateBlock({ ...state, extra: existing.state.extra });
  if (!rendered.ok) return rendered;
  return {
    ok: true,
    body: body.slice(0, found.start) + rendered.block + body.slice(found.end),
  };
}
