import { describe, expect, test } from "bun:test";
import type { Command, Runtime } from "./command";
import { main, VERSION } from "./main";

const runtime: Runtime = {
  cwd: "/repo",
  now: () => 0,
  ports: () => {
    throw new Error("ports must not be built");
  },
  detach: () => {
    throw new Error("nothing may detach");
  },
};

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (text: string) => out.push(text),
      err: (text: string) => err.push(text),
    },
    out: () => out.join(""),
    err: () => err.join(""),
  };
}

const echo: Command = {
  name: "echo",
  summary: "print the words",
  usage: "Usage: crew-net echo [--json] <words...>",
  spec: { values: ["--tag"], switches: [] },
  run: async (ctx) => {
    ctx.io.out(
      `${JSON.stringify({
        words: ctx.args.positional,
        json: ctx.json,
        repo: ctx.repo,
        tag: ctx.args.values.get("--tag"),
      })}\n`,
    );
    return 0;
  },
};

describe("main", () => {
  test("prints the version without building ports", async () => {
    const io = capture();
    expect(await main(["--version"], runtime, io.io, [])).toBe(0);
    expect(io.out()).toBe(`${VERSION}\n`);
  });

  test("unknown command is a usage error with exit 2", async () => {
    const io = capture();
    expect(await main(["nope"], runtime, io.io, [echo])).toBe(2);
    expect(io.err()).toContain("unknown command nope");
  });

  test("runs the named command with global flags parsed", async () => {
    const io = capture();
    const code = await main(
      ["echo", "a", "--json", "--repo", "o/r", "--tag=x", "b"],
      runtime,
      io.io,
      [echo],
    );
    expect(code).toBe(0);
    expect(JSON.parse(io.out())).toEqual({
      words: ["a", "b"],
      json: true,
      repo: "o/r",
      tag: ["x"],
    });
  });

  test("a flag the command does not declare is a usage error", async () => {
    const io = capture();
    expect(await main(["echo", "--bogus"], runtime, io.io, [echo])).toBe(2);
    expect(io.err()).toContain("unknown flag --bogus");
  });

  test("repeated --repo is a usage error", async () => {
    const io = capture();
    const code = await main(
      ["echo", "--repo", "a/b", "--repo", "c/d"],
      runtime,
      io.io,
      [echo],
    );
    expect(code).toBe(2);
    expect(io.err()).toContain("--repo given more than once");
  });

  test("--help prints the command usage and runs nothing", async () => {
    const io = capture();
    expect(await main(["echo", "--help"], runtime, io.io, [echo])).toBe(0);
    expect(io.out()).toBe(`${echo.usage}\n`);
  });

  test("a failing command reports its message with exit 1", async () => {
    const failing: Command = {
      ...echo,
      name: "fail",
      run: async () => {
        throw new Error("boom");
      },
    };
    const io = capture();
    expect(await main(["fail"], runtime, io.io, [failing])).toBe(1);
    expect(io.err()).toBe("crew-net fail: boom\n");
  });

  test("a leading flag selects the default command", async () => {
    const io = capture();
    const code = await main(["--json"], runtime, io.io, [
      { ...echo, name: "digest" },
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(io.out()).json).toBe(true);
  });
});
