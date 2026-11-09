/**
 * A tolerant bash reader for merge detection. It finds the simple commands a
 * line runs, including those inside `$(...)`, backticks and `<(...)`, so a
 * merge cannot hide behind `;`, `&&`, `|` or a substitution. It does not run
 * anything and does not expand anything: a word whose value depends on the
 * shell (variable, substitution, glob, brace list) is marked `dynamic`.
 */

export interface Word {
  /** Value after quote removal. Expansions are left out. */
  text: string;
  /** True when bash would change the word: `$x`, `$(...)`, glob, brace list, leading `~`. */
  dynamic: boolean;
}

export type Lexed =
  | { ok: true; commands: Word[][] }
  | { ok: false; error: string };

/** Characters that end a word and separate commands. */
const SEPARATORS = new Set([";", "&", "|", "\n", "(", ")"]);
const DQ_ESCAPABLE = new Set(["$", "`", '"', "\\", "\n"]);
const MAX_DEPTH = 8;

interface Heredoc {
  delimiter: string;
  stripTabs: boolean;
  /** A quoted delimiter makes the body literal; otherwise bash expands `$(...)` in it. */
  quoted: boolean;
}

class Reader {
  i = 0;
  readonly commands: Word[][] = [];
  private current: Word[] = [];
  private word: Word | null = null;
  /** Unquoted text of the current word, to spot brace lists. */
  private bare = "";
  private pendingHeredocs: Heredoc[] = [];
  /** The next word is a redirection target, not an argument. */
  private redirectTarget = false;
  /** Open `(` inside a substitution body. */
  private parens = 0;
  /** In a substitution body: index of the `)` that closed it, or -1. */
  closedAt = -1;

  constructor(
    readonly src: string,
    readonly depth: number,
    /** Read a `$(...)` body: stop at the `)` that closes it. */
    readonly substitutionBody = false,
  ) {}

  private start(): Word {
    this.word ??= { text: "", dynamic: false };
    return this.word;
  }

  private append(text: string): void {
    this.start().text += text;
  }

  private markDynamic(): void {
    this.start().dynamic = true;
  }

