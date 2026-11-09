import { renderReply, reply as replyCmd } from "../../app/commands/write/index";
import type { ReplyStatus } from "../../protocol/index";
import { UsageError } from "../args";
import type { Command } from "../command";
import { runWrite, textArg } from "./write-context";

const STATUS_FLAGS: Record<string, ReplyStatus> = {
  "--done": "done",
  "--decline": "declined",
  "--accept": "accepted",
};

export const reply: Command = {
  name: "reply",
  summary: "Answer an inbox item",
  usage:
    'Usage: crew-net reply <item> [--done|--decline|--accept] "<text>"\n  Without a flag the reply is "answered".',
  spec: { values: [], switches: Object.keys(STATUS_FLAGS) },
  run(ctx) {
    const [item, ...text] = ctx.args.positional;
    if (item === undefined) throw new UsageError("the item id is missing");
    const flags = Object.keys(STATUS_FLAGS).filter((f) =>
      ctx.args.switches.has(f),
    );
    if (flags.length > 1)
      throw new UsageError(`pick one of ${flags.join(", ")}`);
    const status = flags[0] === undefined ? undefined : STATUS_FLAGS[flags[0]];
    return runWrite(
      ctx,
      (w) =>
        replyCmd(w, {
          item,
          text: textArg(text, "the reply"),
          ...(status === undefined ? {} : { status }),
        }),
      renderReply,
    );
  },
};
