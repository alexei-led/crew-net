import { describe, expect, test } from "bun:test";
import { findClosingKeywords } from "./index";

describe("findClosingKeywords", () => {
  // Cases from reflex check-pr-body.py self-check, plus the forms in its grammar notes.
  test.each([
    ["closes #945", "closes", "#945"],
    ["Closes: #945", "Closes", "#945"],
    ["CLOSES #945", "CLOSES", "#945"],
    ["CLOSES: #945", "CLOSES", "#945"],
    ["fixes doiteng/reflex#945", "fixes", "doiteng/reflex#945"],
    ["resolved #945", "resolved", "#945"],
    ["**closes** #945", "closes", "#945"],
    ["No closing keyword: monitor verifies and closes #945.", "closes", "#945"],
    [
      "closes https://github.com/doiteng/reflex/issues/945",
      "closes",
      "https://github.com/doiteng/reflex/issues/945",
    ],
    [
      "fixes https://www.github.com/doiteng/reflex/issues/945",
      "fixes",
      "https://www.github.com/doiteng/reflex/issues/945",
    ],
    [
      "closes https://octocorp.ghe.com/doiteng/reflex/issues/945",
      "closes",
      "https://octocorp.ghe.com/doiteng/reflex/issues/945",
    ],
    [
      "Resolves http://a.b.ghe.com/o/r/issues/1",
      "Resolves",
      "http://a.b.ghe.com/o/r/issues/1",
    ],
    ["and closes\n#945.", "closes", "#945"],
    ["closes GH-945", "closes", "GH-945"],
    ["closes#945", "closes", "#945"],
    ["_fixes_ #7", "fixes", "#7"],
  ])("finds %j", (text, keyword, reference) => {
    expect(findClosingKeywords(text)).toMatchObject([{ keyword, reference }]);
  });

  test.each([
    "close",
    "closes",
    "closed",
    "fix",
    "fixes",
    "fixed",
    "resolve",
    "resolves",
    "resolved",
  ])("covers GitHub keyword %s in any case", (keyword) => {
    const capitalised = `${keyword.slice(0, 1).toUpperCase()}${keyword.slice(1)}`;
    for (const word of [keyword, keyword.toUpperCase(), capitalised]) {
      expect(findClosingKeywords(`${word} #1`)).toHaveLength(1);
    }
  });

  test.each([
    "Refs #945",
    "Fingerprint: [mon] perf #945",
    "#945 stays open",
    "the fix closes a gap; see #945",
    "closing #945",
    "disclose #945",
    "prefix #945",
    "closes the loop.\n\n#945 stays open",
    "see https://octocorp.ghe.com/doiteng/reflex/issues/945",
    "closes https://example.com/doiteng/reflex/issues/945",
    "closes https://notghe.com/doiteng/reflex/issues/945",
    "",
  ])("ignores %j", (text) => {
    expect(findClosingKeywords(text)).toEqual([]);
  });

  test("scans text inside HTML comments", () => {
    expect(
      findClosingKeywords("<!-- crew-net\nnote: fixes #3\n-->"),
    ).toMatchObject([{ line: 2, keyword: "fixes" }]);
  });

  test("reports 1-based lines and every match in order", () => {
    const text = "intro\nCloses #1\n\nplain\nand fixes owner/repo#2";
    expect(findClosingKeywords(text)).toEqual([
      { line: 2, keyword: "Closes", reference: "#1" },
      { line: 5, keyword: "fixes", reference: "owner/repo#2" },
    ]);
  });
});
