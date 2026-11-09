import { buildDigest, contextText } from "../../app/digest";
import { runSync } from "../../app/sync";
import { single, UsageError } from "../args";
import type { Command } from "../command";
import { locate, print } from "./shared";

const FORMATS = ["text", "context"];

export const digest: Command = {
  name: "digest",
  summary: "Digest for the current repo (the default command)",
  usage: `Usage: crew-net [digest] [--refresh] [--format text|context] [--json] [--repo owner/repo]
  Reads the local store only. Stale data starts a sync in the background
  ("refreshing"); --refresh waits for one sync first. --format context frames
  the digest for a hook's additional context.`,
  spec: { values: ["--format"], switches: ["--refresh"] },
  async run(ctx) {
    const format = single(ctx.args, "--format") ?? "text";
    if (!FORMATS.includes(format))
      throw new UsageError("--format must be text or context");
    if (ctx.args.positional.length > 0)
      throw new UsageError(`unexpected argument ${ctx.args.positional[0]}`);
    const ports = ctx.runtime.ports();
    const { here, branch } = await locate(ctx, ports);
    if (!here) {
      if (format === "context") return 0;
      ctx.io.err(
        "crew-net: not in a working copy with a GitHub origin; pass --repo owner/repo\n",
      );
      return 1;
    }
    const refresh = ctx.args.switches.has("--refresh");
    if (refresh) await runSync(ports, here);
    const view = await buildDigest(ports, here.ref, branch);
    const refreshing = view.stale && !refresh;
    if (refreshing) {
      ctx.runtime.detach([
        "sync",
        "--once",
        ...(ctx.repo ? ["--repo", ctx.repo] : []),
      ]);
    }
    const note = refreshing ? "crew-net: refreshing in the background\n" : "";
    const text =
      format === "context"
        ? contextText(view)
        : `${view.text.trimEnd()}\n${view.notice ? `${view.notice}\n` : ""}${note}`;
    print(ctx, { ...view, refreshing }, text);
    return 0;
  },
};
