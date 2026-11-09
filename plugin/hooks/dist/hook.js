// plugin/hooks/hook-main.ts
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// plugin/hooks/hook.ts
import { spawnSync } from "node:child_process";
// src/protocol/events.ts
var ITEM_KINDS = ["message", "finding", "digest"];
var ACK_OUTCOMES = ["context", "band", "wake", "ignored"];
var SESSION_ROLES = ["lead", "worker"];
var isString = (value) => typeof value === "string";
var isBoolean = (value) => typeof value === "boolean";
var isInt = (value) => Number.isInteger(value);
var oneOf = (options) => (value) => options.some((option) => option === value);
var SHAPES = {
  ready: {},
  item: {
    id: isString,
    kind: oneOf(ITEM_KINDS),
    text: isString,
    addressed: isBoolean
  },
  status: { text: isString },
  error: { message: isString },
  hello: {
    session: isString,
    role: oneOf(SESSION_ROLES),
    harness: isString,
    worktree: isString,
    pid: isInt
  },
  ack: { id: isString, outcome: oneOf(ACK_OUTCOMES) },
  bye: {}
};
// src/protocol/message.ts
var LOGIN_PATTERN = "[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})";
var LOGIN = new RegExp(`^${LOGIN_PATTERN}$`);
// src/protocol/state-block.ts
var KNOWN_FIELDS = new Set(["state", "scope", "depends-on", "lead"]);
// src/core/order/shell.ts
var SEPARATORS = new Set([";", "&", "|", `
`, "(", ")"]);
var DQ_ESCAPABLE = new Set(["$", "`", '"', "\\", `
`]);
var MAX_DEPTH = 8;

