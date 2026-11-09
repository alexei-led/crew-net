import { GLOBAL_FLAGS, mergeFlags, parseArgs, UsageError } from "./args";
import type { Command, Io, Runtime } from "./command";
import { COMMANDS } from "./commands/index";

/** Run when the first word is a flag or missing: the digest, once it exists. */
export const DEFAULT_COMMAND = "digest";
export const VERSION = "0.2.0";

export function usage(commands: readonly Command[]): string {
  const lines = commands.map((c) => `  ${c.name.padEnd(10)} ${c.summary}`);
  return [
    "Usage: crew-net <command> [--json] [--repo owner/repo] [args]",
    "",
    "Commands:",
    ...lines,
    "",
    "Run `crew-net <command> --help` for a command's flags.",
    "",
  ].join("\n");
}

/** Run one CLI invocation. Returns the exit code; never throws. */
export async function main(
  argv: readonly string[],
  runtime: Runtime,
  io: Io,
  commands: readonly Command[] = COMMANDS,
): Promise<number> {
  const first = argv[0];
  if (first === "--version") {
    io.out(`${VERSION}\n`);
    return 0;
  }
  if (first === "--help" || first === "help") {
    io.out(usage(commands));
    return 0;
  }
  const named = first !== undefined && !first.startsWith("-");
  const name = named ? first : DEFAULT_COMMAND;
  const rest = named ? argv.slice(1) : argv;
  const command = commands.find((c) => c.name === name);
  if (!command) {
    io.err(`crew-net: unknown command ${name}\n\n${usage(commands)}`);
    return 2;
  }
  try {
    const args = parseArgs(rest, mergeFlags(GLOBAL_FLAGS, command.spec));
    if (args.switches.has("--help")) {
      io.out(`${command.usage}\n`);
      return 0;
    }
    const repos = args.values.get("--repo") ?? [];
    if (repos.length > 1) throw new UsageError("--repo given more than once");
    return await command.run({
      args,
      json: args.switches.has("--json"),
      repo: repos[0],
      runtime,
      io,
    });
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`crew-net ${name}: ${error.message}\n${command.usage}\n`);
      return 2;
    }
    io.err(`crew-net ${name}: ${errorText(error)}\n`);
    return 1;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
