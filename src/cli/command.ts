import type { AppPorts } from "../app/ports";
import type { FlagSpec, Parsed } from "./args";

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export interface Runtime {
  /** Directory the command runs in; the repo the digest and gates read by default. */
  cwd: string;
  now(): number;
  /** Built on first use, so `--help` and `--version` touch no disk. */
  ports(): AppPorts;
  /** Start `crew-net <args>` in the background and return at once (hooks never wait). */
  detach(args: readonly string[]): void;
}

export interface CommandContext {
  args: Parsed;
  /** `--json`: print one JSON document instead of text. */
  json: boolean;
  /** `--repo owner/repo`, when given. */
  repo: string | undefined;
  runtime: Runtime;
  io: Io;
}

export interface Command {
  name: string;
  summary: string;
  usage: string;
  spec: FlagSpec;
  /** Resolves to the exit code: 0 ok, 1 failed. Usage errors are thrown as UsageError. */
  run(ctx: CommandContext): Promise<number>;
}
