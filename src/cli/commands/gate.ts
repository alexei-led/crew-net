import {
  type GateResult,
  gate as gateCmd,
  gateExitCode,
  mayMerge,
  renderGate,
} from "../../app/commands/write/index";
import { UsageError } from "../args";
import type { Command, CommandContext } from "../command";
import { writeContext } from "./write-context";

async function decide(
  ctx: CommandContext,
  argv: readonly string[],
): Promise<GateResult> {
  // Detection needs no repo, token or network. Without aliases an unknown
  // gh command counts as a merge, so this answers "none" only when it is.
  if (!mayMerge(argv))
    return { decision: "allow", reasons: [], checked: [], failed: false };
  // gh aliases are local: read them so `gh m` is checked as what it runs.
  const aliases = await Promise.resolve()
    .then(() => ctx.runtime.ports().env.ghAliases())
    .catch(() => undefined);
  if (!mayMerge(argv, aliases))
    return { decision: "allow", reasons: [], checked: [], failed: false };
  try {
    return await gateCmd(await writeContext(ctx), {
      argv,
      ...(aliases ? { aliases } : {}),
    });
  } catch (error) {
    // No repo or no token: still an answer, and the answer is deny.
    return {
      decision: "deny",
      reasons: [
        `crew-net gate: ${(error as Error).message}; denied (fail closed)`,
      ],
      checked: [],
      failed: true,
    };
  }
}

export const gate: Command = {
  name: "gate",
  summary: "May this command merge now? Checks depends-on live (fail closed)",
  usage:
    "Usage: crew-net gate [--json] -- <command>\n  The Bash command as one argument or as its words. Exit 0 with allow or\n  deny; exit 1 when the gate itself failed (the answer is then deny).",
  spec: { values: [], switches: [] },
  async run(ctx) {
    const argv = ctx.args.positional;
    if (argv.length === 0) throw new UsageError("the command is missing");
    const result = await decide(ctx, argv);
    ctx.io.out(
      ctx.json ? `${JSON.stringify(result)}\n` : `${renderGate(result)}\n`,
    );
    return gateExitCode(result);
  },
};
