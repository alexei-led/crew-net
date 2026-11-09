import { describe, expect, test } from "bun:test";
import {
  type DependencyState,
  dependencies,
  detectMerge,
  type GatedPr,
  gate,
  type MergeDetection,
} from "./index";

const REPO = "doiteng/reflex";
const body = (dependsOn: string): string =>
  `text\n<!-- crew-net\nstate: review\n${
    dependsOn ? `depends-on: ${dependsOn}\n` : ""
  }-->`;
const pr = (b: string): GatedPr => ({ repo: REPO, number: 50, body: b });
const dep = (ref: string, state: DependencyState["state"]): DependencyState => {
  const [repo = REPO, n = ""] = ref.includes("#")
    ? ref.startsWith("#")
      ? [REPO, ref.slice(1)]
      : ref.split("#")
    : [];
  return { repo, number: Number(n), state };
};

describe("gate", () => {
  test.each<[string, string, DependencyState[], "allow" | "deny"]>([
    ["no state block", "plain body", [], "allow"],
    ["block without depends-on", body(""), [], "allow"],
    ["dependency merged", body("#2301"), [dep("#2301", "merged")], "allow"],
    ["dependency open", body("#2301"), [dep("#2301", "open")], "deny"],
    ["dependency closed", body("#2301"), [dep("#2301", "closed")], "deny"],
    ["dependency state missing", body("#2301"), [], "deny"],
    [
      "one merged, one open",
      body("#1, #2"),
      [dep("#1", "merged"), dep("#2", "open")],
      "deny",
    ],
    [
      "same-repo ref written with owner/repo",
      body(`${REPO}#2301`),
      [dep("#2301", "open")],
      "deny",
    ],
    [
      "cross-repo open",
      body("doiteng/omni#88"),
      [dep("doiteng/omni#88", "open")],
      "deny",
    ],
    [
      "cross-repo merged",
      body("doiteng/omni#88"),
      [dep("doiteng/omni#88", "merged")],
      "allow",
    ],
    ["cross-repo state unreadable", body("doiteng/omni#88"), [], "deny"],
    [
      "cross-repo ref matches case-insensitively",
      body("DoiTeng/Omni#88"),
      [dep("doiteng/omni#88", "merged")],
      "allow",
    ],
    [
      "same number in another repo does not count",
      body("doiteng/omni#88"),
      [dep("#88", "merged")],
      "deny",
    ],
    ["malformed block", "<!-- crew-net\nstate: review\n", [], "deny"],
    ["bad depends-on ref", body("not-a-ref"), [], "deny"],
    [
      "duplicate states: the worst one counts",
      body("#2"),
      [dep("#2", "open"), dep("#2", "merged")],
      "deny",
    ],
    [
      "duplicate states, merged last after closed",
      body("#2"),
      [dep("#2", "closed"), dep("#2", "merged")],
      "deny",
    ],
    [
      "bad ref next to a good one",
      body("#1, nope"),
      [dep("#1", "merged")],
      "deny",
    ],
  ])("%s", (_name, prBody, states, expected) => {
    expect(gate(pr(prBody), states).decision).toBe(expected);
  });

  test("reasons name each blocking dependency", () => {
    expect(
      gate(pr(body("#1, #2, doiteng/omni#9, #4")), [
        dep("#1", "open"),
        dep("#2", "closed"),
        dep("#4", "merged"),
      ]),
    ).toEqual({
      decision: "deny",
      reasons: [
        "depends-on #1 is not merged",
        "depends-on #2: dependency closed without merge",
        "depends-on doiteng/omni#9: state unknown",
      ],
    });
  });
});

describe("dependencies", () => {
  test("lists every ref with its repo, deduplicated", () => {
    expect(dependencies(pr(body(`#1, Doiteng/Omni#9, ${REPO}#1`)))).toEqual({
      ok: true,
      refs: [
        { repo: REPO, number: 1 },
        { repo: "doiteng/omni", number: 9 },
      ],
    });
  });
  test("no block: none", () => {
    expect(dependencies(pr("x"))).toEqual({ ok: true, refs: [] });
  });
  test("unreadable block: error", () => {
    expect(dependencies(pr(body("#x"))).ok).toBe(false);
  });
});

