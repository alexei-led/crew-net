import { dep as depCmd, renderState } from "../../app/commands/write/index";
import { single, UsageError } from "../args";
import type { Command } from "../command";
import { runWrite } from "./write-context";

export const dep: Command = {
  name: "dep",
  summary: "Declare or drop a dependency of the current PR",
  usage:
    "Usage: crew-net dep add|rm <#N|owner/repo#N|URL> [--pr #N]\n  add turns auto-merge off while the dependency is open",
  spec: { values: ["--pr"], switches: [] },
  run(ctx) {
    const [action, ref, ...extra] = ctx.args.positional;
    if (action === undefined || ref === undefined || extra.length)
      throw new UsageError("expected add|rm and one PR ref");
    const pr = single(ctx.args, "--pr");
    return runWrite(
      ctx,
      (w) => depCmd(w, { action, ref, ...(pr === undefined ? {} : { pr }) }),
      renderState,
    );
  },
};
