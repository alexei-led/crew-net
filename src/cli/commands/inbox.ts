import { inboxView, renderInbox } from "../../app/views";
import { UsageError } from "../args";
import type { Command } from "../command";
import { print } from "./shared";

export const inbox: Command = {
  name: "inbox",
  summary: "Unread items and open requests, both directions",
  usage: "Usage: crew-net inbox [--json]",
  spec: { values: [], switches: [] },
  async run(ctx) {
    if (ctx.args.positional.length > 0)
      throw new UsageError(`unexpected argument ${ctx.args.positional[0]}`);
    const ports = ctx.runtime.ports();
    const view = await inboxView(ports.store, ports.clock.now());
    print(ctx, view, renderInbox(view));
    return 0;
  },
};
