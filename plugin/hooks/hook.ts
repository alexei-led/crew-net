// crew-net's command hooks (hooks.json): the essentials that must work
// without the mod. Digest at session start, new items with each prompt, the
// session heartbeat, and the merge gate on Bash. Bundled to hooks/dist/hook.js.
// All GitHub and store access goes through the CLI shipped in the plugin.
import { spawnSync } from "node:child_process";
import { detectMerge } from "../../src/core/order/index";

export const HOOK_EVENTS = [
  "session-start",
  "prompt-submit",
  "pre-bash",
  "session-end",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface CliResult {
  /** Exit code; null when the CLI could not start, timed out or was killed. */
  code: number | null;
  stdout: string;
}

/** Runs the crew-net CLI with `args` in `cwd`. Never throws. */
export type RunCli = (
  args: readonly string[],
  opts: { cwd: string; timeoutMs: number },
) => CliResult;

export interface HookDeps {
  cli: RunCli;
  /** `CREW_NET_ROLE`; `worker` sessions are never routed to. */
  role: string | undefined;
}

/** What the hook writes: JSON on stdout, or nothing. Exit code is always 0. */
export type HookOutput = Record<string, unknown> | null;

/** Context text above this is cut: the digest and items are short by design. */
export const CONTEXT_MAX = 8_000;
const QUICK_MS = 3_000;
const DIGEST_MS = 5_000;
/** `crew-net gate` reads GitHub live; slower than this counts as a failure. */
export const GATE_TIMEOUT_MS = 20_000;

type Input = Record<string, unknown>;

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value !== "" ? value : undefined;

function sessionFlags(input: Input, deps: HookDeps): string[] | null {
  const session = str(input.session_id);
  if (session === undefined) return null;
  const role = deps.role === "worker" ? "worker" : "lead";
  return ["--session", session, "--harness", "claude-code", "--role", role];
}

function cap(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > CONTEXT_MAX
    ? `${trimmed.slice(0, CONTEXT_MAX - 1)}…`
    : trimmed;
}

/** Stdout of a successful run, else "" (context hooks never fail a prompt). */
function output(result: CliResult): string {
  return result.code === 0 ? result.stdout : "";
}

function context(
  event: "SessionStart" | "UserPromptSubmit",
  parts: string[],
): HookOutput {
  const text = cap(parts.filter((p) => p.trim() !== "").join("\n\n"));
  if (text === "") return null;
  return {
    hookSpecificOutput: { hookEventName: event, additionalContext: text },
  };
}

function sessionStart(input: Input, cwd: string, deps: HookDeps): HookOutput {
  const flags = sessionFlags(input, deps);
  if (flags)
    deps.cli(["session", "beat", ...flags], { cwd, timeoutMs: QUICK_MS });
  // Detached: returns at once; the digest below reads the store only.
  deps.cli(["sync", "--detach"], { cwd, timeoutMs: QUICK_MS });
  const digest = output(
    deps.cli(["--format", "context"], { cwd, timeoutMs: DIGEST_MS }),
  );
  return context("SessionStart", [digest]);
}

function promptSubmit(input: Input, cwd: string, deps: HookDeps): HookOutput {
  const flags = sessionFlags(input, deps);
  if (flags === null) return null;
  deps.cli(["session", "beat", ...flags], { cwd, timeoutMs: QUICK_MS });
  deps.cli(["sync", "--detach"], { cwd, timeoutMs: QUICK_MS });
  // A worker is never a target; its lead speaks for it.
  if (deps.role === "worker") return null;
  const items = output(
    deps.cli(
      ["inbox", "--session", flags[1] ?? "", "--claim", "--format", "context"],
      { cwd, timeoutMs: DIGEST_MS },
    ),
  );
  return context("UserPromptSubmit", [items]);
}

function sessionEnd(input: Input, cwd: string, deps: HookDeps): HookOutput {
  const session = str(input.session_id);
  if (session !== undefined)
    deps.cli(["session", "end", "--session", session], {
      cwd,
      timeoutMs: QUICK_MS,
    });
  return null;
}

const deny = (reason: string): HookOutput => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: `crew-net merge gate: ${reason}`,
  },
});

/** Reads `crew-net gate --json` output; anything but a clear allow is a deny. */
export function gateVerdict(
  result: CliResult,
): { allow: true } | { allow: false; reason: string } {
  const down = "merges are refused while the gate cannot decide";
  if (result.code === null)
    return { allow: false, reason: `the gate did not finish; ${down}` };
  if (result.code !== 0)
    return {
      allow: false,
      reason: `the gate failed (exit ${result.code}); ${down}`,
    };
  let answer: unknown;
  try {
    answer = JSON.parse(result.stdout);
  } catch {
    return { allow: false, reason: `the gate gave no JSON; ${down}` };
  }
  if (typeof answer !== "object" || answer === null)
    return { allow: false, reason: `the gate gave no decision; ${down}` };
  const { decision, reasons } = answer as Record<string, unknown>;
  if (decision === "allow") return { allow: true };
  if (decision === "deny") {
    const why = Array.isArray(reasons)
      ? reasons.filter((r) => typeof r === "string").join("; ")
      : "";
    return { allow: false, reason: why || "depends-on is not satisfied" };
  }
  return { allow: false, reason: `the gate gave no decision; ${down}` };
}

/**
 * The client merge gate (design §11). Commands that cannot merge pass with no
 * output, so the normal permission flow runs. A possible merge goes to
 * `crew-net gate` in the Bash call's cwd. Any doubt denies (fail closed).
 * An allow writes nothing: printing `allow` would skip the permission prompt.
 */
function preBash(input: Input, cwd: string, deps: HookDeps): HookOutput {
  const toolInput = input.tool_input as Input | undefined;
  const command = toolInput?.command;
  if (typeof command !== "string") return deny("cannot read the Bash command");
  const detected = detectMerge(command);
  if (detected.kind === "none") return null;
  if (detected.kind === "deny") return deny(detected.reason);
  const verdict = gateVerdict(
    deps.cli(["gate", "--json", "--", command], {
      cwd,
      timeoutMs: GATE_TIMEOUT_MS,
    }),
  );
  return verdict.allow ? null : deny(verdict.reason);
}

/** Handles one hook event. Never throws for bad input. */
export function handle(
  event: HookEvent,
  input: Input,
  deps: HookDeps,
): HookOutput {
  const cwd = str(input.cwd) ?? ".";
  switch (event) {
    case "session-start":
      return sessionStart(input, cwd, deps);
    case "prompt-submit":
      return promptSubmit(input, cwd, deps);
    case "pre-bash":
      return preBash(input, cwd, deps);
    case "session-end":
      return sessionEnd(input, cwd, deps);
  }
}

/** Parses the hook's stdin; a bad payload is an empty object (pre-bash then denies). */
export function parseInput(raw: string): Input {
  try {
    const value: unknown = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Input)
      : {};
  } catch {
    return {};
  }
}

/** The CLI bundle shipped beside the hooks: `<plugin>/bin/crew-net`. */
export function nodeCli(cliPath: string): RunCli {
  return (args, { cwd, timeoutMs }) => {
    const ran = spawnSync(process.execPath, [cliPath, ...args], {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024,
    });
    if (ran.error !== undefined || ran.signal !== null)
      return { code: null, stdout: "" };
    return { code: ran.status, stdout: ran.stdout ?? "" };
  };
}
