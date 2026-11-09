import { ask as askCmd, renderSend } from "../../app/commands/write/index";
import { single, UsageError } from "../args";
import type { Command } from "../command";
import { leadOnly, runWrite, textArg } from "./write-context";

export const ask: Command = {
  name: "ask",
  summary: "Post a question; tracked until answered",
  usage:
    'Usage: crew-net ask <@login|#N|owner/repo#N|URL> [--on #N] "<text>"\n  --on #N  with @login: the PR or Issue to ask on',
  spec: { values: ["--on"], switches: [] },
  run(ctx) {
    leadOnly();
    const [target, ...text] = ctx.args.positional;
    if (target === undefined) throw new UsageError("who to ask is missing");
    const on = single(ctx.args, "--on");
    return runWrite(
      ctx,
      (w) =>
        askCmd(w, {
          target,
          text: textArg(text, "the question"),
          ...(on === undefined ? {} : { on }),
        }),
      renderSend,
    );
  },
};
