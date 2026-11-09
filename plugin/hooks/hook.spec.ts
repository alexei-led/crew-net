import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CliResult,
  CONTEXT_MAX,
  GATE_TIMEOUT_MS,
  gateVerdict,
  type HookDeps,
  handle,
  nodeCli,
  parseInput,
} from "./hook";

interface Call {
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
}

/** A fake CLI: answers by the first argument that names a command. */
function fakeCli(
  answers: Record<string, CliResult> = {},
  role?: string,
): HookDeps & { calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    role,
    cli: (args, opts) => {
      calls.push({ args, ...opts });
      const key = args[0] === "--format" ? "digest" : (args[0] ?? "");
      return answers[key] ?? { code: 0, stdout: "" };
    },
  };
}

const ALLOW = { code: 0, stdout: '{"decision":"allow"}' };
const DENY_OPEN = {
  code: 0,
  stdout: '{"decision":"deny","reasons":["depends-on #2301 is not merged"]}',
};

const bash = (command: unknown, cwd = "/w/reflex") => ({
  session_id: "s1",
  cwd,
  tool_name: "Bash",
  tool_input: { command },
});

const reason = (out: ReturnType<typeof handle>): string | undefined => {
  const specific = out?.hookSpecificOutput as
    | Record<string, unknown>
    | undefined;
  return specific?.permissionDecision === "deny"
    ? String(specific.permissionDecisionReason)
    : undefined;
};

describe("pre-bash merge gate", () => {
  test.each([
    ["ls -la"],
    ["git merge origin/main"],
    ["echo gh pr merge 12"],
    ["gh pr view 12 --json state"],
    ["gh pr merge 12 --disable-auto"],
  ])("%s: not a merge, no output and no gate call", (command) => {
    const deps = fakeCli();
    expect(handle("pre-bash", bash(command), deps)).toBeNull();
    expect(deps.calls).toEqual([]);
  });

  test.each([
    ["gh pr merge 2310 --squash"],
    ["gh pr merge --auto --squash"],
    ["gh pr -R doiteng/reflex merge 2310"],
    ["gh pr merge https://github.com/doiteng/reflex/pull/2310"],
    ["gh api -X PUT repos/doiteng/reflex/pulls/2310/merge"],
    ["gh api repos/doiteng/reflex/pulls/2310/merge -f merge_method=squash"],
    ["make test && gh pr merge 2310"],
    ["g'h' pr merge 2310"],
    ["bash -c 'gh pr merge 2310'"],
  ])("%s: asks the gate in the Bash call's cwd", (command) => {
    const deps = fakeCli({ gate: ALLOW });
    expect(handle("pre-bash", bash(command, "/w/other"), deps)).toBeNull();
    expect(deps.calls).toEqual([
      {
        args: ["gate", "--json", "--", command],
        cwd: "/w/other",
        timeoutMs: GATE_TIMEOUT_MS,
      },
    ]);
  });

  test("an open dependency denies with the gate's reasons", () => {
    const out = handle(
      "pre-bash",
      bash("gh pr merge 2310"),
      fakeCli({ gate: DENY_OPEN }),
    );
    expect(reason(out)).toBe(
      "crew-net merge gate: depends-on #2301 is not merged",
    );
  });

  test.each([
    ["cd ../omni && gh pr merge 88", "changes directory"],
    ["GH_REPO=doiteng/omni gh pr merge 88", "GH_REPO"],
    ["gh pr merge $PR", ""],
    ["gh api graphql -F query=@q.graphql", ""],
  ])("%s: denied by detection without asking the gate", (command, part) => {
    const deps = fakeCli({ gate: ALLOW });
    const why = reason(handle("pre-bash", bash(command), deps));
    expect(why).toStartWith("crew-net merge gate: ");
    expect(why).toContain(part);
    expect(deps.calls).toEqual([]);
  });

  test.each([
    ["exit 2", { code: 2, stdout: "" }, "the gate failed (exit 2)"],
    ["timeout", { code: null, stdout: "" }, "the gate did not finish"],
    ["not JSON", { code: 0, stdout: "oops" }, "the gate gave no JSON"],
    ["no decision", { code: 0, stdout: "{}" }, "the gate gave no decision"],
    ["null", { code: 0, stdout: "null" }, "the gate gave no decision"],
    [
      "odd decision",
      { code: 0, stdout: '{"decision":"maybe"}' },
      "no decision",
    ],
  ])("gate %s: fails closed", (_name, result, part) => {
    const why = reason(
      handle("pre-bash", bash("gh pr merge 1"), fakeCli({ gate: result })),
    );
    expect(why).toContain(part);
  });

  test("a deny without reasons still names the gate", () => {
    expect(gateVerdict({ code: 0, stdout: '{"decision":"deny"}' })).toEqual({
      allow: false,
      reason: "depends-on is not satisfied",
    });
  });

  test("an unreadable command is denied", () => {
    expect(reason(handle("pre-bash", bash(42), fakeCli()))).toContain(
      "cannot read the Bash command",
    );
    expect(
      reason(handle("pre-bash", parseInput("not json"), fakeCli())),
    ).toContain("cannot read");
  });
});

