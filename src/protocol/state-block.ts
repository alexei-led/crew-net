import { LOGIN_PATTERN, NAME_PATTERN } from "./address";
import {
  type ClosingKeywordMatch,
  findClosingKeywords,
} from "./closing-keywords";

export const STATE_BLOCK_VERSION = 1;

export const PR_STATES = ["planning", "building", "review", "blocked"] as const;
export type PrState = (typeof PR_STATES)[number];

/** The machine-readable block in a draft PR body. */
export interface StateBlock {
  /** Address of the owning lead, `developer/name`. */
  lead: string;
  state: PrState;
  /** Paths the work expects to touch. */
  scope: string[];
  /** PR refs: `#N` or `owner/repo#N`. */
  dependsOn: string[];
}

/** Result of reading a block. A missing block is `null`, not a result. */
export type ParseStateBlockResult =
  | { ok: true; state: StateBlock }
  | { ok: false; reason: "unsupported-version"; version: number }
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
        | { reason: "unsupported-version"; version: number };
    };

const BLOCK = /<!--[ \t]*crew-net[ \t]+v(\d+)(?:\.\d+)*\b([\s\S]*?)-->/;
const REF = /^(?:[\w.-]+\/[\w.-]+)?#\d+$/;
const LEAD = new RegExp(`^${LOGIN_PATTERN}/${NAME_PATTERN}$`);

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

const list = (value: string | undefined): string[] =>
  (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

function readBlock(match: RegExpExecArray): ParseStateBlockResult {
  const version = Number(match[1]);
  if (version > STATE_BLOCK_VERSION)
    return { ok: false, reason: "unsupported-version", version };
  if (version < STATE_BLOCK_VERSION) {
    return { ok: false, reason: "malformed", detail: `version ${version}` };
  }
  const fields = readFields(match[2] ?? "");
  const lead = fields.get("lead");
  if (!lead) return { ok: false, reason: "malformed", detail: "missing lead" };
  const state = PR_STATES.find((s) => s === fields.get("state"));
  if (!state)
    return {
      ok: false,
      reason: "malformed",
      detail: "missing or unknown state",
    };
  const dependsOn = list(fields.get("depends-on"));
  const badRef = dependsOn.find((ref) => !REF.test(ref));
  if (badRef !== undefined) {
    return {
      ok: false,
      reason: "malformed",
      detail: `bad depends-on ref ${badRef}`,
    };
  }
  return {
    ok: true,
    state: { lead, state, scope: list(fields.get("scope")), dependsOn },
  };
}

/**
 * Read the first `<!-- crew-net v1 ... -->` block. Unknown fields are ignored.
 * Returns null when the body has no block. Never throws.
 */
export function parseStateBlock(body: string): ParseStateBlockResult | null {
  const match = BLOCK.exec(body);
  return match ? readBlock(match) : null;
}

const breaksComment = (value: string): boolean => /[\r\n]|-->/.test(value);

function invalid(field: string, detail: string): RenderStateBlockResult {
  return { ok: false, error: { reason: "invalid", field, detail } };
}

/**
 * Write a block. Refuses a block that holds a closing keyword (the repo's
 * `pr-body-keywords` check scans HTML comments) or a value that would break
 * the comment or the field syntax.
 */
export function renderStateBlock(state: StateBlock): RenderStateBlockResult {
  if (!LEAD.test(state.lead)) return invalid("lead", "expected developer/name");
  if (!PR_STATES.includes(state.state))
    return invalid("state", "unknown state");
  for (const path of state.scope) {
    if (!path || path.includes(",") || breaksComment(path))
      return invalid("scope", path);
  }
  for (const ref of state.dependsOn) {
    if (!REF.test(ref)) return invalid("depends-on", ref);
  }
  const lines = [
    `<!-- crew-net v${STATE_BLOCK_VERSION}`,
    `lead: ${state.lead}`,
    `state: ${state.state}`,
  ];
  if (state.scope.length) lines.push(`scope: ${state.scope.join(", ")}`);
  if (state.dependsOn.length)
    lines.push(`depends-on: ${state.dependsOn.join(", ")}`);
  lines.push("-->");
  const block = lines.join("\n");
  const matches = findClosingKeywords(block);
  if (matches.length)
    return { ok: false, error: { reason: "closing-keyword", matches } };
  return { ok: true, block };
}

/**
 * Put `state` into a PR body: replace the existing block in place, or append
 * one when there is none. Other text is untouched. Refuses to overwrite a block
 * of a higher major version.
 */
export function replaceStateBlock(
  body: string,
  state: StateBlock,
): ReplaceStateBlockResult {
  const rendered = renderStateBlock(state);
  if (!rendered.ok) return rendered;
  const match = BLOCK.exec(body);
  if (!match) {
    const separator = body === "" ? "" : body.endsWith("\n") ? "\n" : "\n\n";
    return { ok: true, body: `${body}${separator}${rendered.block}\n` };
  }
  const existing = readBlock(match);
  if (!existing.ok && existing.reason === "unsupported-version") {
    return {
      ok: false,
      error: { reason: "unsupported-version", version: existing.version },
    };
  }
  return {
    ok: true,
    body:
      body.slice(0, match.index) +
      rendered.block +
      body.slice(match.index + match[0].length),
  };
}
