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

class Reader {
  i = 0;
  readonly commands: Word[][] = [];
  private current: Word[] = [];
  private word: Word | null = null;
  /** Unquoted text of the current word, to spot brace lists. */
  private bare = "";
  private pendingHeredocs: { delimiter: string; stripTabs: boolean }[] = [];
  /** The next word is a redirection target, not an argument. */
  private redirectTarget = false;

  constructor(
    readonly src: string,
    readonly depth: number,
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

  /** Read a nested `$(...)`, `<(...)` or backtick body and keep its commands. */
  private nested(body: string): string | null {
    if (this.depth >= MAX_DEPTH) return "substitutions nest too deep";
    const inner = lex(body, this.depth + 1);
    if (!inner.ok) return inner.error;
    this.commands.push(...inner.commands);
    return null;
  }

  /** Index just past the `)` that closes the `(` before `from`, or -1. */
  private closingParen(from: number): number {
    let level = 1;
    let quote: "'" | '"' | null = null;
    for (let j = from; j < this.src.length; j++) {
      const c = this.src.charAt(j);
      if (quote === "'") {
        if (c === "'") quote = null;
      } else if (c === "\\") {
        j++;
      } else if (quote === '"') {
        if (c === '"') quote = null;
      } else if (c === "'" || c === '"') {
        quote = c;
      } else if (c === "(") {
        level++;
      } else if (c === ")" && --level === 0) {
        return j + 1;
      }
    }
    return -1;
  }

  private substitution(): string | null {
    // At `$(` or `<(` / `>(`; i points at the opener's first char.
    const open = this.i + 2;
    const end = this.closingParen(open);
    if (end < 0) return "unterminated substitution";
    this.markDynamic();
    this.i = end;
    return this.nested(this.src.slice(open, end - 1));
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
      this.i = end + 1;
      return null;
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
        const delimiter = this.heredocDelimiter();
        if (delimiter === null) return "missing here-document delimiter";
        this.pendingHeredocs.push({ delimiter, stripTabs });
        return null;
      }
    } else {
      this.i += next === ">" || next === "&" || next === "|" ? 2 : 1;
    }
    this.redirectTarget = true;
    return null;
  }

  private heredocDelimiter(): string | null {
    while (this.src.charAt(this.i) === " " || this.src.charAt(this.i) === "\t")
      this.i++;
    const m = /^(?:'([^']*)'|"([^"]*)"|([^\s;&|<>()]+))/.exec(
      this.src.slice(this.i),
    );
    if (!m) return null;
    this.i += m[0].length;
    return (m[1] ?? m[2] ?? m[3] ?? "").replaceAll("\\", "");
  }

  /** After a newline: skip here-document bodies. Their text is data. */
  private skipHeredocs(): string | null {
    for (const { delimiter, stripTabs } of this.pendingHeredocs) {
      let found = false;
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
      }
      if (!found) return "unterminated here-document";
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
    if (this.pendingHeredocs.length > 0) {
      // A here-document at the very end of the line has no body yet: bash reads it from stdin.
      this.pendingHeredocs = [];
    }
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