const merge = (...targets: object[]): MergeDetection => ({
  kind: "merge",
  targets: targets as never,
});
const NONE: MergeDetection = { kind: "none" };

describe("detectMerge: gh pr merge", () => {
  test.each<[string, MergeDetection]>([
    ["gh pr merge", merge({})],
    ["gh pr merge 5", merge({ pr: 5 })],
    ["gh pr merge '#5' --squash", merge({ pr: 5 })],
    ["gh pr merge 5 --auto", merge({ pr: 5 })],
    ["gh pr merge --auto --squash 5", merge({ pr: 5 })],
    ["gh pr merge feat/x", merge({ branch: "feat/x" })],
    ["gh pr merge 5 -R o/r", merge({ repo: "o/r", pr: 5 })],
    ["gh pr merge 5 --repo=o/r", merge({ repo: "o/r", pr: 5 })],
    ["gh pr merge 5 -Ro/r", merge({ repo: "o/r", pr: 5 })],
    ["gh pr merge -sRother/repo 7", merge({ repo: "other/repo", pr: 7 })],
    ["gh pr merge -sdR other/repo 7", merge({ repo: "other/repo", pr: 7 })],
    [
      "gh pr merge 5 -R ghe.example.com/o/r",
      merge({ host: "ghe.example.com", repo: "o/r", pr: 5 }),
    ],
    [
      "gh pr merge 5 -R https://GHE.example.com/o/r",
      merge({ host: "ghe.example.com", repo: "o/r", pr: 5 }),
    ],
    [
      "gh pr merge https://ghe.example.com/o/r/pull/7",
      merge({ host: "ghe.example.com", repo: "o/r", pr: 7 }),
    ],
    [
      "GH_HOST=ghe.example.com gh pr merge 5 -R github.com/o/r",
      merge({ host: "github.com", repo: "o/r", pr: 5 }),
    ],
    ["gh pr -R o/r merge 5", merge({ repo: "o/r", pr: 5 })],
    [
      "gh -R ghe.example.com/o/r pr merge 5",
      merge({ host: "ghe.example.com", repo: "o/r", pr: 5 }),
    ],
    ["gh pr --repo o/r merge --auto", merge({ repo: "o/r" })],
    [
      "gh pr merge https://github.com/o/r/pull/7",
      merge({ host: "github.com", repo: "o/r", pr: 7 }),
    ],
    ["gh pr merge 5 -b 'merge body' -t subj", merge({ pr: 5 })],
    ["/opt/homebrew/bin/gh pr merge 5", merge({ pr: 5 })],
    ["gh pr merge 5 --disable-auto", NONE],
    ["gh pr view 5", NONE],
    ["gh pr view merge", NONE],
    ["gh pr list --search merge", NONE],
    ["gh pr", NONE],
  ])("%s", (command, expected) => {
    expect(detectMerge(command)).toEqual(expected);
  });
});

