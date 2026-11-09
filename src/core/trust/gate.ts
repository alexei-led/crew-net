/** A tool call as the harness reports it: tool name and its input. Bash keeps the line in `input.command`. */
export interface ToolCall {
  tool: string;
  input?: Readonly<Record<string, unknown>>;
}

/** The PR a session owns. */
export interface OwnPr {
  /** `owner/name`. */
  repo: string;
  number: number;
}

export type Turn =
  /** The developer drives the turn. The merge gate still applies; this gate does not. */
  | { kind: "normal" }
  | {
      kind: "wake";
      /** Absolute path of the session's worktree. Reads stay inside it. */
      root: string;
      /** The waking item, as `crew-net reply` names it. The only item a reply may answer. */
      item: string;
      /** The session's own PR; `crew-net state` may only change it. None: `state` is denied. */
      ownPr?: OwnPr;
    };

export type ToolDecision =
  | { decision: "allow" }
  | { decision: "deny"; reason: string };

const ALLOW: ToolDecision = { decision: "allow" };
const deny = (reason: string): ToolDecision => ({ decision: "deny", reason });

type WakeTurn = Extract<Turn, { kind: "wake" }>;

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

/**
 * Split a command line into words, the way bash would, or refuse. Refused:
 * anything that chains, redirects, expands or substitutes (`$` and backticks
 * outside single quotes), globs and brace lists (`* ? [ { }`), a leading `~`,
 * comments, and a backslash outside quotes. Inside double quotes a backslash
 * escapes only `$`, backtick, `"` and `\`, as in bash.
 */
function tokenize(line: string): { words: string[] } | { error: string } {
  const words: string[] = [];
  let word: string | null = null;
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
      continue;
    }
    if (c === "`") return { error: "backtick command substitution" };
    if (c === "$") return { error: "shell expansion" };
    if (quote === '"') {
      if (c === '"') {
        quote = null;
      } else if (c === "\\") {
        const next = line.charAt(i + 1);
        if ('$`"\\'.includes(next) && next !== "") {
          word += next;
          i++;
        } else {
          word += c;
        }
      } else {
        word += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      word ??= "";
    } else if (/[;&|<>()\n\r]/.test(c)) {
      return { error: `shell operator ${JSON.stringify(c)}` };
    } else if (c === "\\") {
      return { error: "backslash escape outside quotes" };
    } else if ("*?[]{}".includes(c)) {
      return {
        error: `unquoted ${JSON.stringify(c)} (glob or brace expansion)`,
      };
    } else if (c === "#" && word === null) {
      return { error: "comment" };
    } else if (c === "~" && (word === null || /[=:]$/.test(word))) {
      return { error: "tilde expansion" };
    } else if (c === " ") {
      if (word !== null) words.push(word);
      word = null;
    } else {
      word = (word ?? "") + c;
    }
  }
  if (quote) return { error: "unterminated quote" };
  if (word !== null) words.push(word);
  return { words };
}

/** A flag is boolean (`true`) or takes one value checked by the validator. */
type FlagSpec = ReadonlyMap<string, true | ((value: string) => boolean)>;

interface ArgRules {
  flags: FlagSpec;
  /** Accept `-<N>` as a flag (git log). */
  countFlag?: boolean;
  /** Validator for positional words; omit for none allowed. */
  positional?: (word: string, index: number) => boolean;
  maxPositional?: number;
  minPositional?: number;
}

const matches =
  (re: RegExp) =>
  (value: string): boolean =>
    re.test(value);

const INT = matches(/^\d{1,6}$/);
const JSON_FIELDS = matches(/^[A-Za-z][A-Za-z0-9,]*$/);

/** Refs and repo-relative paths: no leading `-`, `~` or `/`, no `..` segment, no shell glob characters. */
function safeRefOrPath(word: string): boolean {
  return (
    /^[A-Za-z0-9_.@^:+=%][A-Za-z0-9_./@^~:+=%-]*$/.test(word) &&
    !word.split("/").includes("..")
  );
}

/** jq builtins a read may use. Anything else, `env` and `input` among them, is refused. */
const JQ_FUNCTIONS = new Set([
  "add",
  "all",
  "and",
  "any",
  "ascii_downcase",
  "ascii_upcase",
  "contains",
  "elif",
  "else",
  "empty",
  "end",
  "endswith",
  "false",
  "first",
  "flatten",
  "group_by",
  "has",
  "if",
  "join",
  "keys",
  "last",
  "length",
  "map",
  "max",
  "min",
  "not",
  "null",
  "or",
  "reverse",
  "select",
  "sort",
  "sort_by",
  "startswith",
  "test",
  "then",
  "tonumber",
  "tostring",
  "true",
  "type",
  "unique",
  "unique_by",
  "values",
]);

/**
 * A `--jq` filter that only reshapes the response. No `$` (variables,
 * `$ENV`), no backslash (string interpolation), no `@` formats, no `;`, and
 * every bare identifier is a listed builtin. `.name` field access is fine.
 */
