import { lexShell, type Word } from "./shell";

/**
 * The PR a merge command targets. `repo` is `owner/name`; when it is missing
 * the caller uses gh's default repo of the command's working directory. With
 * neither `pr` nor `branch` the target is the PR of the current branch.
 * `host` (lower case) is set when the command names one: `-R host/o/r`, a PR
 * URL, `gh api --hostname` or an API URL. Without it gh takes `GH_HOST`, else
 * github.com, for a named repo, and the remote's host for the default repo.
 */
export interface MergeTarget {
  host?: string;
  repo?: string;
  pr?: number;
  branch?: string;
}

export type MergeDetection =
  /** The command cannot merge a PR. */
  | { kind: "none" }
  /** The command merges, or may merge, these PRs. Gate each one. */
  | { kind: "merge"; targets: MergeTarget[] }
  /** The command may merge something the gate cannot identify. Deny it. */
  | { kind: "deny"; reason: string };

export interface DetectOptions {
  /** `gh alias list`: alias name to expansion. Without it an unknown gh command counts as a possible merge. */
  aliases?: ReadonlyMap<string, string>;
}

/** gh top-level commands and built-in aliases (gh 2.x). Anything else may be a user alias or an extension. */
const GH_COMMANDS = new Set([
  "agent-task",
  "alias",
  "api",
  "attestation",
  "auth",
  "browse",
  "cache",
  "co",
  "codespace",
  "completion",
  "config",
  "copilot",
  "extension",
  "gist",
  "gpg-key",
  "help",
  "issue",
  "label",
  "org",
  "pr",
  "preview",
  "project",
  "release",
  "repo",
  "ruleset",
  "run",
  "search",
  "secret",
  "ssh-key",
  "status",
  "variable",
  "version",
  "workflow",
]);

/** Shell keywords that may start a simple command before the real command word. */
const KEYWORDS = new Set([
  "!",
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "coproc",
]);

