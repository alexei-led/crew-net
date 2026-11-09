import { beat, end } from "../../app/session";
import { SESSION_ROLES } from "../../protocol/index";
import { single, UsageError } from "../args";
import type { Command } from "../command";
import { print } from "./shared";

export const session: Command = {
  name: "session",
  summary: "Session registry for hooks: beat or end",
  usage: `Usage: crew-net session beat|end --session <id> [--harness claude|pi|codex|cli]
                        [--role lead|worker] [--pid N] [--prompt] [--json]
  beat writes the session's heartbeat (repo, branch, pid); --prompt also
  records a user prompt now. end removes it. The role defaults to
  CREW_NET_ROLE, else lead; the pid to the parent process.`,
  spec: {
    values: ["--session", "--harness", "--role", "--pid"],
    switches: ["--prompt"],
  },
  async run(ctx) {
    const [action, ...extra] = ctx.args.positional;
    if (action !== "beat" && action !== "end")
      throw new UsageError("expected beat or end");
    if (extra.length > 0)
      throw new UsageError(`unexpected argument ${extra[0]}`);
    const sessionId = single(ctx.args, "--session");
    if (!sessionId) throw new UsageError("--session is required");
    const ports = ctx.runtime.ports();
    if (action === "end") {
      await end(ports, sessionId);
      print(ctx, { ended: sessionId }, "");
      return 0;
    }
    const role =
      single(ctx.args, "--role") ?? process.env.CREW_NET_ROLE ?? "lead";
    if (!SESSION_ROLES.some((r) => r === role))
      throw new UsageError("--role must be lead or worker");
    const pidText = single(ctx.args, "--pid");
    const pid = pidText === undefined ? process.ppid : Number(pidText);
    if (!Number.isSafeInteger(pid) || pid <= 0)
      throw new UsageError("--pid must be a positive integer");
    const heartbeat = await beat(ports, {
      sessionId,
      harness: single(ctx.args, "--harness") ?? "cli",
      role: role as "lead" | "worker",
      pid,
      dir: ctx.runtime.cwd,
      prompt: ctx.args.switches.has("--prompt"),
    });
    print(ctx, heartbeat, "");
    return 0;
  },
};
