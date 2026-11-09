import { describe, expect, test } from "bun:test";
import {
  DEFAULT_CONTRACT,
  DEFAULT_PRODUCER_PATTERNS,
  DEFAULT_REPO_CONFIG,
  parseRepoConfig,
  type RepoConfig,
} from "./index";

const read = (text: string): RepoConfig => {
  const result = parseRepoConfig(text);
  if (!result.ok) throw new Error(`line ${result.line}: ${result.detail}`);
  return result.config;
};

const designExample = `# .github/crew-net.yml
contracts:
  - name: api
    producer: [api/openapi/**]
    consumers: [web/src/api/**, "doiteng/omni:clients/reflex/**"]
  - name: db
    producer: ["**/migrations/**"]
    consumers: ["api/**/models/**"]
`;

describe("defaults", () => {
  test.each([
    ["empty file", ""],
    ["only comments", "# nothing here\n\n  # still nothing\n"],
    ["only unknown keys", "future-key: 1\n"],
  ])("%s gives the defaults", (_name, text) => {
    expect(read(text)).toEqual(DEFAULT_REPO_CONFIG);
  });

  test("default contract matches design 10.1", () => {
    expect(DEFAULT_PRODUCER_PATTERNS).toEqual([
      "**/migrations/**",
      "**/*migration*",
      "api/openapi/**",
      "**/*.proto",
    ]);
    expect(DEFAULT_REPO_CONFIG.contracts).toEqual([DEFAULT_CONTRACT]);
    expect(DEFAULT_CONTRACT.consumers).toEqual([{ pattern: "**" }]);
  });

  test("other keys keep their defaults when only contracts are set", () => {
    expect(read(designExample)).toMatchObject({
      deployBranches: DEFAULT_REPO_CONFIG.deployBranches,
      bots: [],
      earlyDrafts: false,
      agentsMerge: false,
    });
  });
});

describe("contracts", () => {
  test("reads the example from design 10.1", () => {
    expect(read(designExample).contracts).toEqual([
      {
        name: "api",
        producer: ["api/openapi/**"],
        consumers: [
          { pattern: "web/src/api/**" },
          { repo: "doiteng/omni", pattern: "clients/reflex/**" },
        ],
      },
      {
        name: "db",
        producer: ["**/migrations/**"],
        consumers: [{ pattern: "api/**/models/**" }],
      },
    ]);
  });

  test("block lists, same-indent lists, comments and a scalar producer", () => {
    const text = `contracts:
- name: api   # the public api
  producer:
    - api/openapi/**
    - "api/**/*.proto"
  consumers:
  - web/**
  - 'o/r:clients/**'
- name: db
  producer: db/migrations/**
  consumers: [src/**]
`;
    expect(read(text).contracts).toEqual([
      {
        name: "api",
        producer: ["api/openapi/**", "api/**/*.proto"],
        consumers: [
          { pattern: "web/**" },
          { repo: "o/r", pattern: "clients/**" },
        ],
      },
      {
        name: "db",
        producer: ["db/migrations/**"],
        consumers: [{ pattern: "src/**" }],
      },
    ]);
  });

  test("explicit empty contracts replace the defaults", () => {
    expect(read("contracts: []\n").contracts).toEqual([]);
    expect(read("contracts:\n").contracts).toEqual([]);
  });

  test("a hash inside quotes is not a comment, a comma inside quotes does not split", () => {
    const text =
      'contracts:\n  - name: "a # b"\n    producer: ["x,y/**", \'z # w\']\n    consumers: [q/**]\n';
    expect(read(text).contracts[0]).toMatchObject({
      name: "a # b",
      producer: ["x,y/**", "z # w"],
    });
  });

  test("a prefix needs owner/repo, other colons stay in the pattern", () => {
    const text =
      'contracts:\n  - name: a\n    producer: [p/**]\n    consumers: ["just:colon/**", "o/r:x/**", "a/b/c:y"]\n';
    expect(read(text).contracts[0]?.consumers).toEqual([
      { pattern: "just:colon/**" },
      { repo: "o/r", pattern: "x/**" },
      { pattern: "a/b/c:y" },
    ]);
  });
});