/** Commands that run their arguments as a command. Value: flags that take a value. */
const WRAPPERS: Record<string, ReadonlySet<string>> = {
  builtin: new Set(),
  caffeinate: new Set(["-t", "-w"]),
  command: new Set(),
  exec: new Set(["-a"]),
  nohup: new Set(),
  nice: new Set(["-n", "--adjustment"]),
  stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
  time: new Set(["-o", "--output", "-f", "--format"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  sudo: new Set([
    ...["-u", "-g", "-h", "-p", "-C", "-D", "-U", "-r", "-t"],
    ...["--user", "--group", "--host", "--prompt", "--close-from"],
    ...["--chdir", "--other-user", "--role", "--type"],
  ]),
  xargs: new Set([
    ...["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a"],
    ...["--max-args", "--max-lines", "--max-procs", "--max-chars"],
    ...["--delimiter", "--eof", "--arg-file", "--replace"],
  ]),
};

/** `find` options that run the rest of the arguments, up to `;` or `+`, as a command. */
const FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

/** Commands that change which repo a later `gh` acts on. */
const CHANGES_DIR = new Set(["cd", "pushd", "popd"]);
/** Words that may change which repo gh resolves: a GH_ or GIT_ variable named anywhere (`+=`, `export`, `read`, `printf -v`), HOME or XDG_CONFIG_HOME set. */
const REPO_CONTEXT_WORD =
  /GH_(?:HOST|REPO|CONFIG_DIR)|GIT_(?:DIR|WORK_TREE|COMMON_DIR|CONFIG)|^(?:HOME|XDG_CONFIG_HOME)\+?=/;
/** Words that may change which host gh sends a repo named without one to. */
const HOST_CONTEXT_WORD =
  /GH_(?:HOST|CONFIG_DIR)|^(?:HOME|XDG_CONFIG_HOME)\+?=/;
/** `source f`, `. f` and `set -a` can set any variable. */
function setsVariables(words: readonly Word[]): boolean {
  const head = words.find((w) => !ASSIGNMENT.test(w.text))?.text;
  return (
    head === "source" ||
    head === "." ||
    (head === "set" &&
      words.some((w) => /^-\w*a/.test(w.text) || w.text === "allexport"))
  );
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;

/** gh flags that take a separate value, anywhere in `gh pr ...` and `gh api ...`. */
const GH_VALUE_FLAGS = new Set([
  "-R",
  "--repo",
  "--hostname",
  "-A",
  "--author-email",
  "-b",
  "--body",
  "--body-file",
  "--match-head-commit",
  "-t",
  "--subject",
  "-X",
  "--method",
  "-H",
  "--header",
  "-f",
  "--raw-field",
  "-F",
  "--field",
  "--input",
  "-q",
  "--jq",
  "--template",
  "-p",
  "--preview",
  "--cache",
]);

const MERGE_MUTATIONS =
  /mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|mergeBranch/i;

const NONE: MergeDetection = { kind: "none" };
const denied = (reason: string): MergeDetection => ({ kind: "deny", reason });

/** Combine per-command results: any deny wins, merge targets add up. */
function combine(results: readonly MergeDetection[]): MergeDetection {
  const targets: MergeTarget[] = [];
  for (const r of results) {
    if (r.kind === "deny") return r;
    if (r.kind === "merge") targets.push(...r.targets);
  }
  return targets.length > 0 ? { kind: "merge", targets } : NONE;
}

interface Flag {
  name: string;
  value?: Word;
}

/** Split gh arguments into flags (with values) and positionals. */
function splitArgs(words: readonly Word[]): {
  flags: Flag[];
  positionals: Word[];
} {
  const flags: Flag[] = [];
  const positionals: Word[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i] as Word;
    const t = w.text;
    if (t === "--") {
      positionals.push(...words.slice(i + 1));
      break;
    }
    if (!t.startsWith("-") || t === "-") {
      positionals.push(w);
      continue;
    }
    const eq = t.startsWith("--") ? t.indexOf("=") : -1;
    if (eq >= 0) {
      flags.push({
        name: t.slice(0, eq),
        value: { text: t.slice(eq + 1), dynamic: w.dynamic },
      });
    } else if (t.startsWith("--")) {
      if (GH_VALUE_FLAGS.has(t)) {
        const value = words[++i];
        flags.push(value === undefined ? { name: t } : { name: t, value });
      } else {
        flags.push({ name: t });
      }
    } else {
      // A short cluster, as pflag reads it: `-iXPUT`, `-sR o/r`.
      for (let j = 1; j < t.length; j++) {
        const name = `-${t.charAt(j)}`;
        if (!GH_VALUE_FLAGS.has(name)) {
          flags.push({ name });
          continue;
        }
        const rest = t.slice(j + 1);
        const value = rest ? { text: rest, dynamic: w.dynamic } : words[++i];
        flags.push(value === undefined ? { name } : { name, value });
        break;
      }
    }
  }
  return { flags, positionals };
}

type RepoHost = { host?: string; repo: string };

/** A host as gh names it; undefined with a port, which the gate cannot follow. */
const host = (name: string): string | undefined =>
  /:/.test(name) ? undefined : name.toLowerCase();

/** `-R` values: `owner/name` or `[https://]host/owner/name`. */
function repoFromFlag(value: string): RepoHost | undefined {
  const parts = value
    .replace(/^https?:\/\//, "")
    .split("/")
    .filter(Boolean);
  if (parts.length < 2 || parts.length > 3) return undefined;
  const repo = parts.slice(-2).join("/");
  if (parts.length === 2) return { repo };
  const named = host(parts[0] as string);
  return named === undefined ? undefined : { host: named, repo };
}

function repoFlag(
  flags: readonly Flag[],
): { host?: string; repo?: string } | { error: string } {
  let found: RepoHost | undefined;
  for (const f of flags) {
    if (f.name !== "-R" && f.name !== "--repo") continue;
    if (!f.value || f.value.dynamic)
      return { error: "the --repo value is not literal" };
    const parsed = repoFromFlag(f.value.text);
    if (!parsed) return { error: `cannot read --repo ${f.value.text}` };
    found = parsed;
  }
  return found ?? {};
}

function prMerge(args: readonly Word[]): MergeDetection {
  const { flags, positionals } = splitArgs(args);
  if (flags.some((f) => f.name === "--disable-auto")) return NONE;
  const repo = repoFlag(flags);
  if ("error" in repo) return denied(`gh pr merge: ${repo.error}`);
  if (positionals.length > 1)
    return denied("gh pr merge: more than one target");
  const target = positionals[0];
  if (target === undefined) return { kind: "merge", targets: [repo] };
  if (target.dynamic) return denied("gh pr merge: the target is not literal");
  const t = target.text;
  if (/^#?\d{1,9}$/.test(t))
    return {
      kind: "merge",
      targets: [{ ...repo, pr: Number(t.replace("#", "")) }],
    };
  const url =
    /^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d{1,9})(?:[/?#].*)?$/.exec(t);
  const urlHost = url ? host(url[1] as string) : undefined;
  if (url && urlHost === undefined)
    return denied(`gh pr merge: cannot follow the port in ${t}`);
  if (url)
    return {
      kind: "merge",
      targets: [
        {
          host: urlHost as string,
          repo: url[2] as string,
          pr: Number(url[3]),
        },
      ],
    };
  if (t.includes("://")) return denied(`gh pr merge: cannot read target ${t}`);
  return { kind: "merge", targets: [{ ...repo, branch: t }] };
}

/** API path without scheme, host, query or `.` / `..` segments, and without a leading slash. */
function apiPath(endpoint: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(endpoint);
  } catch {
    decoded = endpoint;
  }
  const noHost = decoded
    .replaceAll("\\", "/")
    .replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, "")
    .split(/[?#]/)[0] as string;
  const parts: string[] = [];
  for (const part of noHost.split("/")) {
    if (part === "..") parts.pop();
    else if (part && part !== ".") parts.push(part);
  }
  // GitHub Enterprise Server serves the REST API under /api/v3.
  if (parts[0] === "api" && parts[1] === "v3") parts.splice(0, 2);
  return parts.join("/");
}

const BODY_FLAGS = new Set(["-f", "--raw-field", "-F", "--field", "--input"]);

/** The GitHub host an API URL goes to: `api.github.com` and `api.<x>.ghe.com` are their hosts' APIs. */
function apiUrlHost(endpoint: string): string | undefined {
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/([^/?#]*)/.exec(endpoint);
  if (!m) return undefined;
  const name = host((m[1] as string).replace(/^[^@]*@/, ""));
  if (name === undefined) return "";
  const api = name.startsWith("api.") ? name.slice(4) : undefined;
  return api === "github.com" || api?.endsWith(".ghe.com") ? api : name;
}

/** `gh api --hostname`: the host, none, or an error when it is not literal. */
function hostnameFlag(
  flags: readonly Flag[],
): { host?: string } | { error: string } {
  let found: string | undefined;
  for (const f of flags) {
    if (f.name !== "--hostname") continue;
    if (!f.value || f.value.dynamic || f.value.text === "")
      return { error: "the --hostname value is not literal" };
    found = host(f.value.text);
    if (found === undefined)
      return { error: "the --hostname value has a port" };
  }
  return found === undefined ? {} : { host: found };
}

/** The HTTP method gh will use, or null when it cannot be known. */
function apiMethod(flags: readonly Flag[]): string | null {
  let method: string | undefined;
  for (const f of flags) {
    if (f.name === "-X" || f.name === "--method") {
      if (!f.value || f.value.dynamic) return null;
      method = f.value.text.toUpperCase();
    }
    if (
      (f.name === "-H" || f.name === "--header") &&
      (!f.value || f.value.dynamic || /override/i.test(f.value.text))
    )
      return null;
  }
  if (method !== undefined) return method;
  return flags.some((f) => BODY_FLAGS.has(f.name)) ? "POST" : "GET";
}

function api(args: readonly Word[]): MergeDetection {
  const { flags, positionals } = splitArgs(args);
  const method = apiMethod(flags);
  const readOnly = method === "GET" || method === "HEAD";
  const endpoint = positionals[0];
  if (endpoint === undefined) return NONE;
  if (endpoint.dynamic)
    return readOnly ? NONE : denied("gh api: the endpoint is not literal");
  const path = apiPath(endpoint.text);

  // GitHub Enterprise Server serves GraphQL at /api/graphql.
  if (path === "graphql" || path === "api/graphql") {
    for (const f of flags) {
      if (f.name === "--input")
        return denied("gh api graphql: a query from a file cannot be checked");
      if (!BODY_FLAGS.has(f.name)) continue;
      const value = f.value;
      if (!value || value.dynamic)
        return denied("gh api graphql: a field is not literal");
      if (
        f.name !== "-f" &&
        f.name !== "--raw-field" &&
        /^[^=]*=@/.test(value.text)
      )
        return denied("gh api graphql: a query from a file cannot be checked");
      if (MERGE_MUTATIONS.test(value.text))
        return denied(
          "gh api graphql: merge mutations are not gated; use gh pr merge",
        );
    }
    return NONE;
  }

  const pull = /^repos\/([^/]+)\/([^/]+)\/pulls\/(\d{1,9})\/merge$/.exec(path);
  if (pull) {
    if (readOnly) return NONE;
    // gh api fills {owner}/{repo} by its own rules; the repo must be named.
    const repo = { repo: `${pull[1]}/${pull[2]}` };
    if (/[{}]/.test(repo.repo))
      return denied(`gh api: name the repo in ${endpoint.text}`);
    const named = hostnameFlag(flags);
    if ("error" in named) return denied(`gh api: ${named.error}`);
    // A full URL goes to its own host whatever --hostname says.
    const urlHost = apiUrlHost(endpoint.text);
    if (urlHost === "")
      return denied(`gh api: cannot follow the port in ${endpoint.text}`);
    const target = urlHost === undefined ? named : { host: urlHost };
    return {
      kind: "merge",
      targets: [{ ...target, ...repo, pr: Number(pull[3]) }],
    };
  }
  if (/^repos\/[^/]+\/[^/]+\/merges$/.test(path) && !readOnly)
    return denied("gh api: branch merges are not gated; use gh pr merge");
  return NONE;
}

/** Stands in for `$N` while the expansion is lexed, so the lexer keeps it as text. */
const PLACEHOLDER = "\u0000";

/** Put arguments into a gh alias expansion as gh does: `$N` takes argument N, the rest are appended. */
function expandAlias(expansion: string, args: readonly Word[]): Word[] | null {
  const lexed = lexShell(expansion.replace(/\$(\d)/g, `${PLACEHOLDER}$1`));
  if (!lexed.ok || lexed.commands.length !== 1) return null;
  const used = new Set<number>();
  const words = (lexed.commands[0] as Word[]).map((w) => {
    const m = new RegExp(`^${PLACEHOLDER}(\\d)$`).exec(w.text);
    if (!m)
      return w.text.includes(PLACEHOLDER) ? { text: w.text, dynamic: true } : w;
    const n = Number(m[1]);
    used.add(n);
    return args[n - 1] ?? { text: "", dynamic: true };
  });
  return [...words, ...args.filter((_, i) => !used.has(i + 1))];
}

function gh(
  args: readonly Word[],
  options: DetectOptions,
  depth: number,
): MergeDetection {
  const { positionals } = splitArgs(args);
  const top = positionals[0];
  if (top === undefined) return NONE;
  if (top.dynamic) return denied("gh: the command is not literal");
  const at = args.indexOf(top);
  // Flags before the command (`gh -R x pr merge`) still reach it.
  const rest = [...args.slice(0, at), ...args.slice(at + 1)];
  if (top.text === "pr") {
    const action = splitArgs(rest).positionals[0];
    if (action === undefined) return NONE;
    if (action.dynamic) return denied("gh pr: the subcommand is not literal");
    if (action.text !== "merge") return NONE;
    // Flags before the action (`gh pr -R x merge`) still apply.
    return prMerge(rest.filter((w) => w !== action));
  }
  if (top.text === "api") return api(rest);
  if (GH_COMMANDS.has(top.text)) return NONE;

  const expansion = options.aliases?.get(top.text);
  if (options.aliases === undefined) return { kind: "merge", targets: [{}] };
  if (expansion === undefined) return NONE;
  if (depth >= 4) return denied(`gh alias ${top.text}: expands too deep`);
  if (expansion.startsWith("!"))
    return detectIn(
      expansion.slice(1),
      options,
      depth + 1,
      `gh alias ${top.text}`,
    );
  const words = expandAlias(expansion, rest);
  if (words === null)
    return denied(`gh alias ${top.text}: cannot read its expansion`);
  return gh(words, options, depth + 1);
}

/** Strip leading assignments, keywords and wrappers. Returns the real argv, or a deny. */
function unwrap(words: readonly Word[]): Word[] | MergeDetection {
  let argv = [...words];
  for (let guard = 0; guard < 16; guard++) {
    const head = argv[0];
    if (head === undefined || head.dynamic) return argv;
    if (ASSIGNMENT.test(head.text) || KEYWORDS.has(head.text)) {
      argv = argv.slice(1);
      continue;
    }
    const name = head.text.split("/").pop() ?? "";
    if (name === "env") {
      let i = 1;
      while (i < argv.length) {
        const t = (argv[i] as Word).text;
        if (t === "-S" || t.startsWith("--split-string"))
          return denied("env -S: cannot check the split command");
        if (["-u", "--unset", "-C", "--chdir", "-P"].includes(t)) i += 2;
        else if (t.startsWith("-") || ASSIGNMENT.test(t)) i++;
        else break;
      }
      argv = argv.slice(i);
      continue;
    }
    const valueFlags = Object.hasOwn(WRAPPERS, name)
      ? WRAPPERS[name]
      : undefined;
    if (!valueFlags) return argv;
    let i = 1;
    while (i < argv.length && (argv[i] as Word).text.startsWith("-"))
      i += valueFlags.has((argv[i] as Word).text) ? 2 : 1;
    // `timeout DURATION command`
    if (name === "timeout") i++;
    argv = argv.slice(i);
    // xargs appends arguments read from stdin.
    if (name === "xargs") argv.push({ text: "", dynamic: true });
  }
  return denied("too many command wrappers");
}

/** `bash [options] -c script`: check the script. Without `-c` or a script file the shell reads stdin, which cannot be checked. */
function shell(
  name: string,
  argv: readonly Word[],
  options: DetectOptions,
  depth: number,
): MergeDetection {
  let command = false;
  let i = 1;
  for (; i < argv.length; i++) {
    const t = (argv[i] as Word).text;
    if (t === "--") {
      i++;
      break;
    }
    if (!/^[-+]./.test(t)) break;
    if (t.startsWith("--")) continue;
    if (t.startsWith("-") && t.includes("c")) command = true;
    // `-o option` and `-O shopt` take the next word.
    if (/[oO]/.test(t)) i++;
  }
  const script = argv[i];
  if (!command)
    return script === undefined
      ? denied(`${name}: reads commands from stdin, which cannot be checked`)
      : NONE;
  if (script === undefined || script.dynamic)
    return denied(`${name} -c: cannot check the inner command`);
  return detectIn(script.text, options, depth + 1, `${name} -c`);
}

/** `find ... -exec cmd {} ;`: check each command `find` runs. `{}` stands for a file name. */
function findExec(
  argv: readonly Word[],
  options: DetectOptions,
  depth: number,
): MergeDetection {
  const results: MergeDetection[] = [];
  for (let i = 1; i < argv.length; i++) {
    if (!FIND_EXEC.has((argv[i] as Word).text)) continue;
    const command: Word[] = [];
    for (i++; i < argv.length; i++) {
      const w = argv[i] as Word;
      if (w.text === ";" || w.text === "+") break;
      command.push(w.text === "{}" ? { text: "", dynamic: true } : w);
    }
    results.push(detectCommand(command, options, depth));
  }
  return combine(results);
}

/** True when the line may run `gh` against another repo than the caller's cwd: `cd`, `GH_REPO=`, `env -C`. */
function changesRepoContext(commands: readonly Word[][]): boolean {
  return commands.some((words) => {
    const head = words.find((w) => !ASSIGNMENT.test(w.text));
    const name = head?.text.split("/").pop() ?? "";
    return (
      CHANGES_DIR.has(name) ||
      setsVariables(words) ||
      words.some((w) => REPO_CONTEXT_WORD.test(w.text)) ||
      (name === "env" && words.some((w) => /^(-C|--chdir)/.test(w.text)))
    );
  });
}

function detectCommand(
  words: readonly Word[],
  options: DetectOptions,
  depth: number,
): MergeDetection {
  const argv = unwrap(words);
  if (!Array.isArray(argv)) return argv;
  const head = argv[0];
  if (head === undefined || head.dynamic) return NONE;
  const name = head.text.split("/").pop() ?? "";

  if (SHELLS.has(name)) return shell(name, argv, options, depth);
  if (name === "find") return findExec(argv, options, depth);
  if (name === "eval") {
    const rest = argv.slice(1);
    if (rest.some((w) => w.dynamic))
      return denied("eval: cannot check the inner command");
    return detectIn(
      rest.map((w) => w.text).join(" "),
      options,
      depth + 1,
      "eval",
    );
  }
  return name === "gh" ? gh(argv.slice(1), options, depth) : NONE;
}

function detectIn(
  src: string,
  options: DetectOptions,
  depth: number,
  where: string,
): MergeDetection {
  if (depth > 8) return denied(`${where}: nests too deep`);
  const lexed = lexShell(src);
  if (!lexed.ok) return denied(`${where}: cannot parse (${lexed.error})`);
  const result = combine(
    lexed.commands.map((c) => detectCommand(c, options, depth)),
  );
  if (
    result.kind === "merge" &&
    result.targets.some((t) => t.repo === undefined) &&
    changesRepoContext(lexed.commands)
  )
    return denied(
      `${where}: changes directory or GH_REPO before a merge; name the PR with -R owner/repo or a URL`,
    );
  // gh sends a named repo without a host to GH_HOST; the gate cannot tell
  // which value a set in the line reaches gh, so the host must be named.
  if (
    result.kind === "merge" &&
    result.targets.some((t) => t.host === undefined) &&
    lexed.commands.some(
      (words) =>
        setsVariables(words) ||
        words.some((w) => HOST_CONTEXT_WORD.test(w.text)),
    )
  )
    return denied(
      `${where}: may set GH_HOST before a merge; name the host with -R host/owner/repo or a PR URL`,
    );
  return result;
}

/**
 * Find every PR merge a Bash command line may run: `gh pr merge` (any flag
 * order, `--auto` included, `--disable-auto` excluded), `gh api` writes to
 * `pulls/N/merge`, GraphQL merge mutations, gh aliases, and the same inside
 * `;`/`&&`/`|` chains, substitutions, `env`/`command`/`sudo` wrappers,
 * `sh -c` and `eval`. A merge it cannot pin to a PR is a deny.
 *
 * Limit: it cannot follow a command name held in a variable (`$GH pr merge`)
 * or a script file. The server check (`crew-deps`) covers those.
 */
export function detectMerge(
  command: string,
  options: DetectOptions = {},
): MergeDetection {
  return detectIn(command, options, 0, "command");
}
