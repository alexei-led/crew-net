/** A consumer glob. `repo` is set for `owner/repo:pattern`: a path in another repo. */
export interface ContractConsumer {
  repo?: string;
  pattern: string;
}

export interface Contract {
  name: string;
  /** Globs of the paths that define the contract. */
  producer: string[];
  consumers: ContractConsumer[];
}

/** `.github/crew-net.yml`, the subset crew-net reads. */
export interface RepoConfig {
  contracts: Contract[];
  /** Branches whose merge deploys. */
  deployBranches: string[];
  /** Logins to ignore in addition to the built-in bots. */
  bots: string[];
  /** Open a draft PR at the first push. */
  earlyDrafts: boolean;
  /** Repo default for agents merging their own PR. */
  agentsMerge: boolean;
}

export type ParseRepoConfigResult =
  | { ok: true; config: RepoConfig }
  | { ok: false; line: number | null; detail: string };

/** Producers used when the repo declares no `contracts` (design §10.1). */
export const DEFAULT_PRODUCER_PATTERNS = [
  "**/migrations/**",
  "**/*migration*",
  "api/openapi/**",
  "**/*.proto",
];

/** Without a config, every path that is not a producer consumes. */
export const DEFAULT_CONTRACT: Contract = {
  name: "schema",
  producer: DEFAULT_PRODUCER_PATTERNS,
  consumers: [{ pattern: "**" }],
};

export const DEFAULT_REPO_CONFIG: RepoConfig = {
  contracts: [DEFAULT_CONTRACT],
  deployBranches: ["main", "master"],
  bots: [],
  earlyDrafts: false,
  agentsMerge: false,
};

// The reader accepts block mappings, block sequences, one-line `[a, b]`
// sequences, plain and quoted scalars and `#` comments. Anything else (flow
// maps, anchors, tags, multi-line scalars, tabs) is refused with its line.
// Upgrade trigger: a config field that needs more than this subset.

type Node = string | boolean | null | Node[] | Map<string, Node>;

class ConfigError extends Error {
  constructor(
    readonly line: number | null,
    detail: string,
  ) {
    super(detail);
  }
}

interface Line {
  no: number;
  indent: number;
  text: string;
}

const isSpace = (char: string | undefined): boolean =>
  char === undefined || char === " " || char === "\t";

/** A quote opens only at the start of a token, so `don't` stays plain. */
const opensQuote = (text: string, i: number): boolean => {
  const char = text[i];
  if (char !== '"' && char !== "'") return false;
  const prev = text[i - 1];
  return isSpace(prev) || prev === "[" || prev === ",";
};

/** Index of the first `separator` that is outside quotes, or -1. */
function indexOutsideQuotes(text: string, separator: (i: number) => boolean) {
  let quote: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\" && quote === '"') i++;
      else if (char === quote) quote = null;
    } else if (opensQuote(text, i)) quote = char ?? null;
    else if (separator(i)) return i;
  }
  return -1;
}

function stripComment(text: string): string {
  const at = indexOutsideQuotes(
    text,
    (i) => text[i] === "#" && isSpace(text[i - 1]),
  );
  return (at < 0 ? text : text.slice(0, at)).trimEnd();
}

function tokenize(source: string): Line[] {
  const lines: Line[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    const no = index + 1;
    if (raw.trimEnd() === "---" && lines.length === 0) return;
    const text = stripComment(raw);
    if (text.trim() === "") return;
    const indent = text.length - text.trimStart().length;
    if (text.slice(0, indent).includes("\t"))
      throw new ConfigError(no, "tabs are not allowed for indentation");
    lines.push({ no, indent, text: text.slice(indent) });
  });
  return lines;
}