describe("other keys", () => {
  test("reads every key", () => {
    const text = `deploy-branches: [main, dev]
bots:
  - my-release-bot
  - "other[bot]"
early-drafts: true
agents-merge: false
unknown-key:
  nested: value
  more: [1, 2]
`;
    expect(read(text)).toEqual({
      ...DEFAULT_REPO_CONFIG,
      deployBranches: ["main", "dev"],
      bots: ["my-release-bot", "other[bot]"],
      earlyDrafts: true,
      agentsMerge: false,
    });
  });

  test("accepts a leading document-start marker", () => {
    expect(read("---\nearly-drafts: true\n")).toMatchObject({
      earlyDrafts: true,
    });
  });

  test("~ and null are empty, not text", () => {
    expect(read("bots: ~\n").bots).toEqual([]);
    expect(read("bots: null\n").bots).toEqual([]);
  });

  test("handles CRLF line endings", () => {
    expect(read("early-drafts: true\r\nbots: [a]\r\n")).toMatchObject({
      earlyDrafts: true,
      bots: ["a"],
    });
  });
});

describe("errors", () => {
  test.each<[string, string, number | null, string]>([
    ["a nested list item", "bots: - renovate\n", 1, "nested list item"],
    [
      "a list inside a list",
      "contracts:\n  - name: a\n    producer: [p]\n    consumers:\n      - - web/**\n",
      5,
      "nested list item",
    ],
    ["a tab for indentation", "contracts:\n\t- name: a\n", 2, "tabs"],
    ["a flow map", "contracts: {name: a}\n", 1, "unsupported"],
    ["an anchor", "bots: &x [a]\n", 1, "unsupported"],
    ["an alias", "bots: *x\n", 1, "unsupported"],
    ["a block scalar", "bots: |\n  a\n", 1, "unsupported"],
    ["a tag", "bots: !!str a\n", 1, "unsupported"],
    ["a nested flow list", "bots: [[a]]\n", 1, "nested"],
    ["a list that does not close", "bots: [a, b\n", 1, "close"],
    ["a trailing comma", "bots: [a, ]\n", 1, "trailing"],
    ["an empty item", "bots: [a,, b]\n", 1, "empty item"],
    ["an unterminated quote", 'bots: ["a]\n', 1, "bad quoted string"],
    ["text after a quote", 'bots: ["a" b]\n', 1, "bad quoted string"],
    ["a duplicate key", "bots: [a]\nbots: [b]\n", 2, "duplicate key bots"],
    ["a line that is not key: value", "just text\n", 1, "expected"],
    ["a list at the top", "- a\n- b\n", 1, "top-level"],
    ["an indented first line", "  bots: [a]\n", 1, "top-level"],
    ["bad indentation", "bots: [a]\n  early-drafts: true\n", 2, "indentation"],
    ["a plain value with ': '", "bots: a: b\n", 1, "': '"],
    ["a list item under a key map", "a:\n  b: 1\n  - c\n", 3, "list item"],
    [
      "early-drafts that is not boolean",
      "early-drafts: yes please\n",
      null,
      "early-drafts",
    ],
    ["agents-merge as a list", "agents-merge: [true]\n", null, "agents-merge"],
    ["contracts that is a scalar", "contracts: api\n", null, "contracts"],
    [
      "a contract that is a string",
      "contracts:\n  - api\n",
      null,
      "contracts[0]",
    ],
    [
      "a contract without a name",
      "contracts:\n  - producer: [a]\n    consumers: [b]\n",
      null,
      "needs a name",
    ],
    [
      "a contract without a producer",
      "contracts:\n  - name: a\n    consumers: [b]\n",
      null,
      "needs a producer",
    ],
    [
      "a contract without consumers",
      "contracts:\n  - name: a\n    producer: [b]\n",
      null,
      "needs consumers",
    ],
    [
      "a producer that is a map",
      "contracts:\n  - name: a\n    producer:\n      x: y\n    consumers: [b]\n",
      null,
      "list of strings",
    ],
    ["bots with a boolean", "bots: [true]\n", null, "list of strings"],
  ])("rejects %s", (_name, text, line, detail) => {
    const result = parseRepoConfig(text);
    expect(result).toMatchObject({ ok: false, line });
    if (result.ok) return;
    expect(result.detail).toContain(detail);
  });

  test("never throws on arbitrary input", () => {
    for (const text of [
      "\u0000",
      "::",
      ": a",
      "a:\n- \n-\n",
      "[",
      "'",
      "a: [",
      "-",
    ]) {
      expect(() => parseRepoConfig(text)).not.toThrow();
    }
  });
});