class Reader {
  src;
  depth;
  substitutionBody;
  i = 0;
  commands = [];
  current = [];
  word = null;
  bare = "";
  pendingHeredocs = [];
  redirectTarget = false;
  parens = 0;
  closedAt = -1;
  constructor(src, depth, substitutionBody = false) {
    this.src = src;
    this.depth = depth;
    this.substitutionBody = substitutionBody;
  }
  start() {
    this.word ??= { text: "", dynamic: false };
    return this.word;
  }
  append(text) {
    this.start().text += text;
  }
  markDynamic() {
    this.start().dynamic = true;
  }
  endWord() {
    if (this.word === null)
      return;
    if (/\{[^}]*(,|\.\.)[^}]*\}/.test(this.bare))
      this.word.dynamic = true;
    if (this.redirectTarget)
      this.redirectTarget = false;
    else
      this.current.push(this.word);
    this.word = null;
    this.bare = "";
  }
  endCommand() {
    this.endWord();
    const words = this.current.filter((w) => w.dynamic || !(w.text === "{" || w.text === "}"));
    if (words.length > 0)
      this.commands.push(words);
    this.current = [];
  }
  nested(body) {
    if (this.depth >= MAX_DEPTH)
      return "substitutions nest too deep";
    const inner = lex(body, this.depth + 1);
    if (!inner.ok)
      return inner.error;
    this.commands.push(...inner.commands);
    return null;
  }
  expansionsIn(text) {
    if (!/\$\(|`/.test(text))
      return null;
    return this.nested(`echo "${text.replaceAll('"', "\\\"")}"`);
  }
  substitution() {
    if (this.depth >= MAX_DEPTH)
      return "substitutions nest too deep";
    const inner = new Reader(this.src, this.depth + 1, true);
    inner.i = this.i + 2;
    const result = inner.run();
    if (!result.ok)
      return result.error;
    if (inner.closedAt < 0)
      return "unterminated substitution";
    this.commands.push(...result.commands);
    this.markDynamic();
    this.i = inner.closedAt + 1;
    return null;
  }
  backtick() {
    let body = "";
    for (let j = this.i + 1;j < this.src.length; j++) {
      const c = this.src.charAt(j);
      if (c === "\\" && j + 1 < this.src.length) {
        body += this.src.charAt(++j);
      } else if (c === "`") {
        this.markDynamic();
        this.i = j + 1;
        return this.nested(body);
      } else {
        body += c;
      }
    }
    return "unterminated backtick";
  }
  dollar() {
    const next = this.src.charAt(this.i + 1);
    if (next === "(")
      return this.substitution();
    if (next === "{") {
      const end = this.src.indexOf("}", this.i);
      if (end < 0)
        return "unterminated parameter expansion";
      this.markDynamic();
      const body = this.src.slice(this.i + 2, end);
      this.i = end + 1;
      return this.expansionsIn(body);
    }
    if (/[A-Za-z0-9_@*#?$!-]/.test(next)) {
      this.markDynamic();
      this.i += 2;
      if (/[A-Za-z_]/.test(next))
        while (/[A-Za-z0-9_]/.test(this.src.charAt(this.i)))
          this.i++;
      return null;
    }
    this.append("$");
    this.i++;
    return null;
  }
  singleQuoted() {
    const end = this.src.indexOf("'", this.i + 1);
    if (end < 0)
      return "unterminated quote";
    this.append(this.src.slice(this.i + 1, end));
    this.i = end + 1;
    return null;
  }
  ansiQuoted() {
    let text = "";
    for (let j = this.i + 2;j < this.src.length; j++) {
      const c = this.src.charAt(j);
      if (c === "'") {
        this.append(text);
        this.i = j + 1;
        return null;
      }
      if (c === "\\") {
        const e = this.src.charAt(++j);
        if (e === "'" || e === "\\")
          text += e;
        else
          this.markDynamic();
      } else {
        text += c;
      }
    }
    return "unterminated quote";
  }
  doubleQuoted() {
    this.start();
    this.i++;
    while (this.i < this.src.length) {
      const c = this.src.charAt(this.i);
      if (c === '"') {
        this.i++;
        return null;
      }
      if (c === "\\") {
        const e = this.src.charAt(this.i + 1);
        if (DQ_ESCAPABLE.has(e)) {
          if (e !== `
`)
            this.append(e);
        } else {
          this.append(`\\${e}`);
        }
        this.i += 2;
      } else if (c === "$") {
        const error = this.dollar();
        if (error)
          return error;
      } else if (c === "`") {
        const error = this.backtick();
        if (error)
          return error;
      } else {
        this.append(c);
        this.i++;
      }
    }
    return "unterminated quote";
  }
  redirect() {
    const c = this.src.charAt(this.i);
    const next = this.src.charAt(this.i + 1);
    if (next === "(")
      return this.substitution();
    if (this.word && !this.word.dynamic && /^\d+$/.test(this.word.text))
      this.word = null;
    this.endWord();
    if (c === "<" && next === "<") {
      if (this.src.charAt(this.i + 2) === "<") {
        this.i += 3;
      } else {
        const stripTabs = this.src.charAt(this.i + 2) === "-";
        this.i += stripTabs ? 3 : 2;
        const heredoc = this.heredocDelimiter(stripTabs);
        if (heredoc === null)
          return "missing here-document delimiter";
        if (!heredoc.quoted && /^\d+$/.test(heredoc.delimiter))
          return null;
        this.pendingHeredocs.push(heredoc);
        return null;
      }
    } else {
      this.i += next === ">" || next === "&" || next === "|" ? 2 : 1;
    }
    this.redirectTarget = true;
    return null;
  }
  heredocDelimiter(stripTabs) {
    while (this.src.charAt(this.i) === " " || this.src.charAt(this.i) === "\t")
      this.i++;
    const m = /^(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()]+))/.exec(this.src.slice(this.i));
    if (!m)
      return null;
    this.i += m[0].length;
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    return {
      delimiter: raw.replaceAll("\\", ""),
      stripTabs,
      quoted: m[3] === undefined || raw.includes("\\")
    };
  }
  skipHeredocs() {
    for (const { delimiter, stripTabs, quoted } of this.pendingHeredocs) {
      let found = false;
      let body = "";
      while (this.i < this.src.length) {
        const eol = this.src.indexOf(`
`, this.i);
        const end = eol < 0 ? this.src.length : eol;
        let line = this.src.slice(this.i, end);
        if (stripTabs)
          line = line.replace(/^\t+/, "");
        this.i = end + 1;
        if (line === delimiter) {
          found = true;
          break;
        }
        body += `${line}
`;
      }
      if (!found)
        return "unterminated here-document";
      const error = quoted ? null : this.expansionsIn(body);
      if (error)
        return error;
    }
    this.pendingHeredocs = [];
    return null;
  }
  run() {
    const src = this.src;
    while (this.i < src.length) {
      const c = src.charAt(this.i);
      let error = null;
      if (c === "'") {
        error = this.singleQuoted();
      } else if (c === '"') {
        error = this.doubleQuoted();
      } else if (c === "$" && src.charAt(this.i + 1) === "'") {
        error = this.ansiQuoted();
      } else if (c === "$" && src.charAt(this.i + 1) === '"') {
        this.i++;
        error = this.doubleQuoted();
      } else if (this.substitutionBody && (c === "(" || c === ")")) {
        if (c === ")" && this.parens === 0) {
          this.closedAt = this.i;
          break;
        }
        this.parens += c === "(" ? 1 : -1;
        this.endCommand();
        this.i++;
      } else if (c === "$") {
        error = this.dollar();
      } else if (c === "`") {
        error = this.backtick();
      } else if (c === "\\") {
        const e = src.charAt(this.i + 1);
        if (e !== `
`)
          this.append(e);
        this.i += 2;
      } else if (c === "#" && this.word === null) {
        const eol = src.indexOf(`
`, this.i);
        this.i = eol < 0 ? src.length : eol;
      } else if (c === "<" || c === ">") {
        error = this.redirect();
      } else if (c === "&" && src.charAt(this.i + 1) === ">") {
        this.endWord();
        this.i += src.charAt(this.i + 2) === ">" ? 3 : 2;
        this.redirectTarget = true;
      } else if (SEPARATORS.has(c) || c === "\r") {
        this.endCommand();
        this.i++;
        if (c === `
`)
          error = this.skipHeredocs();
      } else if (c === " " || c === "\t") {
        this.endWord();
        this.i++;
      } else {
        if ("*?[".includes(c) || c === "~" && (this.word === null || /[=:]$/.test(this.bare)))
          this.markDynamic();
        this.append(c);
        this.bare += c;
        this.i++;
      }
      if (error)
        return { ok: false, error };
    }
    this.endCommand();
    return { ok: true, commands: this.commands };
  }
}
function lex(src, depth) {
  return new Reader(src, depth).run();
}
function lexShell(src) {
  return lex(src, 0);
}

