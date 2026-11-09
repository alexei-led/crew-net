import type { Command } from "../command";
import { digest } from "./digest";
import { doctor } from "./doctor";
import { inbox } from "./inbox";
import { session } from "./session";
import { stats } from "./stats";
import { sync } from "./sync";
import { watch } from "./watch";
import { who } from "./who";

/**
 * Every command the CLI runs. Each command lives in its own file and is added
 * here; `main` finds it by name. Flags are declared on the command (`spec`):
 * the global `--json`, `--repo` and `--help` are added by `main`.
 */
export const COMMANDS: readonly Command[] = [
  digest,
  who,
  inbox,
  stats,
  doctor,
  sync,
  session,
  watch,
];
