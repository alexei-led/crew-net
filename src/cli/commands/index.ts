import type { Command } from "../command";
import { ask } from "./ask";
import { dep } from "./dep";
import { digest } from "./digest";
import { doctor } from "./doctor";
import { gate } from "./gate";
import { inbox } from "./inbox";
import { init } from "./init";
import { reply } from "./reply";
import { request } from "./request";
import { session } from "./session";
import { state } from "./state";
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
  ask,
  request,
  reply,
  state,
  dep,
  gate,
  init,
];