function unquote(token: string, no: number): string {
  const quote = token[0];
  if (token.length < 2 || token[token.length - 1] !== quote)
    throw new ConfigError(no, `bad quoted string ${token}`);
  const inner = token.slice(1, -1);
  if (quote === "'") {
    if (/'(?!')/.test(inner.replace(/''/g, "")))
      throw new ConfigError(no, `text after closing quote in ${token}`);
    return inner.replace(/''/g, "'");
  }
  if (/(?<!\\)(?:\\\\)*"/.test(inner))
    throw new ConfigError(no, `text after closing quote in ${token}`);
  return inner.replace(/\\(["\\])/g, "$1");
}

function scalar(token: string, no: number): Node {
  if (token === "" || token === "~" || token === "null") return null;
  if (token === "-" || token.startsWith("- "))
    throw new ConfigError(no, `nested list item is not supported: ${token}`);
  if (token === "true") return true;
  if (token === "false") return false;
  if (token[0] === '"' || token[0] === "'") return unquote(token, no);
  if (/^[&*!|>{@`%]/.test(token))
    throw new ConfigError(no, `unsupported YAML syntax: ${token}`);
  if (token.includes(": "))
    throw new ConfigError(no, `unexpected ': ' in value ${token}`);
  return token;
}

function flowSequence(token: string, no: number): Node[] {
  if (!token.endsWith("]"))
    throw new ConfigError(no, "a [..] list must close on the same line");
  const inner = token.slice(1, -1);
  const items: Node[] = [];
  let rest = inner;
  while (rest.trim() !== "") {
    const comma = indexOutsideQuotes(rest, (i) => rest[i] === ",");
    const part = (comma < 0 ? rest : rest.slice(0, comma)).trim();
    if (part === "") throw new ConfigError(no, "empty item in list");
    if (part[0] === "[" || part[0] === "{")
      throw new ConfigError(no, "nested lists and maps are not supported");
    items.push(scalar(part, no));
    if (comma < 0) break;
    rest = rest.slice(comma + 1);
    if (rest.trim() === "") throw new ConfigError(no, "trailing comma in list");
  }
  return items;
}

function inline(token: string, no: number): Node {
  if (token[0] === "[") return flowSequence(token, no);
  return scalar(token, no);
}

const KEY_LINE = /^([A-Za-z0-9_.-]+):(?:[ ]+(.*))?$/;
const isItem = (line: Line): boolean =>
  line.text === "-" || line.text.startsWith("- ");

function parseDocument(lines: Line[]): Node {
  let at = 0;

  const block = (indent: number): Node => {
    const line = lines[at];
    if (!line) return null;
    return isItem(line) ? sequence(indent) : mapping(indent);
  };

  const sequence = (indent: number): Node[] => {
    const items: Node[] = [];
    for (let line = lines[at]; line; line = lines[at]) {
      if (line.indent !== indent || !isItem(line)) break;
      const rest = line.text.slice(1).trimStart();
      if (rest === "") {
        at++;
        const next = lines[at];
        items.push(next && next.indent > indent ? block(next.indent) : null);
      } else if (KEY_LINE.test(rest) && rest[0] !== '"' && rest[0] !== "'") {
        // "- key: v": the item is a mapping that starts on this line.
        const offset = line.text.length - rest.length;
        lines[at] = { no: line.no, indent: indent + offset, text: rest };
        items.push(mapping(indent + offset));
      } else {
        at++;
        items.push(inline(rest, line.no));
      }
    }
    return items;
  };

  const mapping = (indent: number): Node => {
    const map = new Map<string, Node>();
    for (let line = lines[at]; line; line = lines[at]) {
      if (line.indent < indent) break;
      if (line.indent > indent)
        throw new ConfigError(line.no, "unexpected indentation");
      if (isItem(line)) throw new ConfigError(line.no, "unexpected list item");
      const match = KEY_LINE.exec(line.text);
      const key = match?.[1];
      if (key === undefined)
        throw new ConfigError(
          line.no,
          `expected "key: value", got ${line.text}`,
        );
      if (map.has(key)) throw new ConfigError(line.no, `duplicate key ${key}`);
      const value = (match?.[2] ?? "").trim();
      at++;
      if (value !== "") {
        map.set(key, inline(value, line.no));
        continue;
      }
      const next = lines[at];
      if (next && next.indent > indent) map.set(key, block(next.indent));
      else if (next && next.indent === indent && isItem(next))
        map.set(key, sequence(indent));
      else map.set(key, null);
    }
    return map;
  };

  const first = lines[0];
  if (!first) return new Map();
  if (first.indent !== 0 || isItem(first))
    throw new ConfigError(first.no, "expected top-level keys");
  const root = mapping(0);
  const stray = lines[at];
  if (stray) throw new ConfigError(stray.no, "unexpected indentation");
  return root;
}

const typeName = (node: Node): string =>
  node === null
    ? "empty"
    : Array.isArray(node)
      ? "list"
      : node instanceof Map
        ? "map"
        : typeof node;

function strings(node: Node | undefined, what: string): string[] {
  if (node === undefined || node === null) return [];
  const items = Array.isArray(node) ? node : [node];
  return items.map((item) => {
    if (typeof item !== "string" || item === "")
      throw new ConfigError(null, `${what} must be a list of strings`);
    return item;
  });
}

function boolean(node: Node | undefined, what: string, fallback: boolean) {
  if (node === undefined || node === null) return fallback;
  if (typeof node !== "boolean")
    throw new ConfigError(null, `${what} must be true or false`);
  return node;
}

const CONSUMER = /^([\w.-]+\/[\w.-]+):(.+)$/;

function consumer(text: string): ContractConsumer {
  const match = CONSUMER.exec(text);
  const repo = match?.[1];
  const pattern = match?.[2];
  return repo !== undefined && pattern !== undefined
    ? { repo, pattern }
    : { pattern: text };
}

function contract(node: Node, index: number): Contract {
  const where = `contracts[${index}]`;
  if (!(node instanceof Map))
    throw new ConfigError(
      null,
      `${where} must be a mapping, got ${typeName(node)}`,
    );
  const name = node.get("name");
  if (typeof name !== "string" || name === "")
    throw new ConfigError(null, `${where} needs a name`);
  const producer = strings(node.get("producer"), `${where}.producer`);
  const consumers = strings(node.get("consumers"), `${where}.consumers`);
  if (producer.length === 0)
    throw new ConfigError(null, `${where} (${name}) needs a producer`);
  if (consumers.length === 0)
    throw new ConfigError(null, `${where} (${name}) needs consumers`);
  return { name, producer, consumers: consumers.map(consumer) };
}

function toConfig(root: Node): RepoConfig {
  if (!(root instanceof Map)) throw new ConfigError(null, "expected a mapping");
  const contracts = root.get("contracts");
  if (
    contracts !== undefined &&
    contracts !== null &&
    !Array.isArray(contracts)
  )
    throw new ConfigError(null, "contracts must be a list");
  const deploy = root.get("deploy-branches");
  return {
    contracts:
      contracts === undefined
        ? DEFAULT_REPO_CONFIG.contracts
        : (contracts ?? []).map(contract),
    deployBranches:
      deploy === undefined
        ? DEFAULT_REPO_CONFIG.deployBranches
        : strings(deploy, "deploy-branches"),
    bots: strings(root.get("bots"), "bots"),
    earlyDrafts: boolean(
      root.get("early-drafts"),
      "early-drafts",
      DEFAULT_REPO_CONFIG.earlyDrafts,
    ),
    agentsMerge: boolean(
      root.get("agents-merge"),
      "agents-merge",
      DEFAULT_REPO_CONFIG.agentsMerge,
    ),
  };
}

/**
 * Read `.github/crew-net.yml`. Missing keys take the defaults of design §10.1;
 * unknown keys are ignored. Text this subset cannot read gives an error with
 * the line when there is one. Never throws.
 */
export function parseRepoConfig(text: string): ParseRepoConfigResult {
  try {
    return { ok: true, config: toConfig(parseDocument(tokenize(text))) };
  } catch (error) {
    if (error instanceof ConfigError)
      return { ok: false, line: error.line, detail: error.message };
    throw error;
  }
}