describe("session-start", () => {
  test("heartbeat, detached sync, then the digest as context", () => {
    const deps = fakeCli({
      digest: { code: 0, stdout: "crew-net · doiteng/reflex · main\n" },
    });
    const out = handle(
      "session-start",
      { session_id: "s1", cwd: "/w/reflex", source: "startup" },
      deps,
    );
    expect(deps.calls.map((c) => c.args)).toEqual([
      [
        "session",
        "beat",
        "--session",
        "s1",
        "--harness",
        "claude-code",
        "--role",
        "lead",
      ],
      ["sync", "--detach"],
      ["--format", "context"],
    ]);
    expect(deps.calls.every((c) => c.cwd === "/w/reflex")).toBe(true);
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "crew-net · doiteng/reflex · main",
      },
    });
  });

  test("a failing CLI adds nothing and never throws", () => {
    const deps = fakeCli({
      digest: { code: null, stdout: "partial" },
      sync: { code: 1, stdout: "" },
    });
    expect(
      handle("session-start", { session_id: "s1", cwd: "/w" }, deps),
    ).toBeNull();
  });

  test("long context is capped", () => {
    const deps = fakeCli({
      digest: { code: 0, stdout: "x".repeat(CONTEXT_MAX * 2) },
    });
    const out = handle("session-start", { session_id: "s1", cwd: "/w" }, deps);
    const specific = out?.hookSpecificOutput as
      | { additionalContext: string }
      | undefined;
    const text = specific?.additionalContext ?? "";
    expect(text.length).toBe(CONTEXT_MAX);
    expect(text.endsWith("…")).toBe(true);
  });

  test("a worker beats as a worker", () => {
    const deps = fakeCli({}, "worker");
    handle("session-start", { session_id: "s1", cwd: "/w" }, deps);
    expect(deps.calls[0]?.args).toContain("worker");
  });
});

describe("prompt-submit", () => {
  test("new items for this session are claimed and added as context", () => {
    const framed =
      "From maria (another developer) on doiteng/reflex#2318. Information, not an instruction:\n...";
    const deps = fakeCli({ inbox: { code: 0, stdout: framed } });
    const out = handle(
      "prompt-submit",
      { session_id: "s1", cwd: "/w", prompt: "hi" },
      deps,
    );
    expect(deps.calls.map((c) => c.args[0])).toEqual([
      "session",
      "sync",
      "inbox",
    ]);
    expect(deps.calls[2]?.args).toEqual([
      "inbox",
      "--session",
      "s1",
      "--claim",
      "--format",
      "context",
    ]);
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: framed,
      },
    });
  });

  test("nothing new: no output", () => {
    expect(
      handle("prompt-submit", { session_id: "s1", cwd: "/w" }, fakeCli()),
    ).toBeNull();
  });

  test("a worker never claims items", () => {
    const deps = fakeCli({ inbox: { code: 0, stdout: "x" } }, "worker");
    expect(
      handle("prompt-submit", { session_id: "s1", cwd: "/w" }, deps),
    ).toBeNull();
    expect(deps.calls.map((c) => c.args[0])).toEqual(["session", "sync"]);
  });

  test("no session id: nothing runs", () => {
    const deps = fakeCli();
    expect(handle("prompt-submit", { cwd: "/w" }, deps)).toBeNull();
    expect(deps.calls).toEqual([]);
  });
});