describe("detectMerge: wrappers and chains", () => {
  test.each<[string, MergeDetection]>([
    ["git push && gh pr merge 5", merge({ pr: 5 })],
    ["git push; gh pr merge 5", merge({ pr: 5 })],
    ["false || gh pr merge 5", merge({ pr: 5 })],
    ["echo y | gh pr merge 5", merge({ pr: 5 })],
    ["gh pr merge 5 &", merge({ pr: 5 })],
    ["git push\ngh pr merge 5", merge({ pr: 5 })],
    ["(gh pr merge 5)", merge({ pr: 5 })],
    ["{ gh pr merge 5; }", merge({ pr: 5 })],
    ["if true; then gh pr merge 5; fi", merge({ pr: 5 })],
    ["echo $(gh pr merge 5)", merge({ pr: 5 })],
    ['echo "$(gh pr merge 5)"', merge({ pr: 5 })],
    ["echo `gh pr merge 5`", merge({ pr: 5 })],
    ["cat <(gh pr merge 5)", merge({ pr: 5 })],
    ["env gh pr merge 5", merge({ pr: 5 })],
    ["env -i GH_TOKEN=x gh pr merge 5", merge({ pr: 5 })],
    ["GH_TOKEN=x gh pr merge 5", merge({ pr: 5 })],
    ["time -p gh pr merge 5", merge({ pr: 5 })],
    ["coproc gh pr merge 5", merge({ pr: 5 })],
    ["builtin eval 'gh pr merge 5'", merge({ pr: 5 })],
    ["caffeinate -i gh pr merge 5", merge({ pr: 5 })],
    ["stdbuf -o0 gh pr merge 5", merge({ pr: 5 })],
    ["sudo --user root gh pr merge 5", merge({ pr: 5 })],
    ["env -P /usr/local/bin gh pr merge 5", merge({ pr: 5 })],
    ["bash -c -e 'gh pr merge 5'", merge({ pr: 5 })],
    ["bash -c -- 'gh pr merge 5'", merge({ pr: 5 })],
    ["bash -co pipefail 'gh pr merge 5'", merge({ pr: 5 })],
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion under test
    ['echo "${x:-$(gh pr merge 5)}"', merge({ pr: 5 })],
    ['$"gh" pr merge 5', merge({ pr: 5 })],
    ["cat <<EOF\n$(gh pr merge 5)\nEOF", merge({ pr: 5 })],
    ["cat <<EOF\n`gh pr merge 5`\nEOF", merge({ pr: 5 })],
    ["cd ../other && gh pr merge 7 -R o/r", merge({ repo: "o/r", pr: 7 })],
    [
      "cd ../other && gh pr merge https://github.com/o/r/pull/7",
      merge({ host: "github.com", repo: "o/r", pr: 7 }),
    ],
    ["command gh pr merge 5", merge({ pr: 5 })],
    ["command -p gh pr merge 5", merge({ pr: 5 })],
    ["exec gh pr merge 5", merge({ pr: 5 })],
    ["nohup gh pr merge 5", merge({ pr: 5 })],
    ["time gh pr merge 5", merge({ pr: 5 })],
    ["timeout 30 gh pr merge 5", merge({ pr: 5 })],
    ["sudo -u me gh pr merge 5", merge({ pr: 5 })],
    ["sh -c 'gh pr merge 5'", merge({ pr: 5 })],
    ['bash -lc "gh pr merge 5 && echo ok"', merge({ pr: 5 })],
    ["zsh -c 'sh -c \"gh pr merge 5\"'", merge({ pr: 5 })],
    ["eval gh pr merge 5", merge({ pr: 5 })],
    ["g'h' pr mer\"ge\" 5", merge({ pr: 5 })],
    ["gh pr merge 5 > out.txt 2>&1", merge({ pr: 5 })],
    ["gh pr merge 1; gh pr merge 2", merge({ pr: 1 }, { pr: 2 })],
    ["cat <<EOF\nhello\nEOF\ngh pr merge 5", merge({ pr: 5 })],
  ])("%s", (command, expected) => {
    expect(detectMerge(command)).toEqual(expected);
  });

  test.each([
    'sh -c "$CMD"',
    "bash -c 'gh pr merge 5",
    'eval "$(cat script)"',
    "gh pr merge $N",
    'gh pr merge "$(gh pr list -q .[0])"',
    "gh pr merge 5 -R $REPO",
    "gh pr $ACTION 5",
    "gh pr merge 1 2",
    "gh pr merge 5 -R not-a-repo",
    "gh pr merge 5 -R a/b/c/d",
    "env -S 'gh pr merge 5'",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: bash parameter expansion under test
    "gh ${P:-pr} merge 7",
    "cd ../other-repo && gh pr merge 7",
    "GH_HOST=ghe.example.com gh pr merge 5 -R o/r",
    "export GH_HOST=ghe.example.com; gh pr merge 5 -R o/r",
    "env GH_HOST=ghe.example.com gh api -X PUT repos/o/r/pulls/5/merge",
    "GH_HOST+=ghe.example.com gh pr merge 5 -R o/r",
    "GH_REPO+=o/blocked gh pr merge 5",
    "printf -v GH_HOST %s ghe; export GH_HOST; gh pr merge 5 -R o/r",
    "read GH_REPO < f; export GH_REPO; gh pr merge 5",
    ". ./ghe.env && gh pr merge 5 -R o/r",
    "source ./ghe.env; gh pr merge 5",
    "set -a; gh pr merge 5",
    "GIT_DIR=../blocked/.git gh pr merge 5",
    "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=remote.upstream.url GIT_CONFIG_VALUE_0=https://github.com/o/blocked gh pr merge 5",
    "HOME=/tmp/other gh pr merge 5 -R o/r",
    "gh pr merge 5 -R ghe.example.com:8443/o/r",
    "gh pr merge https://ghe.example.com:8443/o/r/pull/5",
    "pushd ../other; gh pr merge 7",
    "(cd ../other; gh pr merge 7)",
    "GH_REPO=acme/other gh pr merge 7",
    "export GH_REPO=acme/other; gh pr merge 7",
    "env -C ../other gh pr merge 7",
    "cd ../other && sh -c 'gh pr merge 7'",
    "sh <<<'gh pr merge 5'",
    "echo 'gh pr merge 5' | bash",
    "bash <<'EOF'\ngh pr merge 5\nEOF",
    "find . -maxdepth 0 -exec gh pr merge {} ;",
    "xargs --max-args 1 gh pr merge",
    "gh pr list -q .[].number | xargs gh pr merge",
    "xargs -n 1 gh pr merge --squash < prs.txt",
  ])("denies what cannot be pinned: %s", (command) => {
    expect(detectMerge(command).kind).toBe("deny");
  });

  test.each([
    "git merge gh-pages",
    "git merge --no-ff origin/main",
    "echo gh pr merge 5",
    "grep -r 'gh pr merge' docs",
    "printf '%s' \"gh pr merge 5\"",
    "git commit -m 'run gh pr merge later'",
    "gh pr view 5 # gh pr merge 5",
    "cat <<'EOF'\ngh pr merge 5\nEOF",
    "cat <<EOF > notes.md\ngh pr merge 5\nEOF\ngit status",
    "git commit -m \"$(cat <<'EOF'\nfix: x\n\ngh pr merge later\nEOF\n)\"",
    "sh script.sh",
    "bash script.sh",
    "cd sub && gh pr view 5",
    "git commit -m \"$(cat <<'EOF'\nfix: don't break (X\n\"quoted\nEOF\n)\"",
    "gh pr create --body \"$(cat <<'EOF'\nit's done; gh pr merge 5 later\nEOF\n)\"",
    "(( n = 1 << 2 ))\ngit status",
    "find . -name '*.ts' -exec grep -l merge {} ;",
    "crew-net gate --json",
    "gh pr list | xargs gh pr view",
  ])("allows non-merge %j", (command) => {
    expect(detectMerge(command)).toEqual(NONE);
  });
});

