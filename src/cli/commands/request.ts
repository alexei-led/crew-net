import {
  renderSend,
  request as requestCmd,
} from "../../app/commands/write/index";
import { single, UsageError } from "../args";
import type { Command } from "../command";
import { leadOnly, runWrite, textArg } from "./write-context";

export const request: Command = {
  name: "request",
  summary: "Post a request for work; tracked until accepted, declined or done",
  usage:
    'Usage: crew-net request <@login|#N|owner/repo#N|URL> review|fix|bug [--on #N] "<text>"\n  bug with @login and no --on opens an Issue',
  spec: { values: ["--on"], switches: [] },
  run(ctx) {
    leadOnly();
    const [target, kind, ...text] = ctx.args.positional;
    if (target === undefined || kind === undefined)
      throw new UsageError("who and what to request are missing");
    const on = single(ctx.args, "--on");
    return runWrite(
      ctx,
      (w) =>
        requestCmd(w, {
          target,
          kind,
          text: textArg(text, "the request"),
          ...(on === undefined ? {} : { on }),
        }),
      renderSend,
    );
  },
};
