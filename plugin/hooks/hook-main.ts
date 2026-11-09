// Entry point of hooks/dist/hook.js: `node hook.js <event>` with the hook
// payload on stdin. Bundled with hook.ts and the core rules it uses.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOOK_EVENTS,
  type HookEvent,
  handleSafely,
  nodeCli,
  parseInput,
  processInfo,
  sessionPidFrom,
} from "./hook";

const event = process.argv[2];
if (!HOOK_EVENTS.some((e) => e === event)) {
  process.stderr.write(`crew-net hook: unknown event ${event}\n`);
} else {
  let raw = "";
  try {
    raw = readFileSync(0, "utf8");
  } catch {
    // No stdin: an empty payload.
  }
  // The bundle sits in <plugin>/hooks/dist; the CLI in <plugin>/bin.
  const here = dirname(fileURLToPath(import.meta.url));
  const out = handleSafely(event as HookEvent, parseInput(raw), {
    cli: nodeCli(join(here, "..", "..", "bin", "crew-net")),
    role: process.env.CREW_NET_ROLE,
    sessionPid: () => sessionPidFrom(process.ppid, processInfo),
  });
  if (out !== null) process.stdout.write(`${JSON.stringify(out)}\n`);
}
