import type { Command } from "../command";

/**
 * Every command the CLI runs. Each command lives in its own file and is added
 * here; `main` finds it by name. Flags are declared on the command (`spec`):
 * the global `--json`, `--repo` and `--help` are added by `main`.
 */
export const COMMANDS: readonly Command[] = [];
