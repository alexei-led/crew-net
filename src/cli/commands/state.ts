import { renderState, state as stateCmd } from "../../app/commands/write/index";
import { single, UsageError } from "../args";
import type { Command } from "../command";
import { runWrite } from "./write-context";

export const state: Command = {
  name: "state",
  summary: "Update the state block on the current branch's PR",
  usage:
    "Usage: crew-net state <planning|building|review|blocked> [--scope p…] [--pr #N]\n  --scope p  repeatable or comma-separated; replaces the scope\n  --pr #N    one of your other open PRs",
  spec: { values: ["--scope", "--pr"], switches: [] },
  run(ctx) {
    const [value, ...rest] = ctx.args.positional;
    if (value === undefined) throw new UsageError("the state is missing");
    // `--scope a/ b/`: the shell leaves the extra paths as positionals.
    const given = ctx.args.values.get("--scope");
    const scope =
      given === undefined
        ? undefined
        : [...given, ...rest].flatMap((p) => p.split(","));
    if (given === undefined && rest.length)
      throw new UsageError(`unexpected ${rest.join(" ")}`);
    const pr = single(ctx.args, "--pr");
    return runWrite(
      ctx,
      (w) =>
        stateCmd(w, {
          state: value,
          ...(scope === undefined ? {} : { scope }),
          ...(pr === undefined ? {} : { pr }),
        }),
      renderState,
    );
  },
};
