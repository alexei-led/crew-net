import { inboxView, itemsContext, renderInbox } from "../../app/views";
import { deliverTo } from "../../app/watch";
import { single, UsageError } from "../args";
import type { Command } from "../command";
import { print } from "./shared";

export const inbox: Command = {
  name: "inbox",
  summary: "Unread items and open requests, both directions",
  usage: `Usage: crew-net inbox [--json]
       crew-net inbox --session <id> --claim [--format text|context] [--json]
  --claim routes the unclaimed items, claims the ones that go to this
  session and prints only those (empty when nothing is new). For the
  UserPromptSubmit hook: --format context frames them as information.`,
  spec: { values: ["--session", "--format"], switches: ["--claim"] },
  async run(ctx) {
    if (ctx.args.positional.length > 0)
      throw new UsageError(`unexpected argument ${ctx.args.positional[0]}`);
    const ports = ctx.runtime.ports();
    const session = single(ctx.args, "--session");
    const format = single(ctx.args, "--format") ?? "text";
    if (format !== "text" && format !== "context")
      throw new UsageError("--format must be text or context");
    if (!ctx.args.switches.has("--claim")) {
      if (session !== undefined || format !== "text")
        throw new UsageError("--session and --format need --claim");
      const view = await inboxView(ports.store, ports.clock.now(), ctx.repo);
      print(ctx, view, renderInbox(view));
      return 0;
    }
    if (!session) throw new UsageError("--claim needs --session");
    const items = await deliverTo(ports, session, { replayMs: 0 });
    print(ctx, items, itemsContext(items));
    return 0;
  },
};
