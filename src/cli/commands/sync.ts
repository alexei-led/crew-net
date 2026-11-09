import { runSync } from "../../app/sync";
import { UsageError } from "../args";
import type { Command } from "../command";
import { locate, print } from "./shared";

export const sync: Command = {
  name: "sync",
  summary:
    "One sync pass: every due job (notifications, PRs, fetch, radar, deps)",
  usage: `Usage: crew-net sync [--once] [--detach] [--json] [--repo owner/repo]
  Runs one pass and exits; jobs that ran recently on this laptop are skipped.
  --detach starts the pass in the background and returns at once (for hooks).
  --once is accepted for clarity; a pass is always one pass.`,
  spec: { values: [], switches: ["--once", "--detach"] },
  async run(ctx) {
    if (ctx.args.positional.length > 0)
      throw new UsageError(`unexpected argument ${ctx.args.positional[0]}`);
    if (ctx.args.switches.has("--detach")) {
      ctx.runtime.detach([
        "sync",
        "--once",
        ...(ctx.repo ? ["--repo", ctx.repo] : []),
      ]);
      print(ctx, { detached: true }, "");
      return 0;
    }
    const ports = ctx.runtime.ports();
    const { here } = await locate(ctx, ports);
    const report = await runSync(ports, here);
    const failed = report.jobs.filter((j) => j.outcome === "failed");
    const text = [
      ...failed.map((j) => `crew-net sync: ${j.job} failed: ${j.error}`),
      ...(report.notice ? [report.notice] : []),
    ];
    print(ctx, report, text.length ? `${text.join("\n")}\n` : "");
    return failed.length > 0 ? 1 : 0;
  },
};
