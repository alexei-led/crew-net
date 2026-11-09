import { createInterface } from "node:readline";
import { runWatch, sendToWatch } from "../../watch/index";
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
       crew-net watch send --session <id>
  watch: write ready, read hello on stdin (EOF after it is normal), then
  emit item/status/error events until bye, SIGTERM or the parent's death.
  send: read ack and bye lines on stdin, apply them, exit.`,
  spec: { values: ["--session"], switches: [] },
  async run(ctx) {
    const sessionId = single(ctx.args, "--session");
    if (!sessionId) throw new UsageError("--session is required");
    const [action, ...extra] = ctx.args.positional;
    if (extra.length > 0 || (action !== undefined && action !== "send"))
      throw new UsageError(`unexpected argument ${extra[0] ?? action}`);
    const lines = createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });
    try {
      if (action === "send") {
        const bad = await sendToWatch(
          ctx.runtime.ports(),
          sessionId,
          lines,
          (message) => ctx.io.err(`crew-net watch send: ${message}\n`),
        );
        return bad > 0 ? 1 : 0;
      }
      const parent = process.ppid;
      const stopped = new Promise<void>((resolve) => {
        process.once("SIGTERM", () => resolve());
        process.once("SIGINT", () => resolve());
      });
      return await runWatch(ctx.runtime.ports(), sessionId, {
        lines,
        write: (line) => ctx.io.out(line),
        parentAlive: () =>
          process.ppid === parent && parent !== 1 && alive(parent),
        stopped,
      });
    } finally {
      lines.close();
    }
  },
};
