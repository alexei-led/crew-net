/** One closing-keyword reference found in text. */
export interface ClosingKeywordMatch {
  /** 1-based line where the keyword starts. */
  line: number;
  /** The keyword as written, for example `Closes`. */
  keyword: string;
  /** The reference it points at: `#945`, `owner/repo#945`, `GH-945` or an issue URL. */
  reference: string;
}

// Mirrors GitHub's grammar and over-matches where the docs are silent (markdown
// emphasis incl. `_fixes_`, a newline between keyword and reference, `GH-N`, issue URLs
// on github.com, www.github.com and `*.ghe.com`): a
// false positive costs one reworded sentence, a miss closes an issue unverified.
const CLOSING_KEYWORD =
  /(?<![A-Za-z0-9])(close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?![A-Za-z0-9])[\s:*_]*(https?:\/\/(?:(?:www\.)?github\.com|[\w-]+(?:\.[\w-]+)*\.ghe\.com)\/[\w.-]+\/[\w.-]+\/issues\/\d+|(?:[\w.-]+\/[\w.-]+)?(?:#|GH-)\d+)\b/gi;

/** Every closing-keyword reference in `text`, in document order. HTML comments are scanned. */
export function findClosingKeywords(text: string): ClosingKeywordMatch[] {
  return [...text.matchAll(CLOSING_KEYWORD)].map((m) => ({
    line: text.slice(0, m.index).split("\n").length,
    keyword: m[1] ?? "",
    reference: m[2] ?? "",
  }));
}