  private endWord(): void {
    if (this.word === null) return;
    if (/\{[^}]*(,|\.\.)[^}]*\}/.test(this.bare)) this.word.dynamic = true;
    if (this.redirectTarget) this.redirectTarget = false;
    else this.current.push(this.word);
    this.word = null;
    this.bare = "";
  }

  private endCommand(): void {
    this.endWord();
    const words = this.current.filter(
      (w) => w.dynamic || !(w.text === "{" || w.text === "}"),
    );
    if (words.length > 0) this.commands.push(words);
    this.current = [];
  }

  /** Read a nested backtick body and keep its commands. */
  private nested(body: string): string | null {
    if (this.depth >= MAX_DEPTH) return "substitutions nest too deep";
    const inner = lex(body, this.depth + 1);
    if (!inner.ok) return inner.error;
    this.commands.push(...inner.commands);
    return null;
  }

  /** Keep the commands of `$(...)` and backticks in text bash expands like a double-quoted string. */
  private expansionsIn(text: string): string | null {
    if (!/\$\(|`/.test(text)) return null;
    return this.nested(`echo "${text.replaceAll('"', '\\"')}"`);
  }

  /** At `$(`, `<(` or `>(`. Reads the body in place, so quotes and here-documents inside it are handled. */
  private substitution(): string | null {
    if (this.depth >= MAX_DEPTH) return "substitutions nest too deep";
    const inner = new Reader(this.src, this.depth + 1, true);
    inner.i = this.i + 2;
    const result = inner.run();
    if (!result.ok) return result.error;
    if (inner.closedAt < 0) return "unterminated substitution";
    this.commands.push(...result.commands);
    this.markDynamic();
    this.i = inner.closedAt + 1;
    return null;
  }

  private backtick(): string | null {
    let body = "";
    for (let j = this.i + 1; j < this.src.length; j++) {
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

  /** `$` outside single quotes. Returns an error or null. */
  private dollar(): string | null {
    const next = this.src.charAt(this.i + 1);
    if (next === "(") return this.substitution();
    if (next === "{") {
      const end = this.src.indexOf("}", this.i);
      if (end < 0) return "unterminated parameter expansion";
      this.markDynamic();
      const body = this.src.slice(this.i + 2, end);
      this.i = end + 1;
      return this.expansionsIn(body);
    }
    if (/[A-Za-z0-9_@*#?$!-]/.test(next)) {
      this.markDynamic();
      this.i += 2;
      if (/[A-Za-z_]/.test(next))
        while (/[A-Za-z0-9_]/.test(this.src.charAt(this.i))) this.i++;
      return null;
    }
    this.append("$");
    this.i++;
    return null;
  }

  private singleQuoted(): string | null {
    const end = this.src.indexOf("'", this.i + 1);
    if (end < 0) return "unterminated quote";
    this.append(this.src.slice(this.i + 1, end));
    this.i = end + 1;
    return null;
  }

  /** `$'...'`: ANSI-C quoting. Escapes other than `\'` and `\\` make the word dynamic. */
  private ansiQuoted(): string | null {
    let text = "";
    for (let j = this.i + 2; j < this.src.length; j++) {
      const c = this.src.charAt(j);
      if (c === "'") {
        this.append(text);
        this.i = j + 1;
        return null;
      }
      if (c === "\\") {
        const e = this.src.charAt(++j);
        if (e === "'" || e === "\\") text += e;
        else this.markDynamic();
      } else {
        text += c;
      }
    }
    return "unterminated quote";
  }

  private doubleQuoted(): string | null {
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
          if (e !== "\n") this.append(e);
        } else {
          this.append(`\\${e}`);
        }
        this.i += 2;
      } else if (c === "$") {
        const error = this.dollar();
        if (error) return error;
      } else if (c === "`") {
        const error = this.backtick();
        if (error) return error;
      } else {
        this.append(c);
        this.i++;
      }
    }
    return "unterminated quote";
  }

  /** `<`, `>` and their forms. The following word is a file, not an argument. */
  private redirect(): string | null {
    const c = this.src.charAt(this.i);
    const next = this.src.charAt(this.i + 1);
    if (next === "(") return this.substitution();
    // A word of digits just before the operator is a file descriptor.
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
        if (heredoc === null) return "missing here-document delimiter";
        // `(( x << 2 ))` is a shift, not a here-document.
        if (!heredoc.quoted && /^\d+$/.test(heredoc.delimiter)) return null;
        this.pendingHeredocs.push(heredoc);
        return null;
      }
    } else {
      this.i += next === ">" || next === "&" || next === "|" ? 2 : 1;
    }
    this.redirectTarget = true;
    return null;
  }

  private heredocDelimiter(stripTabs: boolean): Heredoc | null {
    while (this.src.charAt(this.i) === " " || this.src.charAt(this.i) === "\t")
      this.i++;
    const m = /^(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()]+))/.exec(
      this.src.slice(this.i),
    );
    if (!m) return null;
    this.i += m[0].length;
    const raw = m[1] ?? m[2] ?? m[3] ?? "";
    return {
      delimiter: raw.replaceAll("\\", ""),
      stripTabs,
      quoted: m[3] === undefined || raw.includes("\\"),
    };
  }

  /** After a newline: read here-document bodies. Their text is data, except substitutions in an unquoted one. */
  private skipHeredocs(): string | null {
    for (const { delimiter, stripTabs, quoted } of this.pendingHeredocs) {
      let found = false;
      let body = "";
      while (this.i < this.src.length) {
        const eol = this.src.indexOf("\n", this.i);
        const end = eol < 0 ? this.src.length : eol;
        let line = this.src.slice(this.i, end);
        if (stripTabs) line = line.replace(/^\t+/, "");
        this.i = end + 1;
        if (line === delimiter) {
          found = true;
          break;
        }
        body += `${line}\n`;
      }
      if (!found) return "unterminated here-document";
      const error = quoted ? null : this.expansionsIn(body);
      if (error) return error;
    }
    this.pendingHeredocs = [];
    return null;
  }

  run(): Lexed {
    const src = this.src;
    while (this.i < src.length) {
      const c = src.charAt(this.i);
      let error: string | null = null;
      if (c === "'") {
        error = this.singleQuoted();
      } else if (c === '"') {
        error = this.doubleQuoted();
      } else if (c === "$" && src.charAt(this.i + 1) === "'") {
        error = this.ansiQuoted();
      } else if (c === "$" && src.charAt(this.i + 1) === '"') {
        // `$"..."` is a locale-translated double-quoted string.
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
        if (e !== "\n") this.append(e);
        this.i += 2;
      } else if (c === "#" && this.word === null) {
        const eol = src.indexOf("\n", this.i);
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
        if (c === "\n") error = this.skipHeredocs();
      } else if (c === " " || c === "\t") {
        this.endWord();
        this.i++;
      } else {
        if (
          "*?[".includes(c) ||
          (c === "~" && (this.word === null || /[=:]$/.test(this.bare)))
        )
          this.markDynamic();
        this.append(c);
        this.bare += c;
        this.i++;
      }
      if (error) return { ok: false, error };
    }
    this.endCommand();
    return { ok: true, commands: this.commands };
  }
}

function lex(src: string, depth: number): Lexed {
  return new Reader(src, depth).run();
}

/** Split a bash command line into the simple commands it runs. */
export function lexShell(src: string): Lexed {
  return lex(src, 0);
}
