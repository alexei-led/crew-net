import { init as initCmd, renderInit } from "../../app/commands/write/index";
import { UsageError } from "../args";
import type { Command } from "../command";
import { KIT } from "./kit";
import { runWrite } from "./write-context";

export const init: Command = {
  name: "init",
  summary: "Write the optional repo files for review. Never commits or pushes",
  usage:
    "Usage: crew-net init [--deps] [--force]\n  --deps   also the crew-deps workflows and script (a required check)\n  --force  replace files that exist",
  spec: { values: [], switches: ["--deps", "--force"] },
  run(ctx) {
    if (ctx.args.positional.length)
      throw new UsageError(`unexpected ${ctx.args.positional.join(" ")}`);
    return runWrite(
      ctx,
      (w) =>
        initCmd(w, {
          kit: KIT,
          deps: ctx.args.switches.has("--deps"),
          force: ctx.args.switches.has("--force"),
        }),
      renderInit,
    );
  },
};
