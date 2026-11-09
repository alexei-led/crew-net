import { createInterface } from "node:readline";
import { runWatch } from "../../watch/index";
import { single, UsageError } from "../args";
import type { Command } from "../command";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const watch: Command = {
  name: "watch",
  summary: "Watcher child of the Claude Code mod (NDJSON on stdin/stdout)",
  usage: `Usage: crew-net watch --session <id>
  Speaks the events of design §16 on stdin and stdout. Exits when stdin
  closes, on bye, or when the parent process is gone.`,
  spec: { values: ["--session"], switches: [] },
  async run(ctx) {
    const sessionId = single(ctx.args, "--session");
    if (!sessionId) throw new UsageError("--session is required");
    if (ctx.args.positional.length > 0)
      throw new UsageError(`unexpected argument ${ctx.args.positional[0]}`);
    const parent = process.ppid;
    const lines = createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });
    try {
      return await runWatch(ctx.runtime.ports(), sessionId, {
        lines,
        write: (line) => ctx.io.out(line),
        parentAlive: () => process.ppid === parent && alive(parent),
      });
    } finally {
      lines.close();
    }
  },
};