describe("detectMerge: gh api", () => {
  test.each<[string, MergeDetection]>([
    ["gh api -X PUT repos/o/r/pulls/5/merge", merge({ repo: "o/r", pr: 5 })],
    ["gh api -XPUT repos/o/r/pulls/5/merge", merge({ repo: "o/r", pr: 5 })],
    [
      "gh api --method=put /repos/o/r/pulls/5/merge",
      merge({ repo: "o/r", pr: 5 }),
    ],
    [
      "gh api repos/o/r/pulls/5/merge -f merge_method=squash",
      merge({ repo: "o/r", pr: 5 }),
    ],
    [
      "gh api repos/o/r/pulls/5/merge --input body.json",
      merge({ repo: "o/r", pr: 5 }),
    ],
    [
      "gh api -X PUT https://api.github.com/repos/o/r/pulls/5/merge",
      merge({ host: "github.com", repo: "o/r", pr: 5 }),
    ],
    [
      "gh api -X PUT https://ghe.example.com/api/v3/repos/o/r/pulls/5/merge",
      merge({ host: "ghe.example.com", repo: "o/r", pr: 5 }),
    ],
    [
      "gh api -X PUT https://api.acme.ghe.com/repos/o/r/pulls/5/merge",
      merge({ host: "acme.ghe.com", repo: "o/r", pr: 5 }),
    ],
    [
      "gh api --hostname ghe.example.com -X PUT repos/o/r/pulls/5/merge",
      merge({ host: "ghe.example.com", repo: "o/r", pr: 5 }),
    ],
    [
      "gh api -X PUT 'repos/o/r/pulls/9/../5/merge?x=1'",
      merge({ repo: "o/r", pr: 5 }),
    ],
    ["gh api -X PUT repos/o/r/pulls/5%2Fmerge", merge({ repo: "o/r", pr: 5 })],
    ["gh api -iXPUT repos/o/r/pulls/1/merge", merge({ repo: "o/r", pr: 1 })],
    ["gh api -iX PUT repos/o/r/pulls/1/merge", merge({ repo: "o/r", pr: 1 })],
    ["gh -X PUT api repos/o/r/pulls/5/merge", merge({ repo: "o/r", pr: 5 })],
    [
      "gh --hostname ghe.example.com api -X PUT repos/o/r/pulls/5/merge",
      merge({ host: "ghe.example.com", repo: "o/r", pr: 5 }),
    ],
    [
      "gh api repos/o/r/pulls/5/merge -H 'X-HTTP-Method-Override: PUT'",
      merge({ repo: "o/r", pr: 5 }),
    ],
    ["gh api repos/o/r/pulls/5/merge -X $M", merge({ repo: "o/r", pr: 5 })],
    ["gh api repos/o/r/pulls/5/merge", NONE],
    ["gh api -X GET repos/o/r/pulls/5/merge", NONE],
    ["gh api repos/o/r/pulls/5", NONE],
    ["gh api -X PATCH repos/o/r/pulls/5 -f title=x", NONE],
    ["gh api graphql -f query='{ viewer { login } }'", NONE],
    ["gh api repos/$R/pulls", NONE],
  ])("%s", (command, expected) => {
    expect(detectMerge(command)).toEqual(expected);
  });

  test.each([
    "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
    "gh api graphql -F query='mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }'",
    "gh api graphql -f query='mutation { enqueuePullRequest(input: {}) { clientMutationId } }'",
    "gh api graphql --raw-field=query='mutation{mergePullRequest(input:{}){x}}'",
    "gh api graphql -F query=@mutation.graphql",
    "gh api graphql -Fquery=@mutation.graphql",
    "gh api graphql -iF query=@m.graphql",
    "gh api graphql -iFquery=@m.graphql",
    "gh api -X POST https://ghe.corp/api/graphql -f query='mutation{mergePullRequest(input:{}){x}}'",
    "gh api graphql --input query.json",
    'gh api graphql -f query="$Q"',
    "gh api -X POST repos/o/r/merges -f base=main -f head=x",
    "gh api -X PUT repos/$R/pulls/5/merge",
    "gh api -X PUT repos/o/r/pulls/$N/merge",
    "gh api --hostname $H -X PUT repos/o/r/pulls/5/merge",
    "gh api -X PUT repos/{owner}/{repo}/pulls/5/merge",
    "gh api -X PUT https://ghe.example.com:8443/api/v3/repos/o/r/pulls/5/merge",
  ])("denies %s", (command) => {
    expect(detectMerge(command).kind).toBe("deny");
  });
});

describe("detectMerge: gh aliases", () => {
  const aliases = new Map([
    ["sq", "pr merge --squash"],
    ["land", "pr merge $1 --auto"],
    ["view5", "pr view 5"],
    ["shipit", "!gh pr merge --admin"],
    ["shipvar", '!gh pr merge "$1"'],
  ]);
  test.each<[string, MergeDetection]>([
    ["gh sq 5", merge({ pr: 5 })],
    ["gh sq -R o/r 5", merge({ repo: "o/r", pr: 5 })],
    ["gh land 7", merge({ pr: 7 })],
    ["gh view5", NONE],
    ["gh shipit", merge({})],
    ["gh some-extension run", NONE],
    ["gh shipvar 5", expect.objectContaining({ kind: "deny" })],
  ])("with alias map: %s", (command, expected) => {
    expect(detectMerge(command, { aliases })).toEqual(expected);
  });
  test("without a map an unknown command is a possible merge of the current PR", () => {
    expect(detectMerge("gh sq 5")).toEqual(merge({}));
    expect(detectMerge("gh pr view 5")).toEqual(NONE);
    expect(detectMerge("gh co 5")).toEqual(NONE);
  });
});