function safeJq(expr: string): boolean {
  if (!/^[A-Za-z0-9_ .[\]|,:"=!<>()+-]+$/.test(expr)) return false;
  const code = expr.replace(/"[^"]*"/g, "0");
  if (code.includes('"')) return false;
  for (const m of code.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
    const at = m.index;
    const field = code.charAt(at - 1) === "." && code.charAt(at - 2) !== ".";
    if (!field && !JQ_FUNCTIONS.has(m[0])) return false;
  }
  return true;
}

/**
 * Strict argument check: every word is a listed flag (with a valid value), a
 * valid positional, or a denial. Long flags also accept `--flag=value`.
 * Returns an error string, or null when the arguments pass.
 */
function checkArgs(args: readonly string[], rules: ArgRules): string | null {
  let positionals = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("-")) {
      positionals++;
      if (
        !rules.positional ||
        positionals > (rules.maxPositional ?? Number.POSITIVE_INFINITY) ||
        !rules.positional(arg, positionals - 1)
      )
        return `unexpected argument ${JSON.stringify(arg)}`;
      continue;
    }
    if (rules.countFlag && /^-\d{1,6}$/.test(arg)) continue;
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq < 0 ? arg : arg.slice(0, eq);
    const spec = rules.flags.get(name);
    if (spec === undefined)
      return `flag ${JSON.stringify(name)} is not allowed`;
    if (spec === true) {
      if (eq >= 0) return `flag ${name} takes no value`;
      continue;
    }
    const value = eq < 0 ? args[++i] : arg.slice(eq + 1);
    if (value === undefined || !spec(value)) return `bad value for ${name}`;
  }
  return positionals < (rules.minPositional ?? 0)
    ? "missing required argument"
    : null;
}

const flags = (
  entries: Record<string, true | ((value: string) => boolean)>,
): FlagSpec => new Map(Object.entries(entries));

const GIT_RULES: Record<string, ArgRules> = {
  log: {
    flags: flags({
      "--oneline": true,
      "--stat": true,
      "-n": INT,
      "--max-count": INT,
      "--format": matches(/^(oneline|short|medium)$/),
    }),
    countFlag: true,
    positional: safeRefOrPath,
  },
  show: {
    flags: flags({
      "--stat": true,
      "--name-only": true,
      "--name-status": true,
    }),
    positional: safeRefOrPath,
  },
  diff: {
    flags: flags({
      "--stat": true,
      "--name-only": true,
      "--name-status": true,
    }),
    positional: safeRefOrPath,
  },
  status: {
    flags: flags({ "-s": true, "--short": true, "--branch": true }),
    positional: safeRefOrPath,
  },
};

const PR_NUMBER = /^\d{1,9}$/;

const GH_PR_RULES: Record<string, ArgRules> = {
  view: { flags: flags({ "--json": JSON_FIELDS, "--comments": true }) },
  diff: { flags: flags({ "--name-only": true }) },
  checks: { flags: flags({}) },
};

const GH_PR_LIST_RULES: ArgRules = {
  flags: flags({
    "--state": matches(/^(open|closed|merged|all)$/),
    "--json": JSON_FIELDS,
    "--limit": INT,
  }),
};

/** Header `Name: value`; method overrides and credentials are refused. */
const HEADER = matches(
  /^(?![^:]*(override|authorization))[A-Za-z][A-Za-z0-9-]*: [\x20-\x7e]*$/i,
);

const GH_API_RULES: ArgRules = {
  flags: flags({
    "-H": HEADER,
    "--header": HEADER,
    "--jq": safeJq,
    "--paginate": true,
  }),
  positional: (word) =>
    /^repos\/[A-Za-z0-9_./?&=%,:-]+$/.test(word) && !word.includes(".."),
  maxPositional: 1,
  minPositional: 1,
};

function gitPolicy(words: readonly string[]): ToolDecision {
  const sub = words[1] ?? "";
  const rules = Object.hasOwn(GIT_RULES, sub) ? GIT_RULES[sub] : undefined;
  if (!rules) return deny("git: only log, show, diff and status");
  const error = checkArgs(words.slice(2), rules);
  return error ? deny(`git ${sub}: ${error}`) : ALLOW;
}

function ghPolicy(words: readonly string[]): ToolDecision {
  const [, sub, action = ""] = words;
  if (sub === "api") {
    const error = checkArgs(words.slice(2), GH_API_RULES);
    return error ? deny(`gh api: ${error}`) : ALLOW;
  }
  if (sub !== "pr") return deny("gh: only pr view|list|diff|checks and api");
  if (action === "merge") return deny("a wake turn never merges");
  if (action === "list") {
    const error = checkArgs(words.slice(3), GH_PR_LIST_RULES);
    return error ? deny(`gh pr list: ${error}`) : ALLOW;
  }
  const rules = Object.hasOwn(GH_PR_RULES, action)
    ? GH_PR_RULES[action]
    : undefined;
  if (!rules) return deny("gh pr: only view, list, diff and checks");
  if (!PR_NUMBER.test(words[3] ?? ""))
    return deny(`gh pr ${action}: needs a PR number`);
  const error = checkArgs(words.slice(4), rules);
  return error ? deny(`gh pr ${action}: ${error}`) : ALLOW;
}