// src/core/order/merge.ts
var GH_COMMANDS = new Set([
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
  "workflow"
]);
var KEYWORDS = new Set([
  "!",
  "if",
  "then",
  "else",
  "elif",
  "do",
  "while",
  "until",
  "coproc"
]);
var WRAPPERS = {
  builtin: new Set,
  caffeinate: new Set(["-t", "-w"]),
  command: new Set,
  exec: new Set(["-a"]),
  nohup: new Set,
  nice: new Set(["-n", "--adjustment"]),
  stdbuf: new Set(["-i", "-o", "-e", "--input", "--output", "--error"]),
  time: new Set(["-o", "--output", "-f", "--format"]),
  timeout: new Set(["-s", "--signal", "-k", "--kill-after"]),
  sudo: new Set([
    ...["-u", "-g", "-h", "-p", "-C", "-D", "-U", "-r", "-t"],
    ...["--user", "--group", "--host", "--prompt", "--close-from"],
    ...["--chdir", "--other-user", "--role", "--type"]
  ]),
  xargs: new Set([
    ...["-I", "-L", "-n", "-P", "-s", "-d", "-E", "-a"],
    ...["--max-args", "--max-lines", "--max-procs", "--max-chars"],
    ...["--delimiter", "--eof", "--arg-file", "--replace"]
  ])
};
var FIND_EXEC = new Set(["-exec", "-execdir", "-ok", "-okdir"]);
var CHANGES_DIR = new Set(["cd", "pushd", "popd"]);
var GH_CONTEXT_VAR = /^GH_(REPO|HOST)=/;
var SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
var ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*\+?=/;
var GH_VALUE_FLAGS = new Set([
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
  "--cache"
]);
var MERGE_MUTATIONS = /mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|mergeBranch/i;
var NONE = { kind: "none" };
var denied = (reason) => ({ kind: "deny", reason });
function combine(results) {
  const targets = [];
  for (const r of results) {
    if (r.kind === "deny")
      return r;
    if (r.kind === "merge")
      targets.push(...r.targets);
  }
  return targets.length > 0 ? { kind: "merge", targets } : NONE;
}
function splitArgs(words) {
  const flags = [];
  const positionals = [];
  for (let i = 0;i < words.length; i++) {
    const w = words[i];
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
        value: { text: t.slice(eq + 1), dynamic: w.dynamic }
      });
    } else if (t.startsWith("--")) {
      if (GH_VALUE_FLAGS.has(t)) {
        const value = words[++i];
        flags.push(value === undefined ? { name: t } : { name: t, value });
      } else {
        flags.push({ name: t });
      }
    } else {
      for (let j = 1;j < t.length; j++) {
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
function repoFromFlag(value) {
  const parts = value.replace(/^https?:\/\//, "").split("/").filter(Boolean);
  if (parts.length < 2 || parts.length > 3)
    return;
  return parts.slice(-2).join("/");
}
function repoFlag(flags) {
  let repo;
  for (const f of flags) {
    if (f.name !== "-R" && f.name !== "--repo")
      continue;
    if (!f.value || f.value.dynamic)
      return { error: "the --repo value is not literal" };
    const parsed = repoFromFlag(f.value.text);
    if (!parsed)
      return { error: `cannot read --repo ${f.value.text}` };
    repo = parsed;
  }
  return repo === undefined ? {} : { repo };
}
function prMerge(args) {
  const { flags, positionals } = splitArgs(args);
  if (flags.some((f) => f.name === "--disable-auto"))
    return NONE;
  const repo = repoFlag(flags);
  if ("error" in repo)
    return denied(`gh pr merge: ${repo.error}`);
  if (positionals.length > 1)
    return denied("gh pr merge: more than one target");
  const target = positionals[0];
  if (target === undefined)
    return { kind: "merge", targets: [repo] };
  if (target.dynamic)
    return denied("gh pr merge: the target is not literal");
  const t = target.text;
  if (/^#?\d{1,9}$/.test(t))
    return {
      kind: "merge",
      targets: [{ ...repo, pr: Number(t.replace("#", "")) }]
    };
  const url = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/(\d{1,9})(?:[/?#].*)?$/.exec(t);
  if (url)
    return {
      kind: "merge",
      targets: [{ repo: url[1], pr: Number(url[2]) }]
    };
  if (t.includes("://"))
    return denied(`gh pr merge: cannot read target ${t}`);
  return { kind: "merge", targets: [{ ...repo, branch: t }] };
}
function apiPath(endpoint) {
  let decoded;
  try {
    decoded = decodeURIComponent(endpoint);
  } catch {
    decoded = endpoint;
  }
  const noHost = decoded.replaceAll("\\", "/").replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/]*/, "").split(/[?#]/)[0];
  const parts = [];
  for (const part of noHost.split("/")) {
    if (part === "..")
      parts.pop();
    else if (part && part !== ".")
      parts.push(part);
  }
  if (parts[0] === "api" && parts[1] === "v3")
    parts.splice(0, 2);
  return parts.join("/");
}
var BODY_FLAGS = new Set(["-f", "--raw-field", "-F", "--field", "--input"]);
function apiMethod(flags) {
  let method;
  for (const f of flags) {
    if (f.name === "-X" || f.name === "--method") {
      if (!f.value || f.value.dynamic)
        return null;
      method = f.value.text.toUpperCase();
    }
    if ((f.name === "-H" || f.name === "--header") && (!f.value || f.value.dynamic || /override/i.test(f.value.text)))
      return null;
  }
  if (method !== undefined)
    return method;
  return flags.some((f) => BODY_FLAGS.has(f.name)) ? "POST" : "GET";
}
function api(args) {
  const { flags, positionals } = splitArgs(args);
  const method = apiMethod(flags);
  const readOnly = method === "GET" || method === "HEAD";
  const endpoint = positionals[0];
  if (endpoint === undefined)
    return NONE;
  if (endpoint.dynamic)
    return readOnly ? NONE : denied("gh api: the endpoint is not literal");
  const path = apiPath(endpoint.text);
  if (path === "graphql" || path === "api/graphql") {
    for (const f of flags) {
      if (f.name === "--input")
        return denied("gh api graphql: a query from a file cannot be checked");
      if (!BODY_FLAGS.has(f.name))
        continue;
      const value = f.value;
      if (!value || value.dynamic)
        return denied("gh api graphql: a field is not literal");
      if (f.name !== "-f" && f.name !== "--raw-field" && /^[^=]*=@/.test(value.text))
        return denied("gh api graphql: a query from a file cannot be checked");
      if (MERGE_MUTATIONS.test(value.text))
        return denied("gh api graphql: merge mutations are not gated; use gh pr merge");
    }
    return NONE;
  }
  const pull = /^repos\/([^/]+)\/([^/]+)\/pulls\/(\d{1,9})\/merge$/.exec(path);
  if (pull) {
    if (readOnly)
      return NONE;
    const repo = pull[1] === "{owner}" && pull[2] === "{repo}" ? {} : { repo: `${pull[1]}/${pull[2]}` };
    if (/[{}]/.test(repo.repo ?? ""))
      return denied(`gh api: cannot read the repo in ${endpoint.text}`);
    return { kind: "merge", targets: [{ ...repo, pr: Number(pull[3]) }] };
  }
  if (/^repos\/[^/]+\/[^/]+\/merges$/.test(path) && !readOnly)
    return denied("gh api: branch merges are not gated; use gh pr merge");
  return NONE;
}
var PLACEHOLDER = "\x00";
function expandAlias(expansion, args) {
  const lexed = lexShell(expansion.replace(/\$(\d)/g, `${PLACEHOLDER}$1`));
  if (!lexed.ok || lexed.commands.length !== 1)
    return null;
  const used = new Set;
  const words = lexed.commands[0].map((w) => {
    const m = new RegExp(`^${PLACEHOLDER}(\\d)$`).exec(w.text);
    if (!m)
      return w.text.includes(PLACEHOLDER) ? { text: w.text, dynamic: true } : w;
    const n = Number(m[1]);
    used.add(n);
    return args[n - 1] ?? { text: "", dynamic: true };
  });
  return [...words, ...args.filter((_, i) => !used.has(i + 1))];
}
function gh(args, options, depth) {
  const { positionals } = splitArgs(args);
  const top = positionals[0];
  if (top === undefined)
    return NONE;
  if (top.dynamic)
    return denied("gh: the command is not literal");
  const at = args.indexOf(top);
  const rest = args.slice(at + 1);
  if (top.text === "pr") {
    const action = splitArgs(rest).positionals[0];
    if (action === undefined)
      return NONE;
    if (action.dynamic)
      return denied("gh pr: the subcommand is not literal");
    if (action.text !== "merge")
      return NONE;
    return prMerge(rest.filter((w) => w !== action));
  }
  if (top.text === "api")
    return api(rest);
  if (GH_COMMANDS.has(top.text))
    return NONE;
  const expansion = options.aliases?.get(top.text);
  if (options.aliases === undefined)
    return { kind: "merge", targets: [{}] };
  if (expansion === undefined)
    return NONE;
  if (depth >= 4)
    return denied(`gh alias ${top.text}: expands too deep`);
  if (expansion.startsWith("!"))
    return detectIn(expansion.slice(1), options, depth + 1, `gh alias ${top.text}`);
  const words = expandAlias(expansion, rest);
  if (words === null)
    return denied(`gh alias ${top.text}: cannot read its expansion`);
  return gh(words, options, depth + 1);
}
function unwrap(words) {
  let argv = [...words];
  for (let guard = 0;guard < 16; guard++) {
    const head = argv[0];
    if (head === undefined || head.dynamic)
      return argv;
    if (ASSIGNMENT.test(head.text) || KEYWORDS.has(head.text)) {
      argv = argv.slice(1);
      continue;
    }
    const name = head.text.split("/").pop() ?? "";
    if (name === "env") {
      let i = 1;
      while (i < argv.length) {
        const t = argv[i].text;
        if (t === "-S" || t.startsWith("--split-string"))
          return denied("env -S: cannot check the split command");
        if (["-u", "--unset", "-C", "--chdir", "-P"].includes(t))
          i += 2;
        else if (t.startsWith("-") || ASSIGNMENT.test(t))
          i++;
        else
          break;
      }
      argv = argv.slice(i);
      continue;
    }
    const valueFlags = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined;
    if (!valueFlags)
      return argv;
    let i = 1;
    while (i < argv.length && argv[i].text.startsWith("-"))
      i += valueFlags.has(argv[i].text) ? 2 : 1;
    if (name === "timeout")
      i++;
    argv = argv.slice(i);
    if (name === "xargs")
      argv.push({ text: "", dynamic: true });
  }
  return denied("too many command wrappers");
}
function shell(name, argv, options, depth) {
  let command = false;
  let i = 1;
  for (;i < argv.length; i++) {
    const t = argv[i].text;
    if (t === "--") {
      i++;
      break;
    }
    if (!/^[-+]./.test(t))
      break;
    if (t.startsWith("--"))
      continue;
    if (t.startsWith("-") && t.includes("c"))
      command = true;
    if (/[oO]/.test(t))
      i++;
  }
  const script = argv[i];
  if (!command)
    return script === undefined ? denied(`${name}: reads commands from stdin, which cannot be checked`) : NONE;
  if (script === undefined || script.dynamic)
    return denied(`${name} -c: cannot check the inner command`);
  return detectIn(script.text, options, depth + 1, `${name} -c`);
}
function findExec(argv, options, depth) {
  const results = [];
  for (let i = 1;i < argv.length; i++) {
    if (!FIND_EXEC.has(argv[i].text))
      continue;
    const command = [];
    for (i++;i < argv.length; i++) {
      const w = argv[i];
      if (w.text === ";" || w.text === "+")
        break;
      command.push(w.text === "{}" ? { text: "", dynamic: true } : w);
    }
    results.push(detectCommand(command, options, depth));
  }
  return combine(results);
}
function changesRepoContext(commands) {
  return commands.some((words) => {
    const head = words.find((w) => !ASSIGNMENT.test(w.text));
    const name = head?.text.split("/").pop() ?? "";
    return CHANGES_DIR.has(name) || words.some((w) => GH_CONTEXT_VAR.test(w.text)) || name === "env" && words.some((w) => /^(-C|--chdir)/.test(w.text));
  });
}
function detectCommand(words, options, depth) {
  const argv = unwrap(words);
  if (!Array.isArray(argv))
    return argv;
  const head = argv[0];
  if (head === undefined || head.dynamic)
    return NONE;
  const name = head.text.split("/").pop() ?? "";
  if (SHELLS.has(name))
    return shell(name, argv, options, depth);
  if (name === "find")
    return findExec(argv, options, depth);
  if (name === "eval") {
    const rest = argv.slice(1);
    if (rest.some((w) => w.dynamic))
      return denied("eval: cannot check the inner command");
    return detectIn(rest.map((w) => w.text).join(" "), options, depth + 1, "eval");
  }
  return name === "gh" ? gh(argv.slice(1), options, depth) : NONE;
}
function detectIn(src, options, depth, where) {
  if (depth > 8)
    return denied(`${where}: nests too deep`);
  const lexed = lexShell(src);
  if (!lexed.ok)
    return denied(`${where}: cannot parse (${lexed.error})`);
  const result = combine(lexed.commands.map((c) => detectCommand(c, options, depth)));
  if (result.kind === "merge" && result.targets.some((t) => t.repo === undefined) && changesRepoContext(lexed.commands))
    return denied(`${where}: changes directory or GH_REPO before a merge; name the PR with -R owner/repo or a URL`);
  return result;
}
function detectMerge(command, options = {}) {
  return detectIn(command, options, 0, "command");
}
// plugin/hooks/hook.ts
var HOOK_EVENTS = [
  "session-start",
  "prompt-submit",
  "pre-bash",
  "session-end"
];
var CONTEXT_MAX = 8000;
var QUICK_MS = 3000;
var DIGEST_MS = 5000;
var GATE_TIMEOUT_MS = 20000;
var str = (value) => typeof value === "string" && value !== "" ? value : undefined;
function sessionFlags(input, deps) {
  const session = str(input.session_id);
  if (session === undefined)
    return null;
  const role = deps.role === "worker" ? "worker" : "lead";
  return ["--session", session, "--harness", "claude-code", "--role", role];
}
function cap(text) {
  const trimmed = text.trim();
  return trimmed.length > CONTEXT_MAX ? `${trimmed.slice(0, CONTEXT_MAX - 1)}…` : trimmed;
}
function output(result) {
  return result.code === 0 ? result.stdout : "";
}
function context(event, parts) {
  const text = cap(parts.filter((p) => p.trim() !== "").join(`

`));
  if (text === "")
    return null;
  return {
    hookSpecificOutput: { hookEventName: event, additionalContext: text }
  };
}
function sessionStart(input, cwd, deps) {
  const flags = sessionFlags(input, deps);
  if (flags)
    deps.cli(["session", "beat", ...flags], { cwd, timeoutMs: QUICK_MS });
  deps.cli(["sync", "--detach"], { cwd, timeoutMs: QUICK_MS });
  const digest = output(deps.cli(["--format", "context"], { cwd, timeoutMs: DIGEST_MS }));
  return context("SessionStart", [digest]);
}
function promptSubmit(input, cwd, deps) {
  const flags = sessionFlags(input, deps);
  if (flags === null)
    return null;
  deps.cli(["session", "beat", ...flags], { cwd, timeoutMs: QUICK_MS });
  deps.cli(["sync", "--detach"], { cwd, timeoutMs: QUICK_MS });
  if (deps.role === "worker")
    return null;
  const items = output(deps.cli(["inbox", "--session", flags[1] ?? "", "--claim", "--format", "context"], { cwd, timeoutMs: DIGEST_MS }));
  return context("UserPromptSubmit", [items]);
}
function sessionEnd(input, cwd, deps) {
  const session = str(input.session_id);
  if (session !== undefined)
    deps.cli(["session", "end", "--session", session], {
      cwd,
      timeoutMs: QUICK_MS
    });
  return null;
}
var deny = (reason) => ({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: `crew-net merge gate: ${reason}`
  }
});
function gateVerdict(result) {
  const down = "merges are refused while the gate cannot decide";
  if (result.code === null)
    return { allow: false, reason: `the gate did not finish; ${down}` };
  if (result.code !== 0)
    return {
      allow: false,
      reason: `the gate failed (exit ${result.code}); ${down}`
    };
  let answer;
  try {
    answer = JSON.parse(result.stdout);
  } catch {
    return { allow: false, reason: `the gate gave no JSON; ${down}` };
  }
  if (typeof answer !== "object" || answer === null)
    return { allow: false, reason: `the gate gave no decision; ${down}` };
  const { decision, reasons } = answer;
  if (decision === "allow")
    return { allow: true };
  if (decision === "deny") {
    const why = Array.isArray(reasons) ? reasons.filter((r) => typeof r === "string").join("; ") : "";
    return { allow: false, reason: why || "depends-on is not satisfied" };
  }
  return { allow: false, reason: `the gate gave no decision; ${down}` };
}
function preBash(input, cwd, deps) {
  const toolInput = input.tool_input;
  const command = toolInput?.command;
  if (typeof command !== "string")
    return deny("cannot read the Bash command");
  const detected = detectMerge(command);
  if (detected.kind === "none")
    return null;
  if (detected.kind === "deny")
    return deny(detected.reason);
  const verdict = gateVerdict(deps.cli(["gate", "--json", "--", command], {
    cwd,
    timeoutMs: GATE_TIMEOUT_MS
  }));
  return verdict.allow ? null : deny(verdict.reason);
}
function handle(event, input, deps) {
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
function parseInput(raw) {
  try {
    const value = JSON.parse(raw);
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
function nodeCli(cliPath) {
  return (args, { cwd, timeoutMs }) => {
    const ran = spawnSync(process.execPath, [cliPath, ...args], {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4 * 1024 * 1024
    });
    if (ran.error !== undefined || ran.signal !== null)
      return { code: null, stdout: "" };
    return { code: ran.status, stdout: ran.stdout ?? "" };
  };
}

// plugin/hooks/hook-main.ts
var event = process.argv[2];
if (!HOOK_EVENTS.some((e) => e === event)) {
  process.stderr.write(`crew-net hook: unknown event ${event}
`);
} else {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {}
  const here = dirname(fileURLToPath(import.meta.url));
  const out = handle(event, parseInput(raw), {
    cli: nodeCli(join(here, "..", "..", "bin", "crew-net")),
    role: process.env.CREW_NET_ROLE
  });
  if (out !== null)
    process.stdout.write(`${JSON.stringify(out)}
`);
}