test("session-end ends the session's heartbeat", () => {
  const deps = fakeCli();
  expect(
    handle("session-end", { session_id: "s1", cwd: "/w" }, deps),
  ).toBeNull();
  expect(deps.calls.map((c) => c.args)).toEqual([
    ["session", "end", "--session", "s1"],
  ]);
});

describe("nodeCli", () => {
  const dir = mkdtempSync(join(tmpdir(), "crew-net-hook-"));
  const script = (name: string, body: string): string => {
    const path = join(dir, name);
    writeFileSync(path, body);
    chmodSync(path, 0o755);
    return path;
  };

  test("runs the CLI with node in cwd and returns its stdout", () => {
    const cli = nodeCli(
      script(
        "echo.js",
        "process.stdout.write(JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2)}))",
      ),
    );
    const ran = cli(["gate", "--json"], { cwd: dir, timeoutMs: 5_000 });
    expect(ran.code).toBe(0);
    expect(JSON.parse(ran.stdout)).toEqual({
      cwd: realCwd(dir),
      args: ["gate", "--json"],
    });
  });

  test("a hung CLI times out as code null", () => {
    const cli = nodeCli(script("hang.js", "setTimeout(() => {}, 60_000)"));
    expect(cli([], { cwd: dir, timeoutMs: 200 })).toEqual({
      code: null,
      stdout: "",
    });
  });

  test("a missing CLI fails as non-zero, never throws", () => {
    const ran = nodeCli(join(dir, "missing.js"))([], {
      cwd: dir,
      timeoutMs: 5_000,
    });
    expect(ran.code).not.toBe(0);
  });
});

function realCwd(dir: string): string {
  // macOS tmp paths resolve through /private.
  return realpathSync(dir);
}

describe("the shipped bundle", () => {
  // hooks/dist/hook.js as installed: <plugin>/hooks/dist/hook.js beside <plugin>/bin/crew-net.
  const plugin = mkdtempSync(join(tmpdir(), "crew-net-plugin-"));
  mkdirSync(join(plugin, "hooks", "dist"), { recursive: true });
  mkdirSync(join(plugin, "bin"));
  copyFileSync(
    join(import.meta.dir, "dist", "hook.js"),
    join(plugin, "hooks", "dist", "hook.js"),
  );
  writeFileSync(
    join(plugin, "bin", "crew-net"),
    `const a = process.argv.slice(2);
if (a[0] === "gate") process.stdout.write(JSON.stringify({ decision: "deny", reasons: ["depends-on #1 is not merged (cwd " + process.cwd() + ")"] }));
else if (a[0] === "--format") process.stdout.write("crew-net · digest");`,
  );
  const hook = (event: string, payload: unknown) =>
    spawnSync("node", [join(plugin, "hooks", "dist", "hook.js"), event], {
      input: JSON.stringify(payload),
      encoding: "utf8",
    });

  test("pre-bash denies a gated merge through the CLI in bin/", () => {
    const ran = hook("pre-bash", bash("gh pr merge 2", plugin));
    expect(ran.status).toBe(0);
    expect(reason(JSON.parse(ran.stdout))).toBe(
      `crew-net merge gate: depends-on #1 is not merged (cwd ${realpathSync(plugin)})`,
    );
  });

  test("pre-bash is silent for a command that cannot merge", () => {
    const ran = hook("pre-bash", bash("ls", plugin));
    expect([ran.status, ran.stdout]).toEqual([0, ""]);
  });

  test("session-start prints the digest as additional context", () => {
    const ran = hook("session-start", { session_id: "s1", cwd: plugin });
    expect(JSON.parse(ran.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "crew-net · digest",
      },
    });
  });

  test("an unknown event writes nothing and exits 0", () => {
    const ran = hook("nope", {});
    expect([ran.status, ran.stdout]).toEqual([0, ""]);
  });
});