const STATES = matches(/^(planning|building|review|blocked)$/);

function crewNetPolicy(words: readonly string[], turn: WakeTurn): ToolDecision {
  const sub = words[1] ?? "";
  const args = words.slice(2);
  let error: string | null;
  switch (sub) {
    case "inbox":
      error = checkArgs(args, { flags: flags({ "--json": true }) });
      break;
    case "reply":
      // `crew-net reply <item> [--done|--decline] "<text>"`, only to the waking item.
      if (args.find((a) => !a.startsWith("-")) !== turn.item)
        return deny(
          "crew-net reply: may only answer the item that woke the session",
        );
      error = checkArgs(args, {
        flags: flags({ "--done": true, "--decline": true, "--json": true }),
        positional: () => true,
        minPositional: 2,
        maxPositional: 2,
      });
      break;
    case "state": {
      const own = turn.ownPr;
      if (!own) return deny("crew-net state: this session has no PR");
      // Without `--repo` the CLI updates the current branch's PR: the session's own.
      error = checkArgs(args, {
        flags: flags({
          "--scope": safeRefOrPath,
          "--json": true,
          "--repo": (v) => v.toLowerCase() === own.repo.toLowerCase(),
        }),
        positional: (word, index) =>
          index === 0 ? STATES(word) : safeRefOrPath(word),
        minPositional: 1,
      });
      break;
    }
    default:
      return deny("crew-net: only reply, inbox and state");
  }
  return error ? deny(`crew-net ${sub}: ${error}`) : ALLOW;
}

function bashPolicy(command: unknown, turn: WakeTurn): ToolDecision {
  if (typeof command !== "string") return deny("Bash without a command");
  if (!PRINTABLE_ASCII.test(command))
    return deny("Bash: only printable ASCII is allowed");
  const parsed = tokenize(command);
  if ("error" in parsed) return deny(`Bash: ${parsed.error}`);
  const words = parsed.words;
  switch (words[0]) {
    case "crew-net":
      return crewNetPolicy(words, turn);
    case "gh":
      return ghPolicy(words);
    case "git":
      return gitPolicy(words);
    default:
      return deny("Bash command is not on the wake-turn allowlist");
  }
}

/** True when `path`, resolved against `root` without following links, stays inside `root`. */
function insideRoot(root: string, path: string): boolean {
  if (path === "" || path.startsWith("~") || path.includes("\0")) return false;
  const parts: string[] = [];
  for (const part of (path.startsWith("/") ? path : `${root}/${path}`).split(
    "/",
  )) {
    if (part === "..") {
      if (parts.pop() === undefined) return false;
    } else if (part && part !== ".") {
      parts.push(part);
    }
  }
  const full = `/${parts.join("/")}`;
  return full === root || full.startsWith(`${root}/`);
}

/** A glob that cannot reach above its base: relative, no `..`, no `~`. */
function safeGlob(pattern: string): boolean {
  return (
    !pattern.startsWith("/") &&
    !pattern.startsWith("~") &&
    !pattern.includes("\\") &&
    !pattern.split("/").includes("..")
  );
}

/** Input keys that name a file or directory, and whether each is required. */
const READ_TOOLS: Record<string, Record<string, boolean>> = {
  Read: { file_path: true },
  Grep: { path: false },
  Glob: { path: false },
  LS: { path: true },
};

/** Input keys that hold a glob pattern. */
const GLOB_KEYS: Record<string, readonly string[]> = {
  Glob: ["pattern"],
  Grep: ["glob"],
};

function readPolicy(call: ToolCall, turn: WakeTurn): ToolDecision {
  const root = turn.root.replace(/\/+$/, "");
  if (!root.startsWith("/") || root.split("/").includes(".."))
    return deny("wake turn has no valid worktree root");
  const input = call.input ?? {};
  for (const [key, required] of Object.entries(READ_TOOLS[call.tool] ?? {})) {
    const value = input[key];
    if (value === undefined && !required) continue;
    if (typeof value !== "string" || !insideRoot(root, value))
      return deny(`${call.tool}: ${key} must be inside the worktree ${root}`);
  }
  for (const key of GLOB_KEYS[call.tool] ?? []) {
    const value = input[key];
    if (value !== undefined && (typeof value !== "string" || !safeGlob(value)))
      return deny(`${call.tool}: ${key} must be a relative pattern`);
  }
  return ALLOW;
}

/**
 * Gate one tool call. A normal turn is not limited here. A wake turn fails
 * closed: tool names match exactly, reads stay inside the worktree, and Bash
 * must be one simple allowlisted command with allowlisted arguments.
 */
export function gate(call: ToolCall, turn: Turn): ToolDecision {
  if (turn.kind !== "wake") return ALLOW;
  if (call.tool === "Bash") return bashPolicy(call.input?.command, turn);
  if (Object.hasOwn(READ_TOOLS, call.tool)) return readPolicy(call, turn);
  return deny(`${call.tool} is not allowed in a wake turn`);
}
